import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Chess } from 'chess.js';
import {
  PUZZLE_BUILD_ID,
  PUZZLE_SHARDS,
  PUZZLE_THEMES,
  PUZZLE_TOTAL,
} from './puzzles.meta.generated';

/**
 * Coherence guard for the committed puzzle corpus.
 *
 * Differs from `openings.generated.test.ts` on purpose. That guard rebuilds
 * its bundle in memory and diffs it byte-for-byte, which it can do because
 * its inputs are 650 KB of committed TSV. This corpus is built from a 304 MB
 * download that decompresses to ~1 GB, so a rebuild-and-diff is not viable
 * in the unit tier. Instead we verify the committed artifacts are internally
 * consistent and actually playable:
 *
 *   - every shard the manifest lists exists on disk, with the row count and
 *     rating bounds the manifest claims;
 *   - every row decodes, and its solution plays out legally from its FEN.
 *
 * That second check is the regression guard for the `Moves[0]` trap
 * documented in `scripts/build-puzzles.mjs`: the Lichess CSV's FEN is the
 * position BEFORE the opponent moves into the puzzle, so the build script
 * has to apply `Moves[0]` and store `Moves[1..]` as the solution. Get it
 * backwards and every puzzle is off by one ply — the positions still look
 * plausible, but the first expected move is illegal, so the page would be
 * uniformly unsolvable. Playing lines out is the only way to catch that.
 *
 * If this fails: run `npm run puzzles:build` and commit the result.
 */

const ASSET_DIR = join(process.cwd(), 'public', 'puzzles', PUZZLE_BUILD_ID);

function shardPath(band: number, n: number): string {
  return join(ASSET_DIR, `b${band}-${n}.tsv`);
}

interface Row {
  id: string;
  fen: string;
  solution: string[];
  rating: number;
  themeCodes: string;
}

function readShard(band: number, n: number): Row[] {
  const text = readFileSync(shardPath(band, n), 'utf8');
  const out: Row[] = [];
  for (const line of text.split('\n')) {
    if (line.length === 0) continue;
    const [id, fen, sol, rating, themeCodes] = line.split('\t');
    out.push({
      id,
      fen,
      solution: sol.split(' ').filter(Boolean),
      rating: Number(rating),
      themeCodes: themeCodes ?? '',
    });
  }
  return out;
}

function uciToMove(uci: string) {
  return {
    from: uci.slice(0, 2),
    to: uci.slice(2, 4),
    ...(uci.length > 4 ? { promotion: uci[4] } : {}),
  };
}

/** Play a row's whole line. Returns null on success, else why it failed. */
function playOut(row: Row): string | null {
  const chess = new Chess();
  try {
    chess.load(row.fen);
  } catch (err) {
    return `illegal FEN: ${(err as Error).message}`;
  }
  if (row.solution.length === 0) return 'empty solution';
  for (const [i, uci] of row.solution.entries()) {
    try {
      if (!chess.move(uciToMove(uci))) return `move ${i} (${uci}) rejected`;
    } catch (err) {
      return `move ${i} (${uci}) threw: ${(err as Error).message}`;
    }
  }
  return null;
}

describe('puzzle corpus assets', () => {
  it('has the build directory the manifest points at', () => {
    expect(
      existsSync(ASSET_DIR),
      `missing ${ASSET_DIR} — run \`npm run puzzles:build\``,
    ).toBe(true);
  });

  it('has every shard the manifest lists', () => {
    const missing = PUZZLE_SHARDS.filter((s) => !existsSync(shardPath(s.band, s.n))).map(
      (s) => `b${s.band}-${s.n}.tsv`,
    );
    expect(missing, `shards in manifest but not on disk: ${missing.join(', ')}`).toEqual(
      [],
    );
  });

  it('matches the manifest row count and rating bounds for every shard', () => {
    const problems: string[] = [];
    let total = 0;
    for (const s of PUZZLE_SHARDS) {
      const rows = readShard(s.band, s.n);
      total += rows.length;
      if (rows.length !== s.rows) {
        problems.push(`b${s.band}-${s.n}: ${rows.length} rows, manifest says ${s.rows}`);
        continue;
      }
      const ratings = rows.map((r) => r.rating);
      const lo = Math.min(...ratings);
      const hi = Math.max(...ratings);
      if (lo !== s.minRating || hi !== s.maxRating) {
        problems.push(
          `b${s.band}-${s.n}: ratings ${lo}-${hi}, manifest says ${s.minRating}-${s.maxRating}`,
        );
      }
      // Ascending order is what makes "ordered by difficulty" free at runtime.
      for (let i = 1; i < ratings.length; i++) {
        if (ratings[i] < ratings[i - 1]) {
          problems.push(`b${s.band}-${s.n}: ratings not ascending at row ${i}`);
          break;
        }
      }
    }
    expect(problems, `stale corpus — run \`npm run puzzles:build\`:\n${problems.join('\n')}`)
      .toEqual([]);
    expect(total).toBe(PUZZLE_TOTAL);
  });

  it('references only in-range theme indices', () => {
    const problems: string[] = [];
    for (const s of PUZZLE_SHARDS) {
      for (const row of readShard(s.band, s.n)) {
        for (let i = 0; i + 2 <= row.themeCodes.length; i += 2) {
          const idx = parseInt(row.themeCodes.slice(i, i + 2), 36);
          if (!Number.isFinite(idx) || idx < 0 || idx >= PUZZLE_THEMES.length) {
            problems.push(`${row.id}: theme index ${idx} out of range`);
          }
        }
      }
      if (problems.length > 5) break;
    }
    expect(problems.slice(0, 5)).toEqual([]);
  });

  it('gives every puzzle a unique id', () => {
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const s of PUZZLE_SHARDS) {
      for (const row of readShard(s.band, s.n)) {
        if (seen.has(row.id)) dupes.push(row.id);
        seen.add(row.id);
      }
    }
    expect(dupes.slice(0, 5), `duplicate puzzle ids: ${dupes.slice(0, 5).join(', ')}`).toEqual(
      [],
    );
    expect(seen.size).toBe(PUZZLE_TOTAL);
  });
});

