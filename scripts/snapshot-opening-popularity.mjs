#!/usr/bin/env node
/**
 * Build a committed, offline line-popularity snapshot from the public
 * Lichess Opening Explorer.
 *
 * This is intentionally NOT part of `npm run build`: it performs thousands
 * of network requests and should only run when refreshing opening data.
 * Responses are cached under `.cache/` so interrupted runs resume cheaply.
 * By default it measures branches through six plies; deeper named lines
 * inherit that branch reach with a documented decay. This keeps refreshes
 * respectful of the upstream service while still ranking the lines players
 * encounter first.
 *
 * Usage:
 *   node scripts/snapshot-opening-popularity.mjs
 *   node scripts/snapshot-opening-popularity.mjs --concurrency=2 --delay=500
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

const args = new Map(
  process.argv.slice(2).map((arg) => {
    const [key, value = 'true'] = arg.replace(/^--/, '').split('=');
    return [key, value];
  }),
);
const concurrency = Math.max(1, Number(args.get('concurrency') ?? 4));
const delayMs = Math.max(0, Number(args.get('delay') ?? 250));
const maxRequests = Math.max(0, Number(args.get('max') ?? Infinity));
const snapshotDepth = Math.max(0, Number(args.get('depth') ?? 6));
const allowPartial = args.get('allow-partial') === 'true';

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
  const temp = `${path}.tmp`;
  writeFileSync(temp, text);
  renameSync(temp, path);
}

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

async function fetchWithRetry(parentMoves, attempt = 0) {
  const response = await fetch(explorerUrl(parentMoves), {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'chess-coach-opening-snapshot/1.0',
      ...(LICHESS_TOKEN ? { Authorization: `Bearer ${LICHESS_TOKEN}` } : {}),
    },
  });
  if (response.ok) {
    const body = await response.json();
    return body.data ?? body;
  }
  if ((response.status === 429 || response.status >= 500) && attempt < 6) {
    const retryAfter = Number(response.headers.get('retry-after') ?? 0) * 1000;
    await sleep(Math.max(retryAfter, 1000 * 2 ** attempt));
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
    `# measuredParentDepth=${snapshotDepth}; deeper lines use documented 0.82-per-ply decay`,
    'uci\tglobalGames\tglobalShare',
  ];
  return `${header.concat(rows.map((row) => `${row.key}\t${row.games}\t${row.share.toFixed(8)}`)).join('\n')}\n`;
}

async function main() {
  const lines = loadLines();
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
      if (completed % 25 === 0 || completed === missing.length) {
        persistCache(cache);
        console.log(`Fetched ${completed}/${missing.length}`);
      }
      await sleep(delayMs);
    }
  });
  await Promise.all(workers);
  persistCache(cache);

  const stillMissing = [...parents.keys()].filter((key) => !cache[key]);
  if (stillMissing.length > 0) {
    console.log(`Cache updated; ${stillMissing.length} parents remain.`);
    if (!allowPartial) {
      console.log('Re-run to finish, or pass --allow-partial=true to use nearest cached ancestors.');
      return;
    }
  }

  writeAtomic(OUT_FILE, snapshotTsv(lines, cache));
  console.log(`Wrote ${OUT_FILE}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
