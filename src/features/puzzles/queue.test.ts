import { describe, expect, it } from 'vitest';
import type { PuzzleShardMeta } from '@/data/puzzles.meta.generated';
import type { LibraryPuzzle } from './corpus';
import {
  START_CURSOR,
  buildRecommendedQueue,
  interleave,
  seededShuffle,
  takeTierPuzzles,
} from './queue';
import type { RecommendationPlan } from './recommend';

/* ---------- synthetic corpus -------------------------------------------- */

function puzzle(id: string, rating: number, themes: string[] = []): LibraryPuzzle {
  return { id, fen: '8/8/8/8/8/8/8/8 w - - 0 1', solution: ['e2e4'], rating, themes };
}

/** Three shards of 4 puzzles each, ascending by rating. */
const SHARDS: PuzzleShardMeta[] = [
  { band: 0, n: 0, rows: 4, minRating: 400, maxRating: 430 },
  { band: 1, n: 0, rows: 4, minRating: 500, maxRating: 530 },
  { band: 2, n: 0, rows: 4, minRating: 600, maxRating: 630 },
];

const DATA: Record<string, LibraryPuzzle[]> = {
  '0-0': [
    puzzle('a1', 400, ['fork']),
    puzzle('a2', 410, ['pin']),
    puzzle('a3', 420, ['fork', 'pin']),
    puzzle('a4', 430, ['endgame']),
  ],
  '1-0': [
    puzzle('b1', 500, ['fork']),
    puzzle('b2', 510, ['backRankMate']),
    puzzle('b3', 520, ['fork']),
    puzzle('b4', 530, ['pin']),
  ],
  '2-0': [
    puzzle('c1', 600, ['fork']),
    puzzle('c2', 610, ['pin']),
    puzzle('c3', 620, ['skewer']),
    puzzle('c4', 630, ['fork']),
  ],
};

function loaderSpy() {
  const calls: string[] = [];
  const load = async (s: PuzzleShardMeta) => {
    const key = `${s.band}-${s.n}`;
    calls.push(key);
    return DATA[key] ?? [];
  };
  return { load, calls };
}

const none = () => false;

/* ---------- tier ladder ------------------------------------------------- */

describe('takeTierPuzzles', () => {
  it('serves in ascending rating order across shards', async () => {
    const { load } = loaderSpy();
    const res = await takeTierPuzzles({
      shards: SHARDS,
      cursor: START_CURSOR,
      count: 6,
      isExcluded: none,
      load,
    });
    expect(res.puzzles.map((p) => p.id)).toEqual(['a1', 'a2', 'a3', 'a4', 'b1', 'b2']);
    expect(res.exhausted).toBe(false);
  });

  it('only loads the shards it needs', async () => {
    const { load, calls } = loaderSpy();
    await takeTierPuzzles({
      shards: SHARDS,
      cursor: START_CURSOR,
      count: 3,
      isExcluded: none,
      load,
    });
    // Three puzzles all live in the first shard — the other two must not be
    // fetched. This is what keeps a tab from pulling megabytes it won't show.
    expect(calls).toEqual(['0-0']);
  });

  it('resumes from the returned cursor without repeating', async () => {
    const { load } = loaderSpy();
    const first = await takeTierPuzzles({
      shards: SHARDS,
      cursor: START_CURSOR,
      count: 3,
      isExcluded: none,
      load,
    });
    const second = await takeTierPuzzles({
      shards: SHARDS,
      cursor: first.cursor,
      count: 3,
      isExcluded: none,
      load,
    });
    expect(first.puzzles.map((p) => p.id)).toEqual(['a1', 'a2', 'a3']);
    expect(second.puzzles.map((p) => p.id)).toEqual(['a4', 'b1', 'b2']);
  });

  it('skips excluded puzzles', async () => {
    const { load } = loaderSpy();
    const solved = new Set(['a1', 'a3', 'b1']);
    const res = await takeTierPuzzles({
      shards: SHARDS,
      cursor: START_CURSOR,
      count: 4,
      isExcluded: (id) => solved.has(id),
      load,
    });
    expect(res.puzzles.map((p) => p.id)).toEqual(['a2', 'a4', 'b2', 'b3']);
  });

  it('reports exhausted when the shards run dry', async () => {
    const { load } = loaderSpy();
    const res = await takeTierPuzzles({
      shards: SHARDS,
      cursor: START_CURSOR,
      count: 99,
      isExcluded: none,
      load,
    });
    expect(res.puzzles).toHaveLength(12);
    expect(res.exhausted).toBe(true);
  });

  it('reports exhausted when everything is already solved', async () => {
    const { load } = loaderSpy();
    const res = await takeTierPuzzles({
      shards: SHARDS,
      cursor: START_CURSOR,
      count: 5,
      isExcluded: () => true,
      load,
    });
    expect(res.puzzles).toEqual([]);
    expect(res.exhausted).toBe(true);
  });

  it('handles an empty shard list', async () => {
    const { load } = loaderSpy();
    const res = await takeTierPuzzles({
      shards: [],
      cursor: START_CURSOR,
      count: 5,
      isExcluded: none,
      load,
    });
    expect(res.puzzles).toEqual([]);
    expect(res.exhausted).toBe(true);
  });
});

