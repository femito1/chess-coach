/**
 * Persistent + in-memory engine eval cache.
 *
 * The analysis queue re-encounters the same FEN constantly — every game in
 * a Sicilian shares the first 6+ plies, every endgame run of pawn moves
 * passes through positions other games hit, and re-analysis of the same
 * archive is a common user action. Caching `(fen, depth) -> AnalysisResult`
 * gives a large speedup for free, since Stockfish is fully deterministic
 * for a given depth (per the CLAUDE.md contract).
 *
 * Two layers:
 *   1) `inflight`: in-memory `Map<key, Promise>` so concurrent calls for
 *      the same position from different games coalesce into one engine
 *      job. Lives only for the lifetime of the page.
 *   2) `db.evalCache`: Dexie-backed table that survives reloads. Looked
 *      up first; on miss we dispatch to the pool and write back.
 *
 * A cached result at depth >= the requested depth satisfies the lookup,
 * so repeatedly bumping `engineDepth` doesn't keep paying full cost for
 * every position (only the ones whose deepest cached depth is too
 * shallow).
 *
 * `cachedAnalyze` keeps the same shape as `EnginePool.analyze`, so the
 * analyzer can swap one for the other at the call site.
 */

import { db, type EvalCacheEntry } from '@/db/schema';
import type { AnalysisResult } from './engine';
import { analysisPool } from './pool';

export { bookFenKey, buildBookSet, isBookFen } from './book';

function cacheKey(fen: string, depth: number): string {
  return `${fen}|${depth}`;
}

/** In-flight dedup: if two callers ask for the same (fen, depth) at once,
 *  only one engine job runs. Cleared per-entry once the promise settles. */
const inflight = new Map<string, Promise<AnalysisResult>>();

/** Hit/miss counters for the *current* page session. Read by the test
 *  script and could be surfaced in a debug panel later.
 *
 *  Stored on `globalThis` so divergent module instantiations (Vite's
 *  alias-vs-relative path resolution, HMR re-instantiation, dynamic
 *  imports from test scripts) all increment the same counters. Without
 *  this, a test that imports `cacheStats` directly while the analyzer
 *  imports it via `./cache` could read zeros even though the cache is
 *  actively being populated — see the eval-cache integration test. */
interface CacheStats {
  hits: number;
  misses: number;
  inflightCoalesced: number;
  bookSkips: number;
  evictions: number;
  reset(): void;
}
const STATS_KEY = '__chessCoachCacheStats';
function buildStats(): CacheStats {
  const s: CacheStats = {
    hits: 0,
    misses: 0,
    inflightCoalesced: 0,
    bookSkips: 0,
    evictions: 0,
    reset(): void {
      s.hits = 0;
      s.misses = 0;
      s.inflightCoalesced = 0;
      s.bookSkips = 0;
      s.evictions = 0;
    },
  };
  return s;
}
type GlobalThisWithStats = typeof globalThis & { [STATS_KEY]?: CacheStats };
const _g = globalThis as GlobalThisWithStats;
if (!_g[STATS_KEY]) _g[STATS_KEY] = buildStats();
export const cacheStats = _g[STATS_KEY];

/** Hard cap on persistent rows. Each row is small (a couple of hundred
 *  bytes) but unbounded growth still matters: IndexedDB usage
 *  contributes to the per-origin quota, and very large tables slow
 *  Dexie's first-load index hydration. Past this cap we evict the
 *  oldest rows (by `savedAt`) down to `EVAL_CACHE_TARGET_ROWS`. */
const EVAL_CACHE_MAX_ROWS = 50_000;
const EVAL_CACHE_TARGET_ROWS = 40_000;
/** Eviction is amortised: we only check the row count once every
 *  N writes to keep the steady-state cost negligible. */
const EVAL_CACHE_CHECK_INTERVAL = 200;
/** Touch-on-access: a hit refreshes its `savedAt` so the cache behaves
 *  as LRU instead of FIFO. We skip the write if the entry is younger
 *  than this threshold, so re-analysis of the same game during a
 *  session doesn't generate a write per FEN. */
const EVAL_CACHE_TOUCH_AFTER_MS = 60 * 60 * 1000;

function entryToResult(e: EvalCacheEntry): AnalysisResult {
  return {
    depth: e.depth,
    bestMoveUci: e.bestMoveUci,
    scoreCp: e.scoreCp,
    scoreMate: e.scoreMate,
    pv: e.pv,
  };
}

/**
 * Look up a cached result for `fen` whose stored depth is >= `depth`.
 * Returns null if no row exists or every existing row is shallower.
 *
 * We index by exact key first (the common case: same depth used by every
 * call from the queue); only on miss do we scan rows for this FEN to see
 * if a deeper result exists. The scan uses Dexie's `fen` index so it's
 * still O(rowsForFen) rather than a table scan.
 */
