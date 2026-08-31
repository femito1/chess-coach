import {
  EngineWorker,
  type AnalysisResult,
  type EngineObservation,
} from './engine';

type PoolObserver = (obs: EngineObservation, workerIndex: number) => void;

/**
 * Pool of independent Stockfish workers used to parallelize game
 * analysis. Each worker is its own UCI session and runs in its own
 * Web Worker, so a 4-worker pool roughly quadruples per-game throughput
 * on multi-core machines.
 *
 * The pool is *strictly* in-order from the caller's perspective:
 * `analyzeMany([fen0, fen1, fen2, ...])` returns `[result0, result1,
 * result2, ...]` even though the workers process them concurrently.
 * That keeps the caller's per-move bookkeeping simple.
 *
 * We don't try to split *one* request across multiple workers (no
 * MultiPV merging) — the throughput win comes from packing many
 * positions rather than making any one position faster.
 */

/** How many workers to spawn by default. We cap at 4: the marginal
 *  benefit drops sharply past that for single-threaded Stockfish, and
 *  the WASM memory cost is non-trivial (~30 MB / worker). */
const DEFAULT_POOL_SIZE = (() => {
  if (typeof navigator === 'undefined') return 2;
  const cores = navigator.hardwareConcurrency || 4;
  // Leave at least 2 cores for the UI thread + browser. 4 workers is a
  // good stopping point — past that, scheduling overhead and WASM
  // memory usage start to hurt more than the parallelism helps.
  return Math.max(1, Math.min(4, Math.floor((cores - 1) / 1)));
})();

export class EnginePool {
  private workers: EngineWorker[];
  /** Maximum number of workers this pool will spin up on demand. We keep
   *  this around even after `terminate()` so the pool can self-rehydrate
   *  when a new analyze() call comes in. Mutable so the queue can shrink
   *  the pool when the tab goes hidden — see `setMaxWorkers`. */
  private maxWorkers: number;
  /** FIFO of pending tasks waiting for a free worker. */
  private queue: Array<{
    fen: string;
    depth: number;
    resolve: (r: AnalysisResult) => void;
    reject: (e: unknown) => void;
  }> = [];
  /** Whether each worker is currently running a task. Length matches
   *  `workers` exactly. */
  private busy: boolean[];
  /** Per-worker disposers for the cockpit observation forwarder. We
   *  re-subscribe on every freshly spawned worker so the cockpit
   *  store keeps receiving events across pool teardown / rehydration. */
  private workerObsDisposers: Array<() => void>;
  /** Long-lived consumers that want to see every `info` line from
   *  every worker in this pool. The cockpit store registers exactly
   *  one observer here. */
  private poolObservers: Set<PoolObserver>;

  constructor(size: number = DEFAULT_POOL_SIZE) {
    this.maxWorkers = size;
    // Workers are created lazily — `EngineWorker` is cheap to construct
    // (no Worker spawned until the first `analyze` / `newGame`), but
    // there's no reason to even hold the wrapper objects when nothing
    // is running. The pool starts empty and grows on demand inside
    // `pump()` up to `maxWorkers`.
    this.workers = [];
    this.busy = [];
    this.workerObsDisposers = [];
    this.poolObservers = new Set();
  }

  /**
   * Subscribe to live engine activity from every worker in this pool.
   * The observer fires for `start` / `info` / `done` events on every
   * `analyze()` call across every worker, with the worker's index in
   * the pool tagged on each event so a UI consumer can decide whether
   * to track per-worker state or just collapse to "any active worker".
   *
   * Returns an unsubscribe function. Cheap; the pool only attaches
   * per-worker observation forwarders when `poolObservers.size > 0`.
   *
   * Subscription survives pool teardown / rehydration: if a fresh
   * worker is spawned later, the pool re-attaches automatically so
   * the consumer keeps receiving events without re-subscribing.
   */
  observe(cb: PoolObserver): () => void {
    this.poolObservers.add(cb);
    // First subscriber: attach forwarders for any workers that already
    // exist. Subsequent subscribers get free piggybacking.
    if (this.poolObservers.size === 1) {
      for (let i = 0; i < this.workers.length; i++) {
        this.attachWorkerObserver(i);
      }
    }
    return () => {
      this.poolObservers.delete(cb);
      if (this.poolObservers.size === 0) {
        // Tear down the per-worker forwarders too, so an idle pool
        // with no consumers carries no observation overhead at all.
        for (const d of this.workerObsDisposers) d();
        this.workerObsDisposers = [];
      }
    };
  }