/* ---------- recommended queue ------------------------------------------- */

function plan(
  allocation: { motif: string; count: number }[],
  lo = 0,
  hi = 9999,
): RecommendationPlan {
  return {
    motifs: allocation.map((a) => ({
      motif: a.motif as never,
      score: a.count,
      share: 1 / allocation.length,
      mistakeCount: a.count,
      lastSeenAt: 0,
    })),
    themes: [],
    ratingLo: lo,
    ratingHi: hi,
    allocation: allocation as never,
  };
}

describe('buildRecommendedQueue', () => {
  it('returns only puzzles matching the planned motifs', async () => {
    const { load } = loaderSpy();
    const got = await buildRecommendedQueue({
      plan: plan([{ motif: 'fork', count: 3 }]),
      shards: SHARDS,
      isExcluded: none,
      seed: 1,
      load,
    });
    expect(got).toHaveLength(3);
    for (const p of got) expect(p.themes).toContain('fork');
  });

  it('respects the rating window', async () => {
    const { load } = loaderSpy();
    const got = await buildRecommendedQueue({
      plan: plan([{ motif: 'fork', count: 5 }], 500, 620),
      shards: SHARDS,
      isExcluded: none,
      seed: 1,
      load,
    });
    expect(got.length).toBeGreaterThan(0);
    for (const p of got) {
      expect(p.rating).toBeGreaterThanOrEqual(500);
      expect(p.rating).toBeLessThanOrEqual(620);
    }
  });

  it('honours per-motif allocation', async () => {
    const { load } = loaderSpy();
    const got = await buildRecommendedQueue({
      plan: plan([
        { motif: 'fork', count: 2 },
        { motif: 'pin', count: 1 },
      ]),
      shards: SHARDS,
      isExcluded: none,
      seed: 3,
      load,
    });
    expect(got).toHaveLength(3);
    const forks = got.filter((p) => p.themes.includes('fork')).length;
    expect(forks).toBeGreaterThanOrEqual(2);
  });

  it('interleaves motifs rather than grouping them', async () => {
    // A run of all forks then all pins is really two sessions; alternating
    // forces pattern-switching, which is the harder exercise.
    const { load } = loaderSpy();
    const got = await buildRecommendedQueue({
      plan: plan([
        { motif: 'fork', count: 2 },
        { motif: 'backRank', count: 1 },
      ]),
      shards: SHARDS,
      isExcluded: none,
      seed: 5,
      load,
    });
    const backRankIdx = got.findIndex((p) => p.themes.includes('backRankMate'));
    // With buckets [fork, fork] and [backRank], round-robin puts the
    // backRank puzzle second, not last.
    expect(backRankIdx).toBe(1);
  });

  it('never repeats a puzzle across motif buckets', async () => {
    // a3 is tagged both fork and pin — it must fill one bucket, not both.
    const { load } = loaderSpy();
    const got = await buildRecommendedQueue({
      plan: plan([
        { motif: 'fork', count: 4 },
        { motif: 'pin', count: 4 },
      ]),
      shards: SHARDS,
      isExcluded: none,
      seed: 7,
      load,
    });
    expect(new Set(got.map((p) => p.id)).size).toBe(got.length);
  });

  it('skips excluded puzzles', async () => {
    const { load } = loaderSpy();
    const got = await buildRecommendedQueue({
      plan: plan([{ motif: 'fork', count: 5 }]),
      shards: SHARDS,
      isExcluded: (id) => id === 'a1' || id === 'b1',
      seed: 1,
      load,
    });
    expect(got.map((p) => p.id)).not.toContain('a1');
    expect(got.map((p) => p.id)).not.toContain('b1');
  });

  it('returns a short queue rather than padding when matches run out', async () => {
    const { load } = loaderSpy();
    const got = await buildRecommendedQueue({
      plan: plan([{ motif: 'skewer', count: 10 }]),
      shards: SHARDS,
      isExcluded: none,
      seed: 1,
      load,
    });
    // Only c3 is a skewer.
    expect(got.map((p) => p.id)).toEqual(['c3']);
  });

  it('is empty for an empty plan or no shards', async () => {
    const { load } = loaderSpy();
    expect(
      await buildRecommendedQueue({
        plan: plan([]),
        shards: SHARDS,
        isExcluded: none,
        seed: 1,
        load,
      }),
    ).toEqual([]);
    expect(
      await buildRecommendedQueue({
        plan: plan([{ motif: 'fork', count: 3 }]),
        shards: [],
        isExcluded: none,
        seed: 1,
        load,
      }),
    ).toEqual([]);
  });

  it('is reproducible for a given seed and varies across seeds', async () => {
    const run = async (seed: number) => {
      const { load } = loaderSpy();
      const got = await buildRecommendedQueue({
        plan: plan([{ motif: 'fork', count: 2 }]),
        shards: SHARDS,
        isExcluded: none,
        seed,
        load,
      });
      return got.map((p) => p.id).join(',');
    };
    expect(await run(42)).toBe(await run(42));
    // Across many seeds the visited-shard order differs, so the selection
    // should not be constant — otherwise every session serves the same run.
    const variants = new Set(
      await Promise.all([1, 2, 3, 4, 5, 6, 7, 8].map((s) => run(s))),
    );
    expect(variants.size).toBeGreaterThan(1);
  });
});