async function lookup(
  fen: string,
  depth: number,
): Promise<AnalysisResult | null> {
  const exact = await db.evalCache.get(cacheKey(fen, depth));
  if (exact) {
    void touchSavedAt(exact);
    return entryToResult(exact);
  }
  // Look for a deeper cached result for the same FEN.
  const deeper = await db.evalCache
    .where('fen')
    .equals(fen)
    .filter((e) => e.depth > depth)
    .first();
  if (deeper) {
    void touchSavedAt(deeper);
    return entryToResult(deeper);
  }
  return null;
}

/** Bump `savedAt` on a hit so the entry is preserved by LRU eviction.
 *  Throttled so a session that re-reads the same row repeatedly doesn't
 *  spam IDB writes. Best-effort — failures here are silent. */
async function touchSavedAt(entry: EvalCacheEntry): Promise<void> {
  const now = Date.now();
  if (now - entry.savedAt < EVAL_CACHE_TOUCH_AFTER_MS) return;
  try {
    await db.evalCache.update(entry.key, { savedAt: now });
  } catch {
    /* ignore — touch-on-access is purely a hint to the evictor */
  }
}

async function writeBack(
  fen: string,
  depth: number,
  result: AnalysisResult,
): Promise<void> {
  const entry: EvalCacheEntry = {
    key: cacheKey(fen, depth),
    fen,
    // We trust the pool's reported depth (may be slightly less than the
    // requested depth if a mate was found early) but never less than 1.
    depth: Math.max(1, result.depth || depth),
    bestMoveUci: result.bestMoveUci,
    scoreCp: result.scoreCp,
    scoreMate: result.scoreMate,
    // Cap the stored PV — long PVs blow row size up for marginal benefit.
    pv: result.pv ? result.pv.slice(0, 10) : [],
    savedAt: Date.now(),
  };
  try {
    await db.evalCache.put(entry);
    writesSinceLastEvict++;
    if (writesSinceLastEvict >= EVAL_CACHE_CHECK_INTERVAL) {
      writesSinceLastEvict = 0;
      void maybeEvict();
    }
  } catch (err) {
    // Cache writes are best-effort; never let a Dexie hiccup take down
    // the analysis pipeline. Log loudly the FIRST time a write fails so
    // a misconfigured / unmigrated DB doesn't silently turn the cache
    // into a no-op (we'd see analyses succeed but evalCache stay empty,
    // which is exactly the symptom we just hit while debugging).
    if (!writeBackWarned) {
      writeBackWarned = true;
      console.warn('[cache] evalCache write failed; cache is effectively disabled', err);
    }
  }
}
let writeBackWarned = false;
let writesSinceLastEvict = 0;
let evictionInFlight = false;

/** Evict oldest rows by `savedAt` once row count exceeds the hard cap.
 *  Single-flight: re-entrant calls coalesce so we never queue multiple
 *  big bulk-deletes. Best-effort — silent on failure. */
async function maybeEvict(): Promise<void> {
  if (evictionInFlight) return;
  evictionInFlight = true;
  try {
    const count = await db.evalCache.count();
    if (count <= EVAL_CACHE_MAX_ROWS) return;
    const toRemove = count - EVAL_CACHE_TARGET_ROWS;
    // Pull the oldest rows in one indexed scan (`savedAt` is indexed,
    // see schema v5) and delete them by primary key in bulk.
    const oldest = await db.evalCache
      .orderBy('savedAt')
      .limit(toRemove)
      .toArray();
    const keys = oldest.map((e) => e.key);
    if (keys.length > 0) {
      await db.evalCache.bulkDelete(keys);
      cacheStats.evictions += keys.length;
    }
  } catch (err) {
    // Eviction is non-critical; don't poison the cache pipeline.
    console.warn('[cache] evalCache eviction failed; cap may be exceeded temporarily', err);
  } finally {
    evictionInFlight = false;
  }
}

/**
 * Drop-in replacement for `pool.analyze(fen, depth)` that consults the
 * persistent cache + the in-flight map before dispatching to Stockfish.
 *
 * Always returns a fresh promise — multiple concurrent callers will
 * await the same shared promise but each get their own resolution.
 */
export function cachedAnalyze(
  fen: string,
  depth: number,
): Promise<AnalysisResult> {
  const key = cacheKey(fen, depth);
  const existing = inflight.get(key);
  if (existing) {
    cacheStats.inflightCoalesced++;
    return existing;
  }

  const p = (async () => {
    const cached = await lookup(fen, depth);
    if (cached) {
      cacheStats.hits++;
      return cached;
    }
    cacheStats.misses++;
    const result = await analysisPool().analyze(fen, depth);
    await writeBack(fen, depth, result);
    return result;
  })();

  inflight.set(key, p);
  // Always clear inflight when settled so a transient failure isn't
  // remembered forever.
  p.finally(() => {
    inflight.delete(key);
  }).catch(() => {});
  return p;
}

/* The book-position index lives in `./book` — re-exported above. */