  private attachWorkerObserver(idx: number): void {
    if (this.poolObservers.size === 0) return;
    const w = this.workers[idx];
    if (!w) return;
    const dispose = w.addInfoListener((obs) => {
      for (const o of this.poolObservers) o(obs, idx);
    });
    this.workerObsDisposers[idx] = dispose;
  }

  private detachWorkerObserver(idx: number): void {
    const dispose = this.workerObsDisposers[idx];
    if (dispose) {
      dispose();
      this.workerObsDisposers[idx] = () => {};
    }
  }

  /** Number of underlying workers currently held (may be 0 if the pool
   *  was torn down by `terminate()` and no analyze() has hit it since). */
  /**
   * Evaluator identity of the pool's workers, for `Analysis.engine`.
   *
   * All workers run the same build, so worker 0 speaks for the pool. Returns
   * the classical label before any handshake has completed, which matches what
   * the bundled build actually does — see `EngineWorker.evaluatorId`.
   */
  evaluatorId(): string {
    return this.workers[0]?.evaluatorId() ?? 'stockfish-16-classical';
  }

  get size(): number {
    return this.workers.length;
  }

  /** Maximum size this pool will grow to on demand. */
  get capacity(): number {
    return this.maxWorkers;
  }

  /**
   * Resize the pool's worker cap. Used by the tab-visibility throttle:
   * when `document.visibilityState === 'hidden'` we shrink to 1 to keep
   * the tab cool / save battery, and restore the prior size when the
   * user comes back.
   *
   * Behaviour:
   *  - Cap is clamped to >= 1 (a 0-sized pool would deadlock `pump`).
   *  - If the new cap is *smaller* than the current spawned-worker
   *    count, idle workers above the cap are terminated immediately.
   *    Busy workers keep running their current task and are released
   *    on the next `pump()` cycle (we can't safely cancel mid-analyze
   *    without leaving the FEN/PV state in `lastInfo` partially-parsed).
   *  - If the new cap is *larger*, nothing happens until the next
   *    `pump()` — workers are spawned lazily.
   *
   * Idempotent. No-op if the cap doesn't actually change.
   */
  setMaxWorkers(n: number): void {
    const next = Math.max(1, Math.floor(n));
    if (next === this.maxWorkers) return;
    this.maxWorkers = next;
    if (this.workers.length <= next) return;
    // Terminate idle workers down to the new cap. Busy ones get
    // released by `pump()` after their current job lands.
    for (let i = this.workers.length - 1; i >= next; i--) {
      if (!this.busy[i]) {
        this.detachWorkerObserver(i);
        this.workers[i].terminate();
        this.workers.splice(i, 1);
        this.busy.splice(i, 1);
        this.workerObsDisposers.splice(i, 1);
      }
    }
  }

  /** Whether the pool currently has no in-flight tasks AND no queued
   *  ones. Idle pools are safe to `terminate()` — see queue.ts which
   *  calls this opportunistically. */
  isIdle(): boolean {
    return this.queue.length === 0 && this.busy.every((b) => !b);
  }

  /** Reset every worker for a fresh game. Done in parallel so the cost
   *  is the slowest single worker, not the sum. */
  async newGame(): Promise<void> {
    if (this.workers.length === 0) return;
    await Promise.all(this.workers.map((w) => w.newGame()));
  }

  /** Analyze a single position by claiming the next free worker. Resolves
   *  with the analysis result; never throws unless the worker errored. */
  analyze(fen: string, depth: number): Promise<AnalysisResult> {
    return new Promise<AnalysisResult>((resolve, reject) => {
      this.queue.push({ fen, depth, resolve, reject });
      this.pump();
    });
  }

  /**
   * Analyze a batch of positions concurrently and return the results in
   * the SAME order as the input. Internally this is just a `Promise.all`
   * of `analyze` calls — useful as a single, easy-to-spot call site for
   * the analyzer.
   */
  analyzeMany(
    requests: Array<{ fen: string; depth: number }>,
  ): Promise<AnalysisResult[]> {
    return Promise.all(requests.map((r) => this.analyze(r.fen, r.depth)));
  }

