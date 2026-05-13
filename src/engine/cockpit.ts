/**
 * Engine cockpit store — the live "Stockfish is thinking" feed that
 * powers `<EngineCockpit>`. The component on the import-and-review
 * page (and the review page's "still analyzing" placeholder) reads
 * from this store and renders the engine's brain in real time:
 * depth iterations, score, NPS, the current PV, the position being
 * analyzed.
 *
 * Design:
 *   - Single zustand store. Subscribed via the pool's `observe()` API
 *     once, lazily on first consumer mount; unsubscribed when the last
 *     consumer unmounts (ref-counted via `attachCockpit` /
 *     `detachCockpit`).
 *   - Per-worker tracking. The pool tags each event with a `workerIndex`
 *     so we keep a small slot map; the UI typically renders only the
 *     "freshest" slot (most recently updated) but power users can be
 *     shown every active worker if we want to.
 *   - 10 Hz throttle on info-event writes. Stockfish emits info lines
 *     at ~50–200 Hz at search depth; rendering each one would melt
 *     React's reconciler. We aggregate the latest info per worker
 *     between flushes and emit a single setState batch at most every
 *     `THROTTLE_MS` milliseconds. Lifecycle events (start / done) are
 *     never throttled — they need to land synchronously so the UI's
 *     "thinking → just-finished" transition isn't laggy.
 *   - Pure-logic: this module is callable from a unit test runtime
 *     because it doesn't touch the DOM or IndexedDB. The actual
 *     subscription wiring lives in `attachCockpit()` and is gated on
 *     `typeof window !== 'undefined'` so node-only consumers aren't
 *     affected.
 */

import { create } from 'zustand';
import { analysisPool } from './pool';
import { cacheStats } from './cache';
import type { EngineObservation, InfoLine } from './engine';

/**
 * Snapshot of the global `cacheStats` counters at a point in time.
 * The cockpit takes a snapshot when it mounts so it can render
 * deltas since the user entered the analysis-waiting flow ("X of Y
 * positions found in cache, Z book moves skipped"). Without this
 * delta the global counters would include every cache hit since the
 * page loaded — meaningless to the user. */
export interface CacheStatsSnapshot {
  hits: number;
  misses: number;
  bookSkips: number;
  inflightCoalesced: number;
}

export function snapshotCacheStats(): CacheStatsSnapshot {
  return {
    hits: cacheStats.hits,
    misses: cacheStats.misses,
    bookSkips: cacheStats.bookSkips,
    inflightCoalesced: cacheStats.inflightCoalesced,
  };
}

export function diffCacheStats(
  prev: CacheStatsSnapshot,
  curr: CacheStatsSnapshot,
): CacheStatsSnapshot {
  return {
    hits: Math.max(0, curr.hits - prev.hits),
    misses: Math.max(0, curr.misses - prev.misses),
    bookSkips: Math.max(0, curr.bookSkips - prev.bookSkips),
    inflightCoalesced: Math.max(0, curr.inflightCoalesced - prev.inflightCoalesced),
  };
}

/** Per-worker snapshot of the latest engine activity. */
export interface CockpitSlot {
  /** Pool index of the worker. Slot identity. */
  workerIndex: number;
  /** FEN currently being analyzed by this worker, or `null` between jobs. */
  fen: string | null;
  /** Requested depth for the current job (target). */
  requestedDepth: number;
  /** Latest reached depth from `info depth N`. */
  depth: number;
  /** Latest selective-search depth. */
  seldepth: number;
  /** Score in centipawns from the side-to-move's perspective. */
  scoreCp: number | null;
  /** Mate distance from the side-to-move's perspective. */
  scoreMate: number | null;
  /** Latest PV (first 12 plies, in UCI). The component derives SAN
   *  on demand via `formatPv` — keeping UCI in the store means the
   *  zustand state doesn't churn the SAN strings on every depth bump. */
  pvUci: string[];
  /** Latest NPS reading. */
  nps: number;
  /** Latest node count. */
  nodes: number;
  /** Wallclock ms from the engine's `info time` field — useful as a
   *  "this engine has been thinking for X seconds" indicator. */
  time: number;
  /** Monotonic timestamp of the last update. The view picks the
   *  freshest slot for the headline display. */
  lastUpdate: number;
}

interface CockpitState {
  /** Per-worker slots, keyed by `workerIndex`. Slots persist across
   *  start/done cycles — they're cleared only when the pool itself is
   *  torn down by the cockpit's detach. */
  slots: Record<number, CockpitSlot>;
  /** True iff at least one consumer has called `attachCockpit()` and
   *  hasn't detached yet. Drives the lazy subscription. */
  attached: boolean;
}

/** How often (ms) we flush throttled `info` updates into the zustand
 *  store. 100 ms = 10 Hz, well below human flicker fusion but small
 *  enough that depth iterations feel instantaneous. */
const THROTTLE_MS = 100;

export const useEngineCockpitStore = create<CockpitState>(() => ({
  slots: {},
  attached: false,
}));

/** Pending throttled updates per worker. We accumulate the latest
 *  event-derived slot here; on the next tick of the throttle timer
 *  we write the merged result into the zustand store as a single
 *  batched setState. */
const pendingByWorker = new Map<number, CockpitSlot>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let unsubscribePool: (() => void) | null = null;
let consumerCount = 0;

