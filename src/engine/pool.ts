import { EngineWorker, type AnalysisResult } from './engine';

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
   *  when a new analyze() call comes in. */
  private readonly maxWorkers: number;
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

  constructor(size: number = DEFAULT_POOL_SIZE) {
    this.maxWorkers = size;
    // Workers are created lazily — `EngineWorker` is cheap to construct
    // (no Worker spawned until the first `analyze` / `newGame`), but
    // there's no reason to even hold the wrapper objects when nothing
    // is running. The pool starts empty and grows on demand inside
    // `pump()` up to `maxWorkers`.
    this.workers = [];
    this.busy = [];
  }

  /** Number of underlying workers currently held (may be 0 if the pool
   *  was torn down by `terminate()` and no analyze() has hit it since). */
  get size(): number {
    return this.workers.length;
  }

  /** Maximum size this pool will grow to on demand. */
  get capacity(): number {
    return this.maxWorkers;
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
          idx = this.workers.length - 1;
        } else {
          return;
        }
      }
      const task = this.queue.shift()!;
      this.busy[idx] = true;
      const worker = this.workers[idx];
      worker.analyze(task.fen, task.depth).then(
        (res) => {
          // Flip `busy` before resolving so that any awaiter checking
          // `pool.isIdle()` immediately after `await pool.analyze()`
          // sees the post-completion state. (Resolving the task first
          // would let the awaiter's microtask run before the finally
          // hook had a chance to clear the slot.)
          this.busy[idx] = false;
          task.resolve(res);
          this.pump();
        },
        (err) => {
          this.busy[idx] = false;
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
    for (const w of this.workers) w.terminate();
    this.workers = [];
    this.busy = [];
    // Reject any stragglers so callers don't await forever.
    for (const t of this.queue) t.reject(new Error('pool terminated'));
    this.queue = [];
  }

  /** Shut down workers if (and only if) the pool is idle. No-op
   *  otherwise. Returns true if workers were actually freed. */
  terminateIfIdle(): boolean {
    if (!this.isIdle() || this.workers.length === 0) return false;
    for (const w of this.workers) w.terminate();
    this.workers = [];
    this.busy = [];
    return true;
  }
}

/** Default pool used by the analysis queue. Lazy-initialized on first
 *  use so the workers don't spin up just because the bundle loaded. */
let _defaultPool: EnginePool | null = null;
export function analysisPool(): EnginePool {
  if (!_defaultPool) _defaultPool = new EnginePool();
  return _defaultPool;
}