  /**
   * Mark the slot currently held by `worker` as free.
   *
   * Looked up by identity rather than by an index captured at dispatch
   * time, because `setMaxWorkers` *splices* `workers`/`busy` and so
   * renumbers every worker above a removed slot. A task dispatched to
   * index 2 that finishes after the pool shrank to 2 workers used to
   * clear `busy[2]` — writing past the end of the array, leaving its own
   * slot stuck `true` forever. That worker then never returned to
   * rotation, `isIdle()` could never become true (so idle teardown never
   * freed the ~30 MB WASM heap), and once enough slots leaked
   * `busy.indexOf(false)` returned an index past `workers`, making
   * `pump()` call `.analyze()` on `undefined` — which surfaced to the
   * user as a spuriously errored game.
   *
   * A worker that was terminated while busy is simply absent here, so
   * there's nothing to release and no stale write.
   */
  private release(worker: EngineWorker): void {
    const idx = this.workers.indexOf(worker);
    if (idx !== -1) this.busy[idx] = false;
  }

  /** Try to dispatch as many queued tasks as there are free workers.
   *  Called whenever a task is enqueued or finishes. Lazily grows the
   *  pool up to `maxWorkers` so torn-down pools (post-idle teardown)
   *  rehydrate transparently on the next analyze() call. */
  private pump(): void {
    while (this.queue.length > 0) {
      let idx = this.busy.indexOf(false);
      if (idx === -1) {
        // No free worker — try to spin up a new one if we're under cap.
        if (this.workers.length < this.maxWorkers) {
          this.workers.push(new EngineWorker());
          this.busy.push(false);
          this.workerObsDisposers.push(() => {});
          idx = this.workers.length - 1;
          // Hook the new worker up to any in-flight cockpit observer.
          this.attachWorkerObserver(idx);
        } else {
          return;
        }
      }
      const task = this.queue.shift()!;
      this.busy[idx] = true;
      const worker = this.workers[idx];
      worker.analyze(task.fen, task.depth).then(
        (res) => {
          // Release by worker *identity*, not by the captured index —
          // see `release`. Flipped before resolving so an awaiter
          // checking `pool.isIdle()` immediately after
          // `await pool.analyze()` sees the post-completion state.
          this.release(worker);
          task.resolve(res);
          this.pump();
        },
        (err) => {
          this.release(worker);
          task.reject(err);
          this.pump();
        },
      );
    }
  }

  /** Tear down every worker. Used both by `terminate()` (called from
   *  test cleanup) and by the queue's idle-teardown path (releases the
   *  ~30 MB / worker WASM heap when there's nothing to analyze). The
   *  pool transparently rehydrates on the next `analyze()` call. */
  terminate(): void {
    for (const d of this.workerObsDisposers) d();
    this.workerObsDisposers = [];
    for (const w of this.workers) w.terminate();
    this.workers = [];
    this.busy = [];
    // Reject any stragglers so callers don't await forever.
    for (const t of this.queue) t.reject(new Error('pool terminated'));
    this.queue = [];
    // Note: `poolObservers` is intentionally NOT cleared. The pool's
    // observe() contract is that subscriptions survive worker teardown
    // / rehydration so the cockpit store keeps its single subscription
    // across the analyzer's idle teardown cycles. The next pump()
    // re-attaches forwarders when a new worker is spawned.
  }

  /** Shut down workers if (and only if) the pool is idle. No-op
   *  otherwise. Returns true if workers were actually freed. */
  terminateIfIdle(): boolean {
    if (!this.isIdle() || this.workers.length === 0) return false;
    for (const d of this.workerObsDisposers) d();
    this.workerObsDisposers = [];
    for (const w of this.workers) w.terminate();
    this.workers = [];
    this.busy = [];
    return true;
  }
}

/** Default pool used by the analysis queue. Lazy-initialized on first
 *  use so the workers don't spin up just because the bundle loaded.
 *
 *  Stored on `globalThis` rather than module-scoped so that even if
 *  Vite / HMR / divergent import paths instantiate this module more
 *  than once at runtime, every consumer agrees on a single pool. The
 *  singleton invariant matters: the analysis queue calls
 *  `setMaxWorkers(1)` from a visibility listener and the live-eval
 *  consumers grab the same pool via `analysisPool()`, so two pools
 *  would mean visibility throttling silently doesn't work. */
const POOL_KEY = '__chessCoachAnalysisPool';
type GlobalThisWithPool = typeof globalThis & { [POOL_KEY]?: EnginePool };
export function analysisPool(): EnginePool {
  const g = globalThis as GlobalThisWithPool;
  if (!g[POOL_KEY]) g[POOL_KEY] = new EnginePool();
  return g[POOL_KEY];
}
