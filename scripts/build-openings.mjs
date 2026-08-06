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
const OUT_FILE = join(__dirname, '..', 'src', 'data', 'openings.generated.ts');

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

function main() {
  if (!existsSync(DATA_DIR)) {
    console.error(`Missing ${DATA_DIR}. Download the TSVs from`);
    console.error('https://github.com/lichess-org/chess-openings first.');
    process.exit(1);
  }
  const files = readdirSync(DATA_DIR)
    .filter((f) => /^[a-e]\.tsv$/i.test(f))
    .sort();
  if (files.length === 0) {
    console.error(`No a.tsv..e.tsv files under ${DATA_DIR}.`);
    process.exit(1);
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
  const linePopularity = existsSync(LINE_POPULARITY_FILE)
    ? parseLinePopularityTsv(readFileSync(LINE_POPULARITY_FILE, 'utf8'))
    : new Map();
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
  families.sort((a, b) => a.family.localeCompare(b.family));

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
    '  /** Games reaching the final move in the bundled Lichess snapshot. */',
    '  globalGames: number;',
    '  /** Final move share among games reaching its parent position. */',
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

  const body =
    `export const OPENING_LINES: readonly OpeningLine[] = ${JSON.stringify(records, null, 0)} as const;\n\n` +
    `export const OPENING_FAMILIES: readonly OpeningFamilyMeta[] = ${JSON.stringify(families, null, 0)} as const;\n`;

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
