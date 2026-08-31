#!/usr/bin/env node
// Build-time pipeline for the bundled puzzle library.
//
// Reads the Lichess open puzzle database (CC0) and emits:
//   - public/puzzles/<buildId>/b<band>-<n>.tsv   sharded puzzle rows
//   - src/data/puzzles.meta.generated.ts         manifest + theme vocabulary
//
// Re-run to refresh the dataset:
//   npm run puzzles:build
//
// Source: https://database.lichess.org/#puzzles (CC0 1.0 Universal).
//
// ---------------------------------------------------------------------------
// Why the output is static files, not a generated .ts module
// ---------------------------------------------------------------------------
// `build-openings.mjs` compiles its dataset straight into a .ts module because
// the openings bundle is ~650 KB. The puzzle corpus is ~20 MB: importing that
// as a module would land it in the main JS bundle and wreck first paint. So
// puzzles ship as static assets fetched on demand, the same delivery model as
// `public/stockfish/*`. Only the small manifest is a .ts module.
//
// ---------------------------------------------------------------------------
// The Moves[0] trap
// ---------------------------------------------------------------------------
// In the Lichess CSV, `FEN` is the position BEFORE the opponent plays into the
// puzzle, and `Moves[0]` is that opponent move — NOT the solver's. The solver's
// first move is `Moves[1]`. Example row:
//
//   FEN   r6k/pp2r2p/4Rp1Q/3p4/8/1N1P2R1/PqP2bPP/7K b - - 0 24   (black to move)
//   Moves f2g3 e6e7 b2b1 b3c1 b1c1 h6c1
//           ^^^^ white's move into the puzzle
//                ^^^^ the solver's (black's) first move
//
// We resolve this at build time: apply Moves[0], store the resulting position
// as `fen`, and store Moves[1..] as the solution. That way the runtime never
// has to know the convention (and never has to touch chess.js to set up a
// puzzle) — same principle as build-openings converting PGN to UCI up front.
// Getting it backwards yields a corpus where every puzzle is off by one ply
// and unsolvable, so `scripts/build-puzzles.fixture.test.ts` pins it.

import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Chess } from 'chess.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

export const SOURCE_URL = 'https://database.lichess.org/lichess_db_puzzle.csv.zst';
/** Cached download. `.cache/` is gitignored; delete the file to re-fetch. */
export const CACHE_FILE = join(ROOT, '.cache', 'lichess_db_puzzle.csv.zst');
export const PUZZLE_ASSET_DIR = join(ROOT, 'public', 'puzzles');
export const META_FILE = join(ROOT, 'src', 'data', 'puzzles.meta.generated.ts');

export const GENERATED_TIMESTAMP_PREFIX = '// Generated ';

/* =======================================================================
 *  Tunable selection parameters
 * =======================================================================
 *
 *  These four constants decide the size and shape of the shipped corpus.
 *  They are the knob to turn if ~20 MB of committed TSV is too much (lower
 *  PER_BAND_CAP) or if a tier feels thin (raise it).
 */

/** Rating bands are 100 points wide across this range. Puzzles outside it
 *  are dropped: below 400 they're trivial, above 3000 they're a handful of
 *  studies with unstable ratings. */
export const RATING_MIN = 400;
export const RATING_MAX = 3000;
export const BAND_WIDTH = 100;

/** Max puzzles kept per 100-point band, highest `NbPlays` first.
 *
 *  Capping PER BAND rather than globally is the whole trick. Lichess puzzle
 *  ratings cluster hard around 1500, so a global "top 200k by NbPlays" would
 *  be almost entirely mid-rated — the Easy and Hard tabs would be starved.
 *  A per-band cap guarantees every tier has deep inventory. */
export const PER_BAND_CAP = 8000;

/** Rows per shard file. ~4k rows ≈ 360 KB raw, ≈ 140 KB gzipped on the
 *  wire, which is a reasonable unit of lazy fetch. */
export const SHARD_ROWS = 4000;

/** Quality gate. `NbPlays` and `Popularity` drop puzzles the Lichess
 *  community hasn't vetted or actively dislikes; `RatingDeviation` drops
 *  puzzles whose difficulty is still a guess, which matters because
 *  difficulty ordering is the primary axis of the whole feature. */
export const MIN_NB_PLAYS = 100;
export const MIN_POPULARITY = 85;
export const MAX_RATING_DEVIATION = 90;

