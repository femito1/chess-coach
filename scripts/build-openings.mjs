#!/usr/bin/env node
// Build-time pipeline for the preloaded opening library.
//
// Reads the Lichess `chess-openings` TSVs (committed under data/openings/)
// and emits src/data/openings.generated.ts — an array of compact records
// ready for the UI. PGN is converted to a UCI move list using chess.js so
// the runtime never has to parse PGN.
//
// Re-run this script to refresh the dataset:
//   node scripts/build-openings.mjs
//
// Source: https://github.com/lichess-org/chess-openings (MIT licensed).

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Chess } from 'chess.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DATA_DIR = join(__dirname, '..', 'data', 'openings');
const POPULARITY_FILE = join(DATA_DIR, 'popularity.tsv');
const LINE_POPULARITY_FILE = join(DATA_DIR, 'line-popularity.tsv');
export const OUT_FILE = join(__dirname, '..', 'src', 'data', 'openings.generated.ts');

// Family ordering is part of the emitted bytes, so it must not depend on
// the machine doing the emitting. See the sort in buildBundle().
const FAMILY_COLLATOR = new Intl.Collator('en');

function parseTsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) return [];
  const [, ...rows] = lines; // drop header
  const out = [];
  for (const row of rows) {
    const cols = row.split('\t');
    if (cols.length < 3) continue;
    const [eco, name, pgn] = cols;
    if (!eco || !name || !pgn) continue;
    out.push({ eco: eco.trim(), name: name.trim(), pgn: pgn.trim() });
  }
  return out;
}

/**
 * Parse `data/openings/popularity.tsv` — a hand-authored map from
 * family name to (popularity rank, description). Popularity ranks
 * source: chess.com's published "Most Common Openings" top-20 list,
 * augmented with master-game frequency rankings from chess-grandmaster.com
 * for ranks 21+. Lower rank = more popular; 999 = obscure / joke.
 *
 * Descriptions are 1-4 sentence blurbs explaining the opening's main
 * idea and what kind of player suits it. The openings library page
 * surfaces them so users don't drill an opening blindly.
 */
function parsePopularityTsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) return new Map();
  const [, ...rows] = lines; // drop header
  const out = new Map();
  for (const row of rows) {
    const cols = row.split('\t');
    if (cols.length < 3) continue;
    const [family, popStr, ...descParts] = cols;
    const description = descParts.join('\t').trim();
    if (!family) continue;
    const popularity = parseInt(popStr, 10);
    if (Number.isNaN(popularity)) continue;
    out.set(family.trim(), { popularity, description });
  }
  return out;
}

/**
 * Read `measuredParentDepth` out of a line-popularity TSV's header.
 *
 * This matters to the app, not just to this script. The snapshot only
 * queries the explorer down to that depth; beyond it, a line's
 * `globalGames` / `globalShare` are the parent branch's numbers scaled by
 * a documented 0.82-per-ply decay. Those are estimates, and an estimate
 * that shrinks with depth is *not* a rarity measurement — presenting one
 * to the user as "only 5% play this" would state a fact we don't have.
 * So the depth travels into the bundle and the UI checks each line
 * against it before quoting a frequency.
 *
 * Returns `Infinity` for a full-depth snapshot (header says `full`), a
 * finite number for a capped one, and `0` when the header is missing —
 * the safest reading, since it makes the UI trust nothing.
 */
export function parseMeasuredParentDepth(text) {
  const match = /^#\s*measuredParentDepth=(full|\d+)/m.exec(text);
  if (!match) return 0;
  return match[1] === 'full' ? Infinity : Number(match[1]);
}

export function parseLinePopularityTsv(text) {
  const lines = text
    .split(/\r?\n/)
    .filter((line) => line.length > 0 && !line.startsWith('#'));
  if (lines.length === 0) return new Map();
  const [, ...rows] = lines;
  const out = new Map();
  for (const row of rows) {
    const [uciKey, gamesRaw, shareRaw] = row.split('\t');
    const globalGames = Number(gamesRaw);
    const globalShare = Number(shareRaw);
    if (
      !uciKey ||
      !Number.isFinite(globalGames) ||
      !Number.isFinite(globalShare)
    ) {
      continue;
    }
    out.set(uciKey.trim(), { globalGames, globalShare });
  }
  return out;
}

function pgnToUci(pgn) {
  const c = new Chess();
  // The TSV "pgn" is a bare move list ("1. e4 e5 2. Nf3 ..."). chess.js'
  // loadPgn accepts this form.
  try {
    c.loadPgn(pgn);
  } catch {
    return null;
  }
  const hist = c.history({ verbose: true });
  const uci = [];
  for (const m of hist) {
    uci.push(m.from + m.to + (m.promotion ?? ''));
  }
  return uci;
}