/* ---------- helpers ----------------------------------------------------- */

describe('interleave', () => {
  it('round-robins and skips exhausted buckets', () => {
    expect(interleave([[1, 2, 3], [4], [5, 6]])).toEqual([1, 4, 5, 2, 6, 3]);
  });

  it('handles empty input and empty buckets', () => {
    expect(interleave([])).toEqual([]);
    expect(interleave([[], []])).toEqual([]);
    expect(interleave([[], [1]])).toEqual([1]);
  });
});

describe('seededShuffle', () => {
  it('is deterministic for a seed', () => {
    const a = seededShuffle([1, 2, 3, 4, 5, 6, 7, 8], 99);
    const b = seededShuffle([1, 2, 3, 4, 5, 6, 7, 8], 99);
    expect(a).toEqual(b);
  });

  it('preserves the multiset', () => {
    const input = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const out = seededShuffle(input.slice(), 7);
    expect(out.slice().sort((x, y) => x - y)).toEqual(input);
  });

  it('actually permutes for some seed', () => {
    const input = [1, 2, 3, 4, 5, 6, 7, 8];
    const changed = [1, 2, 3, 4, 5].some(
      (s) => seededShuffle(input.slice(), s).join() !== input.join(),
    );
    expect(changed).toBe(true);
  });
});