function scheduleFlush(): void {
  if (flushTimer != null) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    if (pendingByWorker.size === 0) return;
    useEngineCockpitStore.setState((s) => {
      const slots = { ...s.slots };
      for (const [idx, slot] of pendingByWorker) {
        slots[idx] = slot;
      }
      pendingByWorker.clear();
      return { slots };
    });
  }, THROTTLE_MS);
}

/** Merge an incoming InfoLine into a slot snapshot. Pure. */
export function applyInfo(
  prev: CockpitSlot | undefined,
  workerIndex: number,
  fen: string | null,
  requestedDepth: number,
  info: InfoLine,
  now: number,
): CockpitSlot {
  const base: CockpitSlot = prev ?? {
    workerIndex,
    fen,
    requestedDepth,
    depth: 0,
    seldepth: 0,
    scoreCp: null,
    scoreMate: null,
    pvUci: [],
    nps: 0,
    nodes: 0,
    time: 0,
    lastUpdate: now,
  };
  return {
    ...base,
    workerIndex,
    fen,
    requestedDepth,
    depth: info.depth ?? base.depth,
    seldepth: info.seldepth ?? base.seldepth,
    scoreCp: info.scoreCp != null ? info.scoreCp : base.scoreCp,
    scoreMate: info.scoreMate != null ? info.scoreMate : base.scoreMate,
    pvUci: info.pv && info.pv.length > 0 ? info.pv.slice(0, 12) : base.pvUci,
    nps: info.nps ?? base.nps,
    nodes: info.nodes ?? base.nodes,
    time: info.time ?? base.time,
    lastUpdate: now,
  };
}

/** Reset a slot for a freshly-started job. Pure. */
export function resetSlotForStart(
  workerIndex: number,
  fen: string | null,
  requestedDepth: number,
  now: number,
): CockpitSlot {
  return {
    workerIndex,
    fen,
    requestedDepth,
    depth: 0,
    seldepth: 0,
    scoreCp: null,
    scoreMate: null,
    pvUci: [],
    nps: 0,
    nodes: 0,
    time: 0,
    lastUpdate: now,
  };
}

function handleObservation(obs: EngineObservation, workerIndex: number): void {
  const now = Date.now();
  if (obs.kind === 'start') {
    // Lifecycle events flush synchronously so a "this worker just
    // started a new job" transition lands on the next paint without
    // waiting for the throttle.
    pendingByWorker.delete(workerIndex);
    useEngineCockpitStore.setState((s) => ({
      slots: {
        ...s.slots,
        [workerIndex]: resetSlotForStart(
          workerIndex,
          obs.fen,
          obs.requestedDepth,
          now,
        ),
      },
    }));
    return;
  }
  if (obs.kind === 'done') {
    // Mark the slot's fen as null so the component knows this worker
    // is between jobs; we keep the depth/score so the last-seen
    // numbers don't blink to zero before the next start.
    pendingByWorker.delete(workerIndex);
    useEngineCockpitStore.setState((s) => {
      const prev = s.slots[workerIndex];
      if (!prev) return s;
      return {
        slots: {
          ...s.slots,
          [workerIndex]: { ...prev, fen: null, lastUpdate: now },
        },
      };
    });
    return;
  }
  // info — throttled.
  const prev = pendingByWorker.get(workerIndex) ?? useEngineCockpitStore.getState().slots[workerIndex];
  const next = applyInfo(
    prev,
    workerIndex,
    obs.fen,
    obs.requestedDepth,
    obs.info ?? {},
    now,
  );
  pendingByWorker.set(workerIndex, next);
  scheduleFlush();
}

/**
 * Subscribe to the pool's observation stream. Ref-counted so multiple
 * consumers (e.g. the import-and-review page AND the review page
 * cockpit) share a single underlying subscription — and the pool
 * keeps zero observation overhead when no one is watching.
 *
 * Returns a detach function. Idempotent under repeated calls only via
 * matched `attach`/`detach` pairs.
 */
export function attachCockpit(): () => void {
  consumerCount += 1;
  if (consumerCount === 1) {
    useEngineCockpitStore.setState({ attached: true });
    unsubscribePool = analysisPool().observe(handleObservation);
  }
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    consumerCount = Math.max(0, consumerCount - 1);
    if (consumerCount === 0) {
      if (unsubscribePool) {
        unsubscribePool();
        unsubscribePool = null;
      }
      // Clear the slots map so a future re-attach starts fresh.
      useEngineCockpitStore.setState({ attached: false, slots: {} });
      pendingByWorker.clear();
      if (flushTimer != null) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
    }
  };
}

/**
 * Pick the "freshest" slot — the one whose `lastUpdate` is most recent
 * AND whose `fen` is non-null (i.e. actively analyzing). Useful for the
 * cockpit's headline view, which collapses an N-worker pool to a
 * single dominant feed.
 *
 * Returns null when no worker is currently active.
 */
export function freshestActiveSlot(
  slots: Record<number, CockpitSlot>,
): CockpitSlot | null {
  let best: CockpitSlot | null = null;
  for (const slot of Object.values(slots)) {
    if (slot.fen == null) continue;
    if (!best || slot.lastUpdate > best.lastUpdate) best = slot;
  }
  return best;
}