/** Tier boundaries, in rating. Kept here (not in the UI) so the tab labels
 *  can quote real numbers and can never drift from the shards. */
export const TIERS = [
  { id: 'easy', maxExclusive: 1300 },
  { id: 'medium', maxExclusive: 1900 },
  { id: 'hard', maxExclusive: Infinity },
];

/* =======================================================================
 *  CSV parsing
 * =======================================================================
 */

export const CSV_COLUMNS = [
  'PuzzleId',
  'FEN',
  'Moves',
  'Rating',
  'RatingDeviation',
  'Popularity',
  'NbPlays',
  'Themes',
  'GameUrl',
  'OpeningTags',
  'DailyDate',
];

/**
 * Parse one CSV data row.
 *
 * A plain `split(',')` is safe here and deliberately chosen over a real CSV
 * reader: no field in this dataset can contain a comma (FENs, UCI move
 * lists and URLs have none; Themes and OpeningTags are space-separated),
 * and this runs 6 million times. We validate the column count instead of
 * trusting it, so a future format change fails loudly rather than silently
 * shifting every field by one.
 *
 * Returns `null` for rows that are malformed or fail the quality gate.
 */
export function parseCsvRow(line) {
  const c = line.split(',');
  if (c.length !== CSV_COLUMNS.length) return null;

  const rating = Number(c[3]);
  const ratingDeviation = Number(c[4]);
  const popularity = Number(c[5]);
  const nbPlays = Number(c[6]);

  if (!Number.isFinite(rating) || rating < RATING_MIN || rating >= RATING_MAX) {
    return null;
  }
  if (!Number.isFinite(nbPlays) || nbPlays < MIN_NB_PLAYS) return null;
  if (!Number.isFinite(popularity) || popularity < MIN_POPULARITY) return null;
  if (!Number.isFinite(ratingDeviation) || ratingDeviation > MAX_RATING_DEVIATION) {
    return null;
  }

  const id = c[0];
  const fen = c[1];
  const moves = c[2];
  const themes = c[7];
  if (!id || !fen || !moves || !themes) return null;

  return { id, fen, moves, rating, nbPlays, themes, gameUrl: c[8] };
}

/** Band index for a rating. Bands are `BAND_WIDTH` wide from `RATING_MIN`. */
export function bandOf(rating) {
  return Math.floor((rating - RATING_MIN) / BAND_WIDTH);
}

export function bandCount() {
  return Math.ceil((RATING_MAX - RATING_MIN) / BAND_WIDTH);
}

/** Tier id for a rating, from `TIERS`. */
export function tierOf(rating) {
  for (const t of TIERS) if (rating < t.maxExclusive) return t.id;
  return TIERS[TIERS.length - 1].id;
}

/* =======================================================================
 *  Move resolution (the Moves[0] trap)
 * =======================================================================
 */

function uciToMove(uci) {
  return {
    from: uci.slice(0, 2),
    to: uci.slice(2, 4),
    ...(uci.length > 4 ? { promotion: uci[4] } : {}),
  };
}

/**
 * Resolve a raw CSV row into the shape the app actually solves.
 *
 * Applies `Moves[0]` (the opponent's move into the puzzle) to the CSV FEN,
 * then validates that every remaining move is legal from the resulting
 * position. Returns `null` if anything doesn't play out — a corrupt row, or
 * our own misreading of the format. Dropping those keeps the shipped corpus
 * clean by construction rather than by hope.
 *
 * Exported for `build-puzzles.fixture.test.ts`, which runs it over real
 * committed rows and asserts the solver's colour matches the `/black`
 * marker Lichess puts in `GameUrl`.
 */
export function resolvePuzzle(row) {
  const moves = row.moves.split(' ').filter(Boolean);
  // Need the opponent's setup move plus at least one solver move.
  if (moves.length < 2) return null;

  const chess = new Chess();
  try {
    chess.load(row.fen);
  } catch {
    return null;
  }

  // Moves[0] is the opponent's — play it to reach the position the user sees.
  try {
    if (!chess.move(uciToMove(moves[0]))) return null;
  } catch {
    return null;
  }

  const fenToSolve = chess.fen();
  const solverColor = chess.turn() === 'w' ? 'white' : 'black';
  const solution = moves.slice(1);

  // Play the rest out to prove the line is legal end-to-end.
  for (const uci of solution) {
    try {
      if (!chess.move(uciToMove(uci))) return null;
    } catch {
      return null;
    }
  }

  return { fen: fenToSolve, solution, solverColor };
}

