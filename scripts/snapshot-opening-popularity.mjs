#!/usr/bin/env node
/**
 * Build a committed, offline line-popularity snapshot from the public
 * Lichess Opening Explorer.
 *
 * This is intentionally NOT part of `npm run build`: it performs thousands
 * of network requests and should only run when refreshing opening data.
 * Responses are cached under `.cache/` so interrupted runs resume cheaply.
 * By default it measures every line at full depth (one request per unique
 * parent position, ~2300 total). Passing `--depth=N` caps the measured
 * depth and lets deeper named lines inherit their branch reach with a
 * documented 0.82-per-ply decay — useful for a quick, gentle partial
 * refresh, but the committed data is built at full depth so that rarity
 * is a real measurement rather than a function of depth.
 *
 * The upstream proxy rate-limits bursts, so a full run may need several
 * resumes; each is cheap because the cache persists every 10 responses.
 *
 * Exit codes are a contract with the resume loop in
 * `.github/workflows/openings-refresh.yml` — do not repurpose them:
 *   0  the TSV was written (the cache covered every parent, or
 *      --allow-partial=true was passed)
 *   3  the cache is still incomplete, nothing written; progress banked,
 *      re-run to continue
 *   1  hard failure (bad arguments, unusable upstream, I/O error)
 * The workflow used to infer completion from `git diff` on the output
 * file, which conflates "incomplete" with "complete but unchanged"; an
 * explicit signal from the only process that knows is unambiguous.
 *
 * Usage:
 *   node scripts/snapshot-opening-popularity.mjs
 *   node scripts/snapshot-opening-popularity.mjs --concurrency=2 --delay=500
 *   node scripts/snapshot-opening-popularity.mjs --depth=6   # quick partial
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Chess } from 'chess.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DATA_DIR = join(ROOT, 'data', 'openings');
const OUT_FILE = join(DATA_DIR, 'line-popularity.tsv');
const CACHE_FILE = join(ROOT, '.cache', 'opening-popularity-explorer.json');
const LICHESS_TOKEN = process.env.LICHESS_TOKEN?.trim();
const DIRECT_EXPLORER = 'https://explorer.lichess.org/lichess';
const CACHED_EXPLORER = 'https://chess-analysis.org/api/explore/lichess';
const EXPLORER = process.env.OPENING_EXPLORER_URL?.trim()
  || (LICHESS_TOKEN ? DIRECT_EXPLORER : CACHED_EXPLORER);
const FILTERS = {
  variant: 'standard',
  speeds: 'blitz,rapid,classical',
  ratings: '1200,1400,1600,1800,2000,2200,2500',
};

// Exit code that tells the workflow "cache incomplete, run me again".
const EXIT_INCOMPLETE = 3;

const args = new Map(
  process.argv.slice(2).map((arg) => {
    const [key, value = 'true'] = arg.replace(/^--/, '').split('=');
    return [key, value];
  }),
);

/**
 * Read a numeric flag, or die with a message pointing at the mistake.
 *
 * Coercing instead of validating gave a typo the worst possible failure
 * mode: `--depth 40` (a space instead of `=`) parses as `{depth: 'true'}`
 * plus a stray `{40: 'true'}`, and `Number('true')` is NaN. `Math.min(len
 * - 1, NaN)` is NaN, so `uci.slice(0, NaN)` is the empty prefix — every
 * line measured from the STARTING position, every row a decay estimate off
 * the opening move. The TSV that falls out is well-formed and plausible,
 * carries no trace of the mistake, and nothing downstream can tell it
 * apart from a real measurement. A bad flag has to be loud.
 *
 * Absent flags return `fallback` unvalidated so `Infinity` defaults stay
 * legal; an explicitly passed value must be finite (or Infinity where the
 * flag genuinely means "unbounded").
 */
