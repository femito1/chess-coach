import { describe, expect, it } from 'vitest';
import {
  PUZZLE_SHARDS,
  PUZZLE_THEMES,
  PUZZLE_TIERS,
  PUZZLE_TOTAL,
  RATING_MIN,
  RATING_MAX,
} from '@/data/puzzles.meta.generated';
import {
  decodeThemeCodes,
  parseShard,
  shardsForRatingWindow,
  shardsForTier,
  tierForRating,
  tierPuzzleCount,
  tierRatingRange,
} from './corpus';

/** Encode theme indices the way build-puzzles.mjs does: fixed-width 2-char
 *  base36. Kept local so the test doesn't depend on the build script. */
function codes(...indices: number[]): string {
  return indices.map((i) => i.toString(36).padStart(2, '0')).join('');
}

describe('parseShard', () => {
  it('decodes a well-formed row', () => {
    const fen = '8/8/6k1/5p1p/1P4pK/P5P1/3r3Q/8 b - - 0 53';
    const rows = parseShard(`abcde\t${fen}\td2h2 h4g5\t400\t${codes(3, 10)}`);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      id: 'abcde',
      fen,
      solution: ['d2h2', 'h4g5'],
      rating: 400,
      themes: [PUZZLE_THEMES[3], PUZZLE_THEMES[10]],
    });
  });

  it('handles a trailing newline and blank lines', () => {
    const row = `abcde\t8/8/8/8/8/8/8/8 w - - 0 1\te2e4\t900\t${codes(0)}`;
    expect(parseShard(`${row}\n`)).toHaveLength(1);
    expect(parseShard(`${row}\n\n${row}\n`)).toHaveLength(2);
  });

  it('skips malformed rows instead of throwing', () => {
    // One bad row must not blank out a whole tab.
    const good = `abcde\t8/8/8/8/8/8/8/8 w - - 0 1\te2e4\t900\t${codes(0)}`;
    const text = ['too\tfew\tcols', good, 'x\ty\tz\tnotanumber\t00', ''].join('\n');
    const rows = parseShard(text);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('abcde');
  });

  it('tolerates an empty theme column', () => {
    const rows = parseShard('abcde\t8/8/8/8/8/8/8/8 w - - 0 1\te2e4\t900\t');
    expect(rows).toHaveLength(1);
    expect(rows[0].themes).toEqual([]);
  });
});

describe('decodeThemeCodes', () => {
  it('round-trips indices', () => {
    expect(decodeThemeCodes(codes(0, 5, 71))).toEqual([
      PUZZLE_THEMES[0],
      PUZZLE_THEMES[5],
      PUZZLE_THEMES[71],
    ]);
  });

  it('ignores an out-of-range index rather than emitting undefined', () => {
    // Would only happen with a shard/vocabulary mismatch, which the
    // content-hashed URLs are designed to prevent — but a stray `undefined`
    // in a theme chip would be an ugly way to find out.
    expect(decodeThemeCodes(codes(9999))).toEqual([]);
  });

  it('ignores a trailing half-code', () => {
    expect(decodeThemeCodes(`${codes(1)}x`)).toEqual([PUZZLE_THEMES[1]]);
  });
});

describe('shard manifest coherence', () => {
  it('has shards', () => {
    expect(PUZZLE_SHARDS.length).toBeGreaterThan(0);
    expect(PUZZLE_TOTAL).toBeGreaterThan(0);
  });

  it('row counts sum to PUZZLE_TOTAL', () => {
    const sum = PUZZLE_SHARDS.reduce((a, s) => a + s.rows, 0);
    expect(
      sum,
      'manifest rows disagree with PUZZLE_TOTAL — run `npm run puzzles:build`',
    ).toBe(PUZZLE_TOTAL);
  });

  it('is ordered ascending by (band, n) — i.e. by difficulty', () => {
    for (let i = 1; i < PUZZLE_SHARDS.length; i++) {
      const prev = PUZZLE_SHARDS[i - 1];
      const cur = PUZZLE_SHARDS[i];
      const ordered =
        cur.band > prev.band || (cur.band === prev.band && cur.n > prev.n);
      expect(ordered, `shard ${i} out of order: ${JSON.stringify({ prev, cur })}`).toBe(
        true,
      );
    }
  });

  it('keeps every shard inside its band and the global rating range', () => {
    for (const s of PUZZLE_SHARDS) {
      expect(s.minRating).toBeLessThanOrEqual(s.maxRating);
      expect(s.minRating).toBeGreaterThanOrEqual(RATING_MIN);
      expect(s.maxRating).toBeLessThan(RATING_MAX);
      expect(s.rows).toBeGreaterThan(0);
    }
  });

  it('gives every shard a distinct (band, n)', () => {
    const keys = PUZZLE_SHARDS.map((s) => `${s.band}-${s.n}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('tiers', () => {
  it('partitions the corpus with no gaps or overlaps', () => {
    const perTier = (['easy', 'medium', 'hard'] as const).map(tierPuzzleCount);
    expect(perTier.reduce((a, b) => a + b, 0)).toBe(PUZZLE_TOTAL);
  });

  it('`all` covers everything', () => {
    expect(tierPuzzleCount('all')).toBe(PUZZLE_TOTAL);
    expect(shardsForTier('all').length).toBe(PUZZLE_SHARDS.length);
  });

  it('every tier has usable inventory', () => {
    // A tab that loads nothing is worse than no tab; if a future tier edge
    // or per-band cap starves one, fail here rather than in the UI.
    for (const tier of ['easy', 'medium', 'hard'] as const) {
      expect(tierPuzzleCount(tier), `tier ${tier} is empty`).toBeGreaterThan(1000);
    }
  });

  it('reports a rating range consistent with its shards', () => {
    for (const tier of ['easy', 'medium', 'hard'] as const) {
      const range = tierRatingRange(tier)!;
      expect(range).not.toBeNull();
      expect(range.lo).toBeLessThanOrEqual(range.hi);
      for (const s of shardsForTier(tier)) {
        expect(s.minRating).toBeGreaterThanOrEqual(range.lo);
        expect(s.maxRating).toBeLessThanOrEqual(range.hi);
      }
    }
  });

  it('assigns a rating to the tier whose bound contains it', () => {
    const easyMax = PUZZLE_TIERS[0].maxExclusive!;
    const mediumMax = PUZZLE_TIERS[1].maxExclusive!;
    expect(tierForRating(easyMax - 1)).toBe('easy');
    expect(tierForRating(easyMax)).toBe('medium');
    expect(tierForRating(mediumMax - 1)).toBe('medium');
    expect(tierForRating(mediumMax)).toBe('hard');
    expect(tierForRating(9999)).toBe('hard');
  });
});

describe('shardsForRatingWindow', () => {
  it('returns only shards overlapping the window', () => {
    const shards = shardsForRatingWindow(1450, 1650);
    expect(shards.length).toBeGreaterThan(0);
    for (const s of shards) {
      expect(s.maxRating).toBeGreaterThanOrEqual(1450);
      expect(s.minRating).toBeLessThanOrEqual(1650);
    }
  });

  it('is empty for a window outside the corpus', () => {
    expect(shardsForRatingWindow(RATING_MAX + 500, RATING_MAX + 900)).toEqual([]);
  });

  it('clamps gracefully for a window straddling the low edge', () => {
    const shards = shardsForRatingWindow(RATING_MIN - 400, RATING_MIN + 50);
    expect(shards.length).toBeGreaterThan(0);
    expect(shards[0].band).toBe(0);
  });
});
