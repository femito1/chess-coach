import {
  BAND_WIDTH,
  PUZZLE_BUILD_ID,
  PUZZLE_SHARDS,
  PUZZLE_THEMES,
  PUZZLE_TIERS,
  RATING_MIN,
  type PuzzleShardMeta,
} from '@/data/puzzles.meta.generated';

/**
 * Read access to the bundled Lichess puzzle corpus.
 *
 * The corpus ships as content-hashed TSV shards under
 * `public/puzzles/<buildId>/`, ~4k puzzles each, pre-sorted by rating.
 * This module fetches them on demand and decodes rows; it holds no React
 * state and does no scheduling (see `queue.ts` for that).
 *
 * Why shards over HTTP rather than a Dexie table: the shards are immutable
 * and served `Cache-Control: immutable`, so the browser cache already is
 * the persistence layer. Copying ~20 MB into IndexedDB would duplicate all
 * of it and force a migration every time the corpus is refreshed.
 *
 * Everything the build script pre-computes, the runtime doesn't do:
 * positions are already post-`Moves[0]` (see `build-puzzles.mjs` for that
 * trap), and rows are already in ascending rating order, so "ordered by
 * difficulty" needs no sort here.
 */

export interface LibraryPuzzle {
  /** Lichess puzzle id. Also the key into `puzzleAttempts`. */
  id: string;
  /** Position the user is asked to solve — already has the opponent's
   *  move into the puzzle applied. Side to move is the solver. */
  fen: string;
  /** Solver's moves first, alternating with opponent replies. Feed
   *  straight to `applyPuzzleMove`. */
  solution: string[];
  rating: number;
  /** Decoded Lichess theme names. Must stay hidden until the puzzle is
   *  solved — the theme is the answer. */
  themes: string[];
}

export type TierId = 'easy' | 'medium' | 'hard' | 'all';

/* =======================================================================
 *  Shard fetching
 * =======================================================================
 */

/** Vite rewrites `BASE_URL` for the GitHub-Pages build (`/chess-coach/`),
 *  so shard URLs must be built from it rather than hard-coded to `/`. */
const BASE = import.meta.env.BASE_URL ?? '/';

export function shardUrl(shard: PuzzleShardMeta): string {
  const base = BASE.endsWith('/') ? BASE : `${BASE}/`;
  return `${base}puzzles/${PUZZLE_BUILD_ID}/b${shard.band}-${shard.n}.tsv`;
}

export function shardKey(shard: PuzzleShardMeta): string {
  return `b${shard.band}-${shard.n}`;
}

/**
 * Decode a shard body. Pure, so `corpus.test.ts` can exercise it without
 * a network.
 *
 * Row format (tab-separated, see `build-puzzles.mjs`):
 *   id \t fen \t space-joined-solution \t rating \t theme-codes
 *
 * Theme codes are fixed-width 2-char base36 indices into `PUZZLE_THEMES`.
 * Malformed rows are skipped rather than thrown on: a single bad row
 * shouldn't blank a whole tab.
 */
export function parseShard(text: string): LibraryPuzzle[] {
  const out: LibraryPuzzle[] = [];
  for (const line of text.split('\n')) {
    if (line.length === 0) continue;
    const cols = line.split('\t');
    if (cols.length < 5) continue;
    const [id, fen, sol, ratingRaw, themeCodes] = cols;
    const rating = Number(ratingRaw);
    if (!id || !fen || !sol || !Number.isFinite(rating)) continue;
    out.push({
      id,
      fen,
      solution: sol.split(' ').filter(Boolean),
      rating,
      themes: decodeThemeCodes(themeCodes ?? ''),
    });
  }
  return out;
}

export function decodeThemeCodes(codes: string): string[] {
  const out: string[] = [];
  for (let i = 0; i + 2 <= codes.length; i += 2) {
    const name = PUZZLE_THEMES[parseInt(codes.slice(i, i + 2), 36)];
    if (name) out.push(name);
  }
  return out;
}