function numericArg(name, fallback, { min = 0, allowInfinite = false } = {}) {
  const raw = args.get(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  const usable = Number.isFinite(value) || (allowInfinite && value === Infinity);
  if (!usable || value < min) {
    console.error(
      `Invalid --${name}=${raw}: expected a number >= ${min}` +
        `${allowInfinite ? ' (or Infinity)' : ''}.` +
        // `raw === 'true'` means the flag arrived with no `=`, i.e. the
        // value is sitting in argv as a separate token.
        (raw === 'true'
          ? ` Attach the value with "=": --${name}=<number>, not --${name} <number>.`
          : ''),
    );
    process.exit(1);
  }
  return value;
}

const concurrency = numericArg('concurrency', 4, { min: 1 });
const delayMs = numericArg('delay', 250, { min: 0 });
const maxRequests = numericArg('max', Infinity, { min: 0, allowInfinite: true });
// Full depth by default: measure every line's own branch rather than
// estimating deep lines from a shallow parent. The default is Infinity,
// not a constant, because "full" is a property of the DATA — the previous
// default of 40 was reverse-engineered from today's longest line (36 ply)
// and would silently become a truncating cap the day someone adds a
// 42-ply variation. `--depth=N` still caps it for a quick, gentle partial
// refresh (and only then does the 0.82-per-ply decay below apply); main()
// warns when the cap is shallower than the deepest line. Full measurement
// is what lets difficulty scoring treat depth and rarity as independent
// signals instead of double-counting depth through a depth-derived
// estimate.
const snapshotDepth = numericArg('depth', Infinity, { min: 0, allowInfinite: true });
const allowPartial = args.get('allow-partial') === 'true';

// An unrecognized flag is nearly always the orphaned half of a
// space-separated pair (`--depth 40` leaves a bare `40`) or a spelling
// like `--allowPartial`, both of which would otherwise run to completion
// with settings the caller never asked for.
const KNOWN_ARGS = new Set(['concurrency', 'delay', 'max', 'depth', 'allow-partial']);
for (const key of args.keys()) {
  if (!KNOWN_ARGS.has(key)) {
    console.error(
      `Unknown argument --${key}. Known flags: ` +
        `${[...KNOWN_ARGS].map((flag) => `--${flag}=…`).join(' ')}.`,
    );
    process.exit(1);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseOpeningTsv(text) {
  const [, ...rows] = text.split(/\r?\n/).filter(Boolean);
  return rows.flatMap((row) => {
    const [eco, name, pgn] = row.split('\t');
    return eco && name && pgn ? [{ eco, name, pgn }] : [];
  });
}

function pgnToUci(pgn) {
  try {
    const chess = new Chess();
    chess.loadPgn(pgn);
    return chess
      .history({ verbose: true })
      .map((move) => move.from + move.to + (move.promotion ?? ''));
  } catch {
    return [];
  }
}

function loadLines() {
  const files = readdirSync(DATA_DIR)
    .filter((name) => /^[a-e]\.tsv$/i.test(name))
    .sort();
  return files.flatMap((file) =>
    parseOpeningTsv(readFileSync(join(DATA_DIR, file), 'utf8')).flatMap((row) => {
      const uci = pgnToUci(row.pgn);
      return uci.length > 0 ? [{ ...row, uci }] : [];
    }),
  );
}

function readCache() {
  if (!existsSync(CACHE_FILE)) return {};
  try {
    return JSON.parse(readFileSync(CACHE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeAtomic(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  // The temp name carries the pid so two snapshot processes (a manual
  // resume run alongside the scheduled one, say) can't rename each other's
  // half-written 5 MB temp file over the cache. Writing the temp file is
  // several syscalls, the rename is one: with a shared name the loser
  // publishes the winner's truncated JSON, `readCache()` then swallows the
  // parse error and returns `{}`, and thousands of banked responses are
  // silently refetched from cold.
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, text);
  renameSync(temp, path);
}

// Checkpoint every N responses. Small on purpose: each write is one
// ~5 MB serialize (cheap next to N throttled HTTP round-trips at
// --delay=600), and the number is the upper bound on how much work a
// crash, a 429 ladder giving up, or the job timeout can throw away.
const CHECKPOINT_EVERY = 10;

function persistCache(cache) {
  writeAtomic(CACHE_FILE, `${JSON.stringify(cache)}\n`);
}

function fenAfter(moves) {
  const chess = new Chess();
  for (const uci of moves) {
    chess.move({
      from: uci.slice(0, 2),
      to: uci.slice(2, 4),
      promotion: uci.slice(4, 5) || undefined,
    });
  }
  return chess.fen();
}

function explorerUrl(parentMoves) {
  const params = new URLSearchParams({
    speeds: FILTERS.speeds,
    ratings: FILTERS.ratings,
  });
  if (EXPLORER === DIRECT_EXPLORER) {
    params.set('variant', FILTERS.variant);
    params.set('topGames', '0');
    params.set('recentGames', '0');
    if (parentMoves.length > 0) params.set('play', parentMoves.join(','));
  } else {
    params.set('fen', fenAfter(parentMoves));
  }
  return `${EXPLORER}?${params.toString()}`;
}

// Retry budget by kind of failure. A 429 and a dropped connection both get
// the long ladder: against a shared, rate-limited proxy those are the
// expected steady state, not anomalies. A 5xx or a junk 200 gets the short
// one — that usually means the upstream is genuinely unwell, and holding a
// worker on it only delays the re-run that would fix it.
const MAX_ATTEMPTS = { patient: 10, brief: 6 };
// A stalled socket is worse than a failed request. undici applies no
// default timeout, so without a deadline one hung connection parks a
// worker for the entire job and the resume loop makes no progress at all.
const REQUEST_TIMEOUT_MS = 20_000;
// Retry-After is advice, not an instruction we have to obey literally: a
// sick proxy may say "come back in three hours", and we would rather bank
// progress and let the next run resume than hold a worker that long.
const RETRY_AFTER_CAP_MS = 120_000;

/**
 * `Retry-After` is legally EITHER a delay in seconds or an HTTP-date (RFC
 * 9110 §10.2.3), and `Number('Wed, 21 Oct 2026 07:28:00 GMT')` is NaN.
 * That NaN used to flow straight into `Math.max(retryAfter, backoff)` —
 * also NaN — and `setTimeout(resolve, NaN)` fires on the next tick. So the
 * one header whose whole purpose is "slow down" collapsed the patient
 * backoff ladder into a hot loop hammering the upstream we are trying to
 * be polite to. Accept both forms, ignore anything non-finite or already
 * in the past, and cap what we honour.
 */
function parseRetryAfter(header) {
  if (!header) return 0;
  const seconds = Number(header.trim());
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.min(RETRY_AFTER_CAP_MS, ms);
}

/** Capped exponential backoff, never shorter than a sane Retry-After. */
function retryDelay(attempt, retryAfterMs = 0) {
  const backoff = Math.min(60000, 1000 * 2 ** attempt);
  // Jitter must be RANDOM. A jitter derived from `attempt` is identical
  // for every worker on the same attempt number, and workers that trip
  // the same 429 are on the same attempt number — so they slept the same
  // amount, woke together, and re-formed the exact burst that jitter
  // exists to break up.
  const jitter = Math.floor(backoff * 0.25 * Math.random());
  return Math.max(retryAfterMs, backoff + jitter);
}

/**
 * A 200 is not a success. The default upstream is a hobby proxy in front
 * of Lichess, and an unhealthy one answers 200 with `{}` or `{"error":
 * "..."}`. The old `body.data ?? body` accepted that, the cache banked it
 * as a good response, and every line under that parent reported 0 games —
 * a TSV of plausible zeros indistinguishable from "nobody plays this
 * line", published by a green job. Require the fields we actually read
 * before trusting (or caching) a body.
 */
function isExplorerPayload(payload) {
  return (
    !!payload
    && typeof payload === 'object'
    && Array.isArray(payload.moves)
    && Number.isFinite(payload.white)
    && Number.isFinite(payload.draws)
    && Number.isFinite(payload.black)
  );
}

async function fetchWithRetry(parentMoves, attempt = 0) {
  let response;
  try {
    response = await fetch(explorerUrl(parentMoves), {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'chess-coach-opening-snapshot/1.0',
        ...(LICHESS_TOKEN ? { Authorization: `Bearer ${LICHESS_TOKEN}` } : {}),
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    // A transport failure (ECONNRESET, a DNS blip, undici's opaque "fetch
    // failed", or our own timeout above) is exactly as transient as a 429
    // or a 502 — it just arrives as a thrown exception instead of a status
    // code. Unhandled, it killed the worker, rejected Promise.all, and
    // abandoned the whole attempt over one dropped connection. Same
    // ladder, same patience.
    if (attempt < MAX_ATTEMPTS.patient) {
      console.warn(`Request failed (${error?.message ?? error}); retry ${attempt + 1}.`);
      await sleep(retryDelay(attempt));
      return fetchWithRetry(parentMoves, attempt + 1);
    }
    throw new Error(
      `Explorer request failed after ${attempt + 1} attempts: ${error?.message ?? error}`,
      { cause: error },
    );
  }
  if (response.ok) {
    // `.json()` itself throws on a truncated or HTML body (a proxy error
    // page served as 200), which is the same class of problem as a
    // well-formed but empty payload: treat both as retryable rather than
    // caching junk or crashing the worker.
    const payload = await response.json().then((body) => body?.data ?? body, () => null);
    if (isExplorerPayload(payload)) return payload;
    if (attempt < MAX_ATTEMPTS.brief) {
      console.warn(`Explorer 200 with an unusable body; retry ${attempt + 1}.`);
      await sleep(retryDelay(attempt));
      return fetchWithRetry(parentMoves, attempt + 1);
    }
    throw new Error(
      `Explorer returned 200 with an unusable body after ${attempt + 1} attempts: ` +
        `${JSON.stringify(payload)?.slice(0, 200)}`,
    );
  }
  // The unauthenticated upstream (chess-analysis.org, used when no
  // LICHESS_TOKEN is set) is a shared proxy that Lichess itself rate
  // limits, so a full-depth refresh reliably trips 429 partway through.
  // Be patient rather than fail the whole run: back off with a capped
  // exponential plus jitter, honour Retry-After when sent, and give 429
  // more attempts than a plain 5xx. The cache persists every 10
  // responses, so even if we ultimately give up, a re-run resumes.
  const maxAttempts = response.status === 429 ? MAX_ATTEMPTS.patient : MAX_ATTEMPTS.brief;
  if ((response.status === 429 || response.status >= 500) && attempt < maxAttempts) {
    await sleep(retryDelay(attempt, parseRetryAfter(response.headers.get('retry-after'))));
    return fetchWithRetry(parentMoves, attempt + 1);
  }
  if (response.status === 401 && !LICHESS_TOKEN) {
    throw new Error(
      'Explorer requires authorization from this environment. Set LICHESS_TOKEN and re-run.',
    );
  }
  throw new Error(`Explorer ${response.status}: ${await response.text()}`);
}

function snapshotTsv(lines, cache) {
  const rows = lines
    .map((line) => {
      const targetParent = line.uci.slice(
        0,
        Math.min(line.uci.length - 1, snapshotDepth),
      );
      let parent = targetParent;
      let response = cache[parent.join(' ')];
      while (!response && parent.length > 0) {
        parent = parent.slice(0, -1);
        response = cache[parent.join(' ')];
      }
      const moveUci = line.uci[parent.length];
      const move = response?.moves?.find((candidate) => candidate.uci === moveUci);
      const branchGames = move ? move.white + move.draws + move.black : 0;
      // Deep named variations share the measured early branch. A small,
      // deterministic decay keeps shallower foundational lines ahead while
      // avoiding thousands of upstream requests for ultra-specific leaves.
      const unmeasuredPlies = Math.max(0, line.uci.length - parent.length - 1);
      const games = Math.round(branchGames * 0.82 ** unmeasuredPlies);
      const parentGames = response
        ? response.white + response.draws + response.black
        : 0;
      const share = parentGames > 0 ? games / parentGames : 0;
      return {
        key: line.uci.join(' '),
        games,
        share,
      };
    })
    .sort((a, b) => a.key.localeCompare(b.key));

  const header = [
    '# Generated by scripts/snapshot-opening-popularity.mjs',
    `# source=${EXPLORER}`,
    `# snapshot=${new Date().toISOString()}`,
    `# variant=${FILTERS.variant}; speeds=${FILTERS.speeds}; ratings=${FILTERS.ratings}`,
    `# measuredParentDepth=${Number.isFinite(snapshotDepth) ? snapshotDepth : 'full'}; deeper lines use documented 0.82-per-ply decay`,
    'uci\tglobalGames\tglobalShare',
  ];
  return `${header.concat(rows.map((row) => `${row.key}\t${row.games}\t${row.share.toFixed(8)}`)).join('\n')}\n`;
}

async function main() {
  const lines = loadLines();

  // A cap shallower than the deepest line silently turns those lines from
  // measurements into decay ESTIMATES, and the resulting TSV is
  // shape-identical to a fully measured one — the same trap `--depth 40`
  // used to fall into by accident. `--depth=6` is a legitimate mode for a
  // quick partial refresh, so this warns rather than fails, but it must
  // never be a surprise to whoever reads the committed data.
  const deepestLine = lines.reduce((max, line) => Math.max(max, line.uci.length), 0);
  const requiredDepth = Math.max(0, deepestLine - 1);
  if (snapshotDepth < requiredDepth) {
    console.warn(
      `WARNING: --depth=${snapshotDepth} is shallower than the deepest bundled line ` +
        `(${deepestLine} ply, which needs depth ${requiredDepth}). Lines beyond the cap ` +
        'will be ESTIMATED with the documented 0.82-per-ply decay, not measured. ' +
        'Omit --depth for a fully measured snapshot.',
    );
  }

  const parents = new Map();
  for (const line of lines) {
    const parent = line.uci.slice(
      0,
      Math.min(line.uci.length - 1, snapshotDepth),
    );
    parents.set(parent.join(' '), parent);
  }

  const cache = readCache();
  const missing = [...parents].filter(([key]) => !cache[key]).slice(0, maxRequests);
  console.log(
    `${lines.length} lines, ${parents.size} unique parents, ${missing.length} requests remaining`,
  );

  let cursor = 0;
  let completed = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (cursor < missing.length) {
      const index = cursor++;
      const [key, parent] = missing[index];
      cache[key] = await fetchWithRetry(parent);
      completed++;
      if (completed % CHECKPOINT_EVERY === 0 || completed === missing.length) {
        persistCache(cache);
        console.log(`Fetched ${completed}/${missing.length}`);
      }
      await sleep(delayMs);
    }
  });
  try {
    await Promise.all(workers);
  } finally {
    // Always bank what we fetched. Promise.all rejects the instant ONE
    // worker throws, so the persist that used to live after it was skipped
    // in exactly the case where it mattered most: an attempt that died
    // after 24 good responses wrote nothing at all (the checkpoint had not
    // come round yet) and the next attempt refetched all 24 — the resume
    // design quietly not resuming. With the finally plus the smaller
    // checkpoint interval, a failed, killed, or timed-out attempt loses at
    // most a handful of responses.
    persistCache(cache);
  }

  const stillMissing = [...parents.keys()].filter((key) => !cache[key]);
  if (stillMissing.length > 0 && !allowPartial) {
    // Deliberately NOT writing the TSV: a snapshot built off a partial
    // cache substitutes nearest-ancestor estimates for measurements, and
    // once committed nothing downstream can tell the difference. Exit 3 is
    // the workflow's cue to loop again against the now-larger cache.
    console.log(`Cache updated; ${stillMissing.length} parents remain uncached.`);
    console.log('Re-run to finish, or pass --allow-partial=true to use nearest cached ancestors.');
    console.log(`Incomplete: ${OUT_FILE} left untouched (exit ${EXIT_INCOMPLETE}).`);
    process.exitCode = EXIT_INCOMPLETE;
    return;
  }
  if (stillMissing.length > 0) {
    console.log(
      `Cache updated; ${stillMissing.length} parents remain — writing anyway ` +
        '(--allow-partial=true), estimating them from their nearest cached ancestors.',
    );
  }

  writeAtomic(OUT_FILE, snapshotTsv(lines, cache));
  console.log(`Wrote ${OUT_FILE}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
