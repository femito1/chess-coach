import {
  PUZZLE_SHARDS,
  RATING_MAX,
  RATING_MIN,
  type PuzzleShardMeta,
} from '@/data/puzzles.meta.generated';
import { loadShard, type LibraryPuzzle } from './corpus';
import { puzzleMatchesMotif, type RecommendationPlan } from './recommend';
import { themeCountInWindow } from './themeCatalog';

/**
 * Turns a rating window (or a recommendation plan) into a served run of
 * puzzles.
 *
 * Both builders take an injectable `load` so `queue.test.ts` can drive them
 * over synthetic shards with no network.
 *
 * Shards hold ~4k rows each, so neither builder loads more than it needs:
 * they pull one shard at a time and stop as soon as the requested count is
 * filled.
 */

export type ShardLoader = (shard: PuzzleShardMeta) => Promise<LibraryPuzzle[]>;

/**
 * Rating window for a Train run.
 *
 * Starts narrow — ±60 around the target, so "Normal" really means puzzles
 * at your level rather than a 600-point tier — and widens only as far as
 * the theme needs to fill a few runs. Mixed puzzles never widen (every
 * 100-point band holds ~8k); `forks` at 1500 doesn't either (~1.7k per
 * band); `smotheredMate` at 1800 has ~6 per band, so it widens until it
 * finds enough, and the UI says so rather than quietly serving 1100s.
 *
 * Widening is decided from the bundled per-band theme index, before any
 * shard is fetched — finding out by loading shards one ~400 KB file at a
 * time is what this replaces.
 */
export const TRAIN_HALF_WINDOWS: readonly number[] = [60, 100, 150, 250, 400, 700, 1300];

export function windowForTheme(args: {
  center: number;
  theme: string | null;
  /** Puzzles the window should hold at minimum. */
  want: number;
}): { lo: number; hi: number; widened: boolean } {
  const center = Math.max(RATING_MIN, Math.min(RATING_MAX, Math.round(args.center)));
  let lo = center;
  let hi = center;
  for (const half of TRAIN_HALF_WINDOWS) {
    lo = Math.max(RATING_MIN, center - half);
    hi = Math.min(RATING_MAX, center + half);
    if (themeCountInWindow(args.theme, lo, hi) >= args.want) {
      return { lo, hi, widened: half > TRAIN_HALF_WINDOWS[0] };
    }
  }
  return { lo, hi, widened: true };
}

/**
 * Draw `count` unattempted puzzles from a rating window, optionally of one
 * theme, in random order.
 *
 * Random rather than ascending: the old tier ladder served each tier
 * easiest-first, which inside a 600-point tier was a real learning curve.
 * Inside a ±60 window it would just mean always getting the same corner of
 * it. Shards are visited in a seeded shuffle and loading stops once the
 * pool can fill the run, so the common case is a single shard fetch.
 */
export async function buildTrainQueue(args: {
  lo: number;
  hi: number;
  theme: string | null;
  count: number;
  isExcluded: (id: string) => boolean;
  seed: number;
  /** Defaults to the shipped manifest; tests pass synthetic shards. */
  shards?: readonly PuzzleShardMeta[];
  load?: ShardLoader;
}): Promise<LibraryPuzzle[]> {
  const { lo, hi, theme, count, isExcluded, seed, load = loadShard } = args;
  const shards = seededShuffle(
    (args.shards ?? PUZZLE_SHARDS).filter((s) => s.maxRating >= lo && s.minRating <= hi).slice(),
    seed,
  );
  const pool: LibraryPuzzle[] = [];
  for (const shard of shards) {
    if (pool.length >= count) break;
    for (const p of await load(shard)) {
      if (p.rating < lo || p.rating > hi) continue;
      if (theme && !p.themes.includes(theme)) continue;
      if (isExcluded(p.id)) continue;
      pool.push(p);
    }
  }
  return seededShuffle(pool, seed ^ 0x9e3779b9).slice(0, count);
}

/**
 * Build the "From your games" run: puzzles matching the plan's motifs,
 * drawn in roughly the plan's per-motif proportions, inside its rating
 * window. Shards are visited in a seeded shuffle, as in `buildTrainQueue`.
 *
 * The result is **interleaved across motifs** rather than grouped. If your
 * two weakest motifs are forks and back-rank, a queue of 15 forks followed
 * by 15 back-rankers is really two sessions; alternating them keeps you
 * pattern-switching, which is the harder and more useful exercise.
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