/* =======================================================================
 *  Theme encoding
 * =======================================================================
 */

/**
 * Encode theme names as a run of fixed-width 2-char base36 indices into
 * `vocabulary` (e.g. themes at indices 10, 51 → `"0a1f"`).
 *
 * Why not raw strings: the ~60-word theme vocabulary repeats on all ~200k
 * rows, and it's the second-largest column after FEN. Why not a bitmask:
 * 60 bits overflows a JS number, so decoding would need BigInt on every row.
 * Fixed-width base36 keeps the column small AND decodable with a plain
 * `parseInt`, which matters because the runtime decodes thousands of rows
 * per shard load.
 *
 * 2 chars covers 36² = 1296 themes, far more than Lichess will ever ship.
 */
export function encodeThemes(themes, vocabulary) {
  const out = [];
  for (const t of themes) {
    const idx = vocabulary.indexOf(t);
    if (idx < 0) continue;
    out.push(idx.toString(36).padStart(2, '0'));
  }
  return out.join('');
}

export function decodeThemes(encoded, vocabulary) {
  const out = [];
  for (let i = 0; i + 2 <= encoded.length; i += 2) {
    const idx = parseInt(encoded.slice(i, i + 2), 36);
    const name = vocabulary[idx];
    if (name) out.push(name);
  }
  return out;
}

/* =======================================================================
 *  Streaming read + per-band bounded selection
 * =======================================================================
 */

/**
 * Stream the whole database, keeping only the best `PER_BAND_CAP` rows per
 * rating band.
 *
 * Memory is bounded on purpose. ~1-2 M of the 6 M rows clear the quality
 * gate, and holding them all would cost well over a gigabyte. Instead each
 * band keeps a bucket that is pruned back to the cap whenever it grows past
 * 2x — amortised O(1) per row, and peak residency is
 * `bandCount * 2 * PER_BAND_CAP` rows (~416k) regardless of input size.
 */