/**
 * Split "Sicilian Defense: Najdorf Variation, English Attack" into
 *   family = "Sicilian Defense"
 *   variation = "Najdorf Variation, English Attack"
 * Fallback: name with no ":" has family = name, variation = "".
 */
function splitName(name) {
  const idx = name.indexOf(':');
  if (idx < 0) return { family: name, variation: '' };
  return {
    family: name.slice(0, idx).trim(),
    variation: name.slice(idx + 1).trim(),
  };
}

/**
 * Read every committed input and produce the exact text of
 * `openings.generated.ts`, split into a timestamped `banner` and a
 * deterministic `body`. Pure over the filesystem inputs and free of any
 * `Date.now()` outside the banner, so a test can rebuild the body in
 * memory and compare it to the committed file byte-for-byte (ignoring the
 * one timestamped banner line). This is the seam the coherence guard
 * relies on: the bundle can never silently drift from the TSVs it is
 * built from without failing `npm run test:unit`.
 *
 * Returns `{ banner, body, records, families, skipped, unranked }`.
 */
export function buildBundle() {
  if (!existsSync(DATA_DIR)) {
    throw new Error(
      `Missing ${DATA_DIR}. Download the TSVs from ` +
        'https://github.com/lichess-org/chess-openings first.',
    );
  }
  const files = readdirSync(DATA_DIR)
    .filter((f) => /^[a-e]\.tsv$/i.test(f))
    .sort();
  if (files.length === 0) {
    throw new Error(`No a.tsv..e.tsv files under ${DATA_DIR}.`);
  }

  // Hand-authored popularity + descriptions, keyed by family name.
  // Optional file: if it doesn't exist (e.g. a fresh checkout that
  // forgot the file) we still emit a usable bundle, just without
  // descriptions and with every popularity rank defaulting to a
  // sentinel so the alphabetical fallback wins.
  const popularity = existsSync(POPULARITY_FILE)
    ? parsePopularityTsv(readFileSync(POPULARITY_FILE, 'utf8'))
    : new Map();
  if (popularity.size === 0) {
    console.warn(
      `No ${POPULARITY_FILE} found — emitting bundle without descriptions.`,
    );
  }
  const linePopularityRaw = existsSync(LINE_POPULARITY_FILE)
    ? readFileSync(LINE_POPULARITY_FILE, 'utf8')
    : '';
  const linePopularity = linePopularityRaw
    ? parseLinePopularityTsv(linePopularityRaw)
    : new Map();
  const measuredParentDepth = parseMeasuredParentDepth(linePopularityRaw);
  if (linePopularity.size === 0) {
    console.warn(
      `No ${LINE_POPULARITY_FILE} found — emitting lines without frequency data.`,
    );
  }

  const records = [];
  let skipped = 0;
  for (const f of files) {
    const rows = parseTsv(readFileSync(join(DATA_DIR, f), 'utf8'));
    for (const row of rows) {
      const uci = pgnToUci(row.pgn);
      if (!uci || uci.length === 0) {
        skipped++;
        continue;
      }
      const { family, variation } = splitName(row.name);
      const lineMeta = linePopularity.get(uci.join(' '));
      records.push({
        eco: row.eco,
        name: row.name,
        family,
        variation,
        uci,
        pgn: row.pgn,
        globalGames: lineMeta?.globalGames ?? 0,
        globalShare: lineMeta?.globalShare ?? 0,
      });
    }
  }

  records.sort((a, b) => {
    if (a.eco !== b.eco) return a.eco < b.eco ? -1 : 1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });

  // Build a per-family aggregate so the runtime doesn't have to scan
  // OPENING_LINES on every render. Each entry contains:
  //   - lineCount  : how many lines in OPENING_LINES belong to this family
  //   - popularity : authored rank from popularity.tsv (lower = more
  //                  popular). Defaults to 999 ("obscure") when not
  //                  authored, so families that haven't been ranked
  //                  drop to the bottom of "Most popular" and surface
  //                  alphabetically inside the same rank tier.
  //   - description: authored blurb, or '' when not authored.
  const familyAgg = new Map();
  for (const r of records) {
    const cur = familyAgg.get(r.family) ?? { lineCount: 0 };
    cur.lineCount++;
    familyAgg.set(r.family, cur);
  }
  const families = [];
  let unranked = 0;
  for (const [family, agg] of familyAgg) {
    const meta = popularity.get(family);
    families.push({
      family,
      lineCount: agg.lineCount,
      popularity: meta?.popularity ?? 999,
      description: meta?.description ?? '',
    });
    if (!meta) unranked++;
  }
  // Pin the collation locale. Bare `localeCompare()` sorts in the HOST's
  // default locale, so the emitted byte order was a property of whichever
  // machine ran the generator — and the coherence test compares the
  // committed bundle to a fresh rebuild byte-for-byte. A CI runner (or a
  // contributor) with a different ICU default would fail that test with a
  // diff nobody could reproduce locally. 'en' reproduces the committed
  // order exactly (verified against the committed OPENING_FAMILIES); it
  // only removes the environmental dependency.
  families.sort((a, b) => FAMILY_COLLATOR.compare(a.family, b.family));

  // Emit as a single compact TS module. Using JSON.stringify for the body
  // keeps it deterministic and easy to diff.
  const banner = [
    '// AUTO-GENERATED by scripts/build-openings.mjs. Do not edit by hand.',
    '// Source: https://github.com/lichess-org/chess-openings (MIT).',
    `// Generated ${new Date().toISOString()} — ${records.length} lines, ${families.length} families.`,
    '',
    'export interface OpeningLine {',
    '  eco: string;',
    '  name: string;',
    '  family: string;',
    '  variation: string;',
    '  uci: string[];',
    '  pgn: string;',
    '  /** Games reaching the final move in the bundled Lichess snapshot.',
    '   *  Only a real measurement when `uci.length - 1 <=',
    '   *  MEASURED_PARENT_DEPTH`; deeper rows are the parent branch scaled',
    '   *  by a 0.82-per-ply decay. See `isMeasuredLine`. */',
    '  globalGames: number;',
    '  /** Final move share among games reaching its parent position. Same',
    '   *  measured-vs-estimated caveat as `globalGames`. */',
    '  globalShare: number;',
    '}',
    '',
    '/**',
    ' * Per-family aggregate metadata authored in `data/openings/popularity.tsv`',
    ' * (popularity rank + plain-English description) plus computed `lineCount`',
    ' * (number of OPENING_LINES rows whose `family` matches). Surfaced on the',
    ' * openings library page for sorting + the "what is this opening" blurb,',
    ' * and read indirectly by the practice page (line picker shows the family',
    ' * description above the line list when only one family is selected).',
    ' */',
    'export interface OpeningFamilyMeta {',
    '  family: string;',
    '  lineCount: number;',
    '  /** Lower = more popular. 999 = unranked / obscure. */',
    '  popularity: number;',
    '  /** Empty string when no description has been authored. */',
    '  description: string;',
    '}',
    '',
  ].join('\n');

  // `Infinity` has no JSON form, so a full-depth snapshot is emitted as
  // `Number.POSITIVE_INFINITY` in source.
  const depthLiteral =
    measuredParentDepth === Infinity
      ? 'Number.POSITIVE_INFINITY'
      : String(measuredParentDepth);

  const body =
    `export const OPENING_LINES: readonly OpeningLine[] = ${JSON.stringify(records, null, 0)} as const;\n\n` +
    `export const OPENING_FAMILIES: readonly OpeningFamilyMeta[] = ${JSON.stringify(families, null, 0)} as const;\n\n` +
    '/**\n' +
    ' * How deep the bundled snapshot actually queried the opening explorer,\n' +
    " * read from the TSV header's `measuredParentDepth`. A line's frequency\n" +
    ' * is a real measurement only when its parent sits within this depth;\n' +
    ' * beyond it the numbers are a documented 0.82-per-ply decay of the\n' +
    ' * nearest measured ancestor, which shrinks with depth and therefore\n' +
    " * says nothing about how often the move is actually chosen. Don't quote\n" +
    ' * an estimated number to the user as a frequency — use `isMeasuredLine`.\n' +
    ' */\n' +
    `export const MEASURED_PARENT_DEPTH: number = ${depthLiteral};\n\n` +
    '/** True when this line\'s own branch was measured rather than estimated. */\n' +
    'export function isMeasuredLine(line: Pick<OpeningLine, \'uci\'>): boolean {\n' +
    '  return line.uci.length - 1 <= MEASURED_PARENT_DEPTH;\n' +
    '}\n';

  return { banner, body, records, families, skipped, unranked };
}

/** The banner's third line carries `new Date().toISOString()`, so it
 *  differs on every build. The coherence test strips exactly this line
 *  from both sides before comparing. Kept next to the emitter so the two
 *  never drift apart. */
export const GENERATED_TIMESTAMP_PREFIX = '// Generated ';

function main() {
  const { banner, body, records, families, skipped, unranked } = buildBundle();
  const outDir = dirname(OUT_FILE);
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  writeFileSync(OUT_FILE, banner + body);

  console.log(
    `Wrote ${records.length} lines + ${families.length} families to ${OUT_FILE}` +
      ` (${skipped} skipped for bad PGN; ${unranked} families unranked).`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === __filename) {
  main();
}
