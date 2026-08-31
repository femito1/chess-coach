import type { PuzzleShardMeta } from '@/data/puzzles.meta.generated';
import { loadShard, type LibraryPuzzle } from './corpus';
import { puzzleMatchesMotif, type RecommendationPlan } from './recommend';

/**
 * Turns a tier (or a recommendation plan) into a served run of puzzles.
 *
 * Both builders take an injectable `load` so `queue.test.ts` can drive them
 * over synthetic shards with no network.
 *
 * Shards hold ~4k rows each, so neither builder loads more than it needs:
 * they pull one shard at a time and stop as soon as the requested count is
 * filled.
 */

export type ShardLoader = (shard: PuzzleShardMeta) => Promise<LibraryPuzzle[]>;

/** Position within a tier's shard list. Held by the page so successive
 *  `takeTierPuzzles` calls resume instead of rescanning from the start —
 *  which matters once a user has solved a few thousand puzzles and the
 *  early shards are mostly exhausted. */
export interface QueueCursor {
  shardIdx: number;
  rowIdx: number;
}

export const START_CURSOR: QueueCursor = { shardIdx: 0, rowIdx: 0 };

export interface TakeResult {
  puzzles: LibraryPuzzle[];
  cursor: QueueCursor;
  /** True when the shard list ran out before `count` was filled. */
  exhausted: boolean;
}

/**
 * Take the next `count` unsolved puzzles from a tier, in ascending rating
 * order.
 *
 * Ascending order is a deliberate UX choice, not an implementation detail.
 * Combined with skipping already-solved puzzles, it makes each tier a
 * ladder: you always face the easiest thing you haven't yet solved, and the
 * difficulty rises as you clear it. Serving a tier in random order would
 * give the same inventory a much worse learning curve.
 */
export async function takeTierPuzzles(args: {
  shards: readonly PuzzleShardMeta[];
  cursor: QueueCursor;
  count: number;
  /** Puzzles to skip — typically the ids solved cleanly already. */
  isExcluded: (id: string) => boolean;
  load?: ShardLoader;
}): Promise<TakeResult> {
  const { shards, count, isExcluded, load = loadShard } = args;
  const puzzles: LibraryPuzzle[] = [];
  let { shardIdx, rowIdx } = args.cursor;

  while (puzzles.length < count && shardIdx < shards.length) {
    const rows = await load(shards[shardIdx]);
    while (rowIdx < rows.length && puzzles.length < count) {
      const p = rows[rowIdx++];
      if (!isExcluded(p.id)) puzzles.push(p);
    }
    if (rowIdx >= rows.length) {
      shardIdx++;
      rowIdx = 0;
    }
  }

  return {
    puzzles,
    cursor: { shardIdx, rowIdx },
    exhausted: puzzles.length < count && shardIdx >= shards.length,
  };
}

/**
 * Build the Recommended run: puzzles matching the plan's motifs, drawn in
 * roughly the plan's per-motif proportions, inside its rating window.
 *
 * Two things differ from the tier ladder:
 *
 *  - **Shards are visited in a seeded shuffle**, not ascending order. The
 *    window is only ~5 bands wide, so ordering by rating inside it buys
 *    little, whereas visiting the same shard first every session would
 *    serve the same puzzles every session. Seeding (rather than
 *    `Math.random`) keeps it reproducible under test.
 *
 *  - **The result is interleaved across motifs** rather than grouped. If
 *    your two weakest motifs are forks and back-rank, a queue of 15 forks
 *    followed by 15 back-rankers is really two sessions; alternating them
 *    keeps you pattern-switching, which is the harder and more useful
 *    exercise.
 */
export async function buildRecommendedQueue(args: {
  plan: RecommendationPlan;
  shards: readonly PuzzleShardMeta[];
  isExcluded: (id: string) => boolean;
  seed: number;
  load?: ShardLoader;
}): Promise<LibraryPuzzle[]> {
  const { plan, shards, isExcluded, seed, load = loadShard } = args;
  if (plan.allocation.length === 0 || shards.length === 0) return [];

  const want = new Map(plan.allocation.map((a) => [a.motif, a.count]));
  const picked = new Map<string, LibraryPuzzle[]>(
    plan.allocation.map((a) => [a.motif, []]),
  );
  const takenIds = new Set<string>();
  const order = seededShuffle(shards.slice(), seed);

  for (const shard of order) {
    if (isPlanFilled(picked, want)) break;
    const rows = await load(shard);
    for (const p of rows) {
      if (takenIds.has(p.id) || isExcluded(p.id)) continue;
      if (p.rating < plan.ratingLo || p.rating > plan.ratingHi) continue;

      // Assign to the neediest matching motif, so a puzzle tagged both
      // `fork` and `pin` fills whichever bucket is furthest from target
      // instead of always the first listed.
      let best: { motif: string; deficit: number } | null = null;
      for (const a of plan.allocation) {
        if (!puzzleMatchesMotif(p.themes, a.motif)) continue;
        const deficit = (want.get(a.motif) ?? 0) - (picked.get(a.motif)?.length ?? 0);
        if (deficit <= 0) continue;
        if (!best || deficit > best.deficit) best = { motif: a.motif, deficit };
      }
      if (!best) continue;

      picked.get(best.motif)!.push(p);
      takenIds.add(p.id);
      if (isPlanFilled(picked, want)) break;
    }
  }

  return interleave([...picked.values()]);
}

function isPlanFilled(
  picked: Map<string, LibraryPuzzle[]>,
  want: Map<string, number>,
): boolean {
  for (const [motif, target] of want) {
    if ((picked.get(motif)?.length ?? 0) < target) return false;
  }
  return true;
}

/** Round-robin across buckets, skipping exhausted ones. Preserves each
 *  bucket's internal order. */
export function interleave<T>(buckets: readonly T[][]): T[] {
  const out: T[] = [];
  const max = Math.max(0, ...buckets.map((b) => b.length));
  for (let i = 0; i < max; i++) {
    for (const b of buckets) if (i < b.length) out.push(b[i]);
  }
  return out;
}

/**
 * Deterministic Fisher-Yates using mulberry32. In-place on the array given.
 *
 * A seeded PRNG rather than `Math.random` so the same seed reproduces the
 * same queue — which is what lets `queue.test.ts` assert on ordering, and
 * what would let a future "share this session" feature work.
 */
export function seededShuffle<T>(arr: T[], seed: number): T[] {
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