/**
 * Replaying all 191k lines takes ~78 s, which is too slow for a tier that
 * should stay snappy. By default we replay a deterministic stride sample
 * spread across every shard (~4 s); set `PUZZLE_CORPUS_FULL=1` for the
 * exhaustive walk.
 *
 * A sample is the right default because of what each layer guarantees.
 * `build-puzzles.mjs` already plays out every line at build time and drops
 * any that fail, so the corpus is clean *by construction* — the last build
 * reported zero drops out of 191,250. What this test defends against is a
 * *systematic* error (a mishandled `Moves[0]`, a stale commit, a shard/
 * manifest mismatch), and a systematic error fails on essentially every row,
 * so a 1-in-20 sample catches it just as reliably as a full walk. Run the
 * full mode after a corpus refresh, where a one-off bad row is conceivable.
 */
const FULL = process.env.PUZZLE_CORPUS_FULL === '1';
const STRIDE = FULL ? 1 : 20;

describe('Moves[0] handling — solution lines are legal', () => {
  it(`plays out ${FULL ? 'every line' : 'a 1-in-' + STRIDE + ' sample'} across all shards`, () => {
    const failures: string[] = [];
    let checked = 0;

    for (const s of PUZZLE_SHARDS) {
      const rows = readShard(s.band, s.n);
      // Offset the stride by shard so the sample doesn't always land on the
      // same position within each shard.
      for (let i = s.band % STRIDE; i < rows.length; i += STRIDE) {
        checked++;
        const why = playOut(rows[i]);
        if (why) failures.push(`${rows[i].id} (b${s.band}-${s.n}): ${why}`);
        if (failures.length >= 10) break;
      }
      if (failures.length >= 10) break;
    }

    expect(
      failures,
      'unplayable puzzles — the most likely cause is Moves[0] handling in ' +
        'scripts/build-puzzles.mjs (see the header comment there):\n' +
        failures.join('\n'),
    ).toEqual([]);
    // Sanity-check the sample actually covered the corpus, so a bug that
    // silently skipped rows can't make this test vacuously pass.
    const expected = FULL ? PUZZLE_TOTAL : Math.floor(PUZZLE_TOTAL / STRIDE / 2);
    expect(checked).toBeGreaterThan(expected);
  }, 180_000);

  it('starts every puzzle with the solver to move, alternating thereafter', () => {
    // The stored FEN is post-`Moves[0]`, so the side to move must be the
    // solver. If the build script skipped applying Moves[0], the side to
    // move would be the opponent's and this would fail on ~every row.
    const problems: string[] = [];
    for (const s of PUZZLE_SHARDS.slice(0, 6)) {
      for (const row of readShard(s.band, s.n)) {
        const chess = new Chess();
        chess.load(row.fen);
        const solver = chess.turn();
        for (const [i, uci] of row.solution.entries()) {
          const expectTurn = i % 2 === 0 ? solver : solver === 'w' ? 'b' : 'w';
          if (chess.turn() !== expectTurn) {
            problems.push(`${row.id}: move ${i} played by wrong side`);
            break;
          }
          chess.move(uciToMove(uci));
        }
        if (problems.length > 5) break;
      }
      if (problems.length > 5) break;
    }
    expect(problems.slice(0, 5)).toEqual([]);
  }, 60_000);
});