/** Decoded shards, capped. Shards are ~4k rows / ~1 MB of JS objects each,
 *  so we keep only a handful resident and let the HTTP cache absorb
 *  re-fetches (which are disk-speed, and free of a network round trip). */
const CACHE_LIMIT = 6;
const cache = new Map<string, LibraryPuzzle[]>();
/** In-flight requests, so two tabs mounting at once don't double-fetch. */
const inFlight = new Map<string, Promise<LibraryPuzzle[]>>();

export async function loadShard(shard: PuzzleShardMeta): Promise<LibraryPuzzle[]> {
  const key = shardKey(shard);

  const hit = cache.get(key);
  if (hit) {
    // Refresh LRU position.
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }

  const pending = inFlight.get(key);
  if (pending) return pending;

  const req = (async () => {
    const res = await fetch(shardUrl(shard));
    if (!res.ok) {
      throw new Error(
        `puzzle shard ${key} failed: ${res.status} ${res.statusText}. ` +
          `Run \`npm run puzzles:build\` if public/puzzles/ is missing.`,
      );
    }
    const rows = parseShard(await res.text());
    cache.set(key, rows);
    while (cache.size > CACHE_LIMIT) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
    return rows;
  })().finally(() => inFlight.delete(key));

  inFlight.set(key, req);
  return req;
}

/** Test seam — drops all cached shards. */
export function __clearShardCache(): void {
  cache.clear();
  inFlight.clear();
}

/* =======================================================================
 *  Tiers + shard selection
 * =======================================================================
 */

function tierBounds(tier: TierId): { min: number; max: number } {
  if (tier === 'all') return { min: 0, max: Infinity };
  let lower = 0;
  for (const t of PUZZLE_TIERS) {
    const upper = t.maxExclusive ?? Infinity;
    if (t.id === tier) return { min: lower, max: upper };
    lower = upper;
  }
  return { min: 0, max: Infinity };
}

/** Inclusive rating range actually present in a tier's shards, for UI
 *  labels. Derived from the manifest so a label can never claim a range
 *  the corpus doesn't hold. Returns null for an empty tier. */
export function tierRatingRange(tier: TierId): { lo: number; hi: number } | null {
  const shards = shardsForTier(tier);
  if (shards.length === 0) return null;
  let lo = Infinity;
  let hi = -Infinity;
  for (const s of shards) {
    if (s.minRating < lo) lo = s.minRating;
    if (s.maxRating > hi) hi = s.maxRating;
  }
  return { lo, hi };
}

export function tierPuzzleCount(tier: TierId): number {
  return shardsForTier(tier).reduce((a, s) => a + s.rows, 0);
}

/**
 * Shards belonging to a tier, in ascending difficulty order.
 *
 * A shard is included when its rating span overlaps the tier at all. Band
 * width (100) is much narrower than any tier, and tier edges are multiples
 * of 100, so in practice shards don't straddle a boundary — the overlap
 * test is just belt-and-braces against a future tier edge that isn't
 * band-aligned.
 */
export function shardsForTier(tier: TierId): PuzzleShardMeta[] {
  const { min, max } = tierBounds(tier);
  return PUZZLE_SHARDS.filter((s) => s.maxRating >= min && s.minRating < max).slice();
}

/** Shards overlapping an explicit rating window, ascending. Used by the
 *  Recommended queue, which targets a band around the user's strength
 *  rather than a fixed tier. */
export function shardsForRatingWindow(lo: number, hi: number): PuzzleShardMeta[] {
  return PUZZLE_SHARDS.filter((s) => s.maxRating >= lo && s.minRating <= hi).slice();
}

export function bandRatingRange(band: number): { lo: number; hi: number } {
  const lo = RATING_MIN + band * BAND_WIDTH;
  return { lo, hi: lo + BAND_WIDTH - 1 };
}

export function tierForRating(rating: number): Exclude<TierId, 'all'> {
  for (const t of PUZZLE_TIERS) {
    if (rating < (t.maxExclusive ?? Infinity)) return t.id as Exclude<TierId, 'all'>;
  }
  return 'hard';
}