async function selectRows(onProgress) {
  if (!existsSync(CACHE_FILE)) {
    throw new Error(
      `Missing ${CACHE_FILE}.\nDownload it first:\n` +
        `  mkdir -p .cache && curl -L -o ${CACHE_FILE} ${SOURCE_URL}`,
    );
  }

  const bands = Array.from({ length: bandCount() }, () => []);
  const pruneAt = PER_BAND_CAP * 2;
  let seen = 0;
  let kept = 0;

  // `zstd -dc` streams the 1 GB decompressed form through a pipe so we never
  // materialise it on disk.
  const zstd = spawn('zstd', ['-dc', CACHE_FILE], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const rl = createInterface({ input: zstd.stdout, crlfDelay: Infinity });

  let isHeader = true;
  for await (const line of rl) {
    if (isHeader) {
      isHeader = false;
      const header = line.trim();
      const expected = CSV_COLUMNS.join(',');
      if (header !== expected) {
        throw new Error(
          `Unexpected CSV header.\n  expected: ${expected}\n  got:      ${header}\n` +
            'The Lichess schema changed — re-check the column mapping before trusting this build.',
        );
      }
      continue;
    }
    seen++;
    if (seen % 500_000 === 0) onProgress?.(seen, kept);

    const row = parseCsvRow(line);
    if (!row) continue;

    const b = bands[bandOf(row.rating)];
    if (!b) continue;
    b.push(row);
    kept++;
    if (b.length >= pruneAt) pruneBand(b);
  }

  const code = await new Promise((res) => zstd.on('close', res));
  if (code !== 0) throw new Error(`zstd exited with code ${code}`);

  for (const b of bands) pruneBand(b);
  return { bands, seen, kept };
}

/** Sort by NbPlays desc, id asc (a stable tiebreak keeps output
 *  reproducible across runs), then truncate to the cap. */
function pruneBand(b) {
  b.sort((x, y) => (y.nbPlays - x.nbPlays) || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  if (b.length > PER_BAND_CAP) b.length = PER_BAND_CAP;
}

/* =======================================================================
 *  Build
 * =======================================================================
 */

export async function build({ quiet = false } = {}) {
  const log = quiet ? () => {} : (...a) => console.log(...a);

  log(`Reading ${CACHE_FILE} …`);
  const t0 = Date.now();
  const { bands, seen, kept } = await selectRows((s, k) =>
    log(`  ${(s / 1e6).toFixed(1)} M rows scanned, ${k.toLocaleString()} kept…`),
  );
  log(
    `Scanned ${seen.toLocaleString()} rows in ${((Date.now() - t0) / 1000).toFixed(0)}s; ` +
      `${kept.toLocaleString()} passed the quality gate.`,
  );

  // Resolve moves + collect the theme vocabulary over the survivors only.
  // chess.js is the expensive step (~200k position loads), so it runs after
  // per-band capping, not before.
  log('Resolving move lines (applying Moves[0]) …');
  const themeSet = new Set();
  const resolvedBands = [];
  let dropped = 0;

  for (const band of bands) {
    const out = [];
    for (const row of band) {
      const r = resolvePuzzle(row);
      if (!r) {
        dropped++;
        continue;
      }
      const themes = row.themes.split(' ').filter(Boolean);
      for (const t of themes) themeSet.add(t);
      out.push({
        id: row.id,
        fen: r.fen,
        solution: r.solution,
        rating: row.rating,
        themes,
      });
    }
    // "Ordered by difficulty" is a build-time property so the runtime never
    // sorts. Ties broken by id for reproducibility.
    out.sort((a, b) => (a.rating - b.rating) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    resolvedBands.push(out);
  }
  if (dropped > 0) log(`  dropped ${dropped} rows whose move line didn't play out legally`);

  const vocabulary = [...themeSet].sort();
  log(`  theme vocabulary: ${vocabulary.length} themes`);

  // Serialise shards. buildId is a content hash over every shard body, so a
  // refreshed corpus lands on fresh URLs and the `immutable` cache header in
  // public/_headers stays truthful.
  const shardBodies = [];
  const manifest = [];
  for (let bi = 0; bi < resolvedBands.length; bi++) {
    const rows = resolvedBands[bi];
    if (rows.length === 0) continue;
    for (let start = 0, n = 0; start < rows.length; start += SHARD_ROWS, n++) {
      const slice = rows.slice(start, start + SHARD_ROWS);
      const body = slice
        .map((p) =>
          [
            p.id,
            p.fen,
            p.solution.join(' '),
            String(p.rating),
            encodeThemes(p.themes, vocabulary),
          ].join('\t'),
        )
        .join('\n');
      shardBodies.push({ band: bi, n, body });
      manifest.push({
        band: bi,
        n,
        rows: slice.length,
        minRating: slice[0].rating,
        maxRating: slice[slice.length - 1].rating,
      });
    }
  }

  const hash = createHash('sha256');
  for (const s of shardBodies) hash.update(`${s.band}-${s.n}\n${s.body}\n`);
  const buildId = hash.digest('hex').slice(0, 12);

  const total = manifest.reduce((a, m) => a + m.rows, 0);
  return { buildId, shardBodies, manifest, vocabulary, total, seen };
}

/**
 * Emit `src/data/puzzles.meta.generated.ts`. Split into a timestamped
 * `banner` and a deterministic `body` for the same reason
 * `build-openings.mjs` does: it lets a test compare the committed file
 * against a rebuild while ignoring the one nondeterministic line.
 */
export function renderMeta({ buildId, manifest, vocabulary, total }) {
  const tiers = TIERS.map((t) => ({
    id: t.id,
    maxExclusive: t.maxExclusive === Infinity ? null : t.maxExclusive,
  }));

  const banner =
    '// AUTO-GENERATED by scripts/build-puzzles.mjs — do not edit by hand.\n' +
    `${GENERATED_TIMESTAMP_PREFIX}${new Date().toISOString()}\n` +
    '//\n' +
    '// Manifest for the sharded puzzle corpus under public/puzzles/<BUILD_ID>/.\n' +
    '// Source: https://database.lichess.org/#puzzles (CC0 1.0 Universal).\n' +
    '//\n' +
    '// Puzzle CONTENT is not in this file — it lives in the TSV shards, fetched\n' +
    '// on demand by src/features/puzzles/corpus.ts. Only the index is bundled.\n' +
    '\n';

  const body =
    `export const PUZZLE_BUILD_ID = ${JSON.stringify(buildId)};\n\n` +
    `/** Total puzzles across every shard. */\n` +
    `export const PUZZLE_TOTAL = ${total};\n\n` +
    `export const RATING_MIN = ${RATING_MIN};\n` +
    `export const RATING_MAX = ${RATING_MAX};\n` +
    `export const BAND_WIDTH = ${BAND_WIDTH};\n\n` +
    '/** Theme names, index-aligned with the 2-char base36 codes in each\n' +
    " *  shard's `themes` column. Regenerating can reorder this, which is why\n" +
    ' *  shard URLs are content-hashed — a stale shard can never be decoded\n' +
    ' *  against a newer vocabulary. */\n' +
    `export const PUZZLE_THEMES: readonly string[] = ${JSON.stringify(vocabulary)} as const;\n\n` +
    '/** Difficulty tiers, by rating. `maxExclusive: null` = open-ended. */\n' +
    `export const PUZZLE_TIERS: readonly { id: string; maxExclusive: number | null }[] = ${JSON.stringify(tiers)} as const;\n\n` +
    'export interface PuzzleShardMeta {\n' +
    '  /** Rating band index: rating = RATING_MIN + band * BAND_WIDTH. */\n' +
    '  band: number;\n' +
    '  /** Shard number within the band. */\n' +
    '  n: number;\n' +
    '  rows: number;\n' +
    '  minRating: number;\n' +
    '  maxRating: number;\n' +
    '}\n\n' +
    '/** Every shard, ascending by (band, n) — i.e. ascending by difficulty. */\n' +
    `export const PUZZLE_SHARDS: readonly PuzzleShardMeta[] = ${JSON.stringify(manifest)} as const;\n`;

  return { banner, body };
}

async function main() {
  const result = await build();
  const outDir = join(PUZZLE_ASSET_DIR, result.buildId);

  // Drop stale build dirs so old corpora don't accumulate in git.
  if (existsSync(PUZZLE_ASSET_DIR)) {
    for (const entry of readdirSync(PUZZLE_ASSET_DIR)) {
      if (entry !== result.buildId) {
        rmSync(join(PUZZLE_ASSET_DIR, entry), { recursive: true, force: true });
        console.log(`  removed stale build ${entry}`);
      }
    }
  }
  mkdirSync(outDir, { recursive: true });

  let bytes = 0;
  for (const s of result.shardBodies) {
    const body = s.body + '\n';
    writeFileSync(join(outDir, `b${s.band}-${s.n}.tsv`), body);
    bytes += Buffer.byteLength(body);
  }

  const { banner, body } = renderMeta(result);
  writeFileSync(META_FILE, banner + body);

  // Per-band report. A bad filter shows up here as an empty or lopsided
  // band, rather than as an empty tab in the UI three steps later.
  console.log('\nBand report');
  console.log('  band  rating range   puzzles  shards');
  const byBand = new Map();
  for (const m of result.manifest) {
    const e = byBand.get(m.band) ?? { rows: 0, shards: 0 };
    e.rows += m.rows;
    e.shards++;
    byBand.set(m.band, e);
  }
  const perTier = new Map();
  for (const [band, e] of [...byBand].sort((a, b) => a[0] - b[0])) {
    const lo = RATING_MIN + band * BAND_WIDTH;
    const hi = lo + BAND_WIDTH - 1;
    const tier = tierOf(lo);
    perTier.set(tier, (perTier.get(tier) ?? 0) + e.rows);
    console.log(
      `  ${String(band).padStart(4)}  ${String(lo).padStart(4)}-${String(hi).padEnd(4)}  ` +
        `${String(e.rows).padStart(8)}  ${String(e.shards).padStart(6)}`,
    );
  }

  console.log('\nTier totals');
  for (const t of TIERS) {
    console.log(`  ${t.id.padEnd(8)} ${String(perTier.get(t.id) ?? 0).padStart(8)}`);
  }

  console.log(
    `\nWrote ${result.shardBodies.length} shards ` +
      `(${(bytes / 1e6).toFixed(1)} MB) to public/puzzles/${result.buildId}/`,
  );
  console.log(`Wrote ${META_FILE}`);
  console.log(`Total: ${result.total.toLocaleString()} puzzles`);
}

// Only run when invoked directly — the coherence test imports this module
// for its pure seams.
if (process.argv[1] && process.argv[1].endsWith('build-puzzles.mjs')) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
