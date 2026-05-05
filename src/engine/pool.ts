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
    this.workers = Array.from({ length: size }, () => new EngineWorker());
    this.busy = this.workers.map(() => false);
  }

  /** Number of underlying workers. */
  get size(): number {
    return this.workers.length;
  }

  /** Reset every worker for a fresh game. Done in parallel so the cost
   *  is the slowest single worker, not the sum. */
  async newGame(): Promise<void> {
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
   *  Called whenever a task is enqueued or finishes. */
  private pump(): void {
    while (this.queue.length > 0) {
      const idx = this.busy.indexOf(false);
      if (idx === -1) return;
      const task = this.queue.shift()!;
      this.busy[idx] = true;
      const worker = this.workers[idx];
      worker
        .analyze(task.fen, task.depth)
        .then((res) => task.resolve(res))
        .catch((err) => task.reject(err))
        .finally(() => {
          this.busy[idx] = false;
          this.pump();
        });
    }
  }

  terminate(): void {
    for (const w of this.workers) w.terminate();
    this.workers = [];
    this.busy = [];
    // Reject any stragglers so callers don't await forever.
    for (const t of this.queue) t.reject(new Error('pool terminated'));
    this.queue = [];
  }
}

/** Default pool used by the analysis queue. Lazy-initialized on first
 *  use so the workers don't spin up just because the bundle loaded. */
let _defaultPool: EnginePool | null = null;
export function analysisPool(): EnginePool {
  if (!_defaultPool) _defaultPool = new EnginePool();
  return _defaultPool;
}
