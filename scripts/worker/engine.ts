import { spawn } from 'node:child_process';
import type { AnalysisResult } from '@/engine/engine';
import type { EngineBackend } from '@/engine/analyzer';

/**
 * Native Stockfish over UCI stdio, presenting the same `EngineBackend` the
 * browser pool does — so `analyzeGamePgn` runs unmodified on a server.
 *
 * ── Why the UCI options are copied from the browser, except one ───────────
 *
 * `src/engine/engine.ts` sets three options on every worker: UCI_AnalyseMode,
 * Threads=1 and Hash=64. All three change the search, so a mismatch changes the
 * evaluation *at the same depth* — and every classification, accuracy figure and
 * motif is derived from the evaluation. Measured: with Hash=16 and no analyse
 * mode, a rook endgame came out at 340 cp instead of 53.
 *
 * The one deliberate difference is `Use NNUE`. The browser's bundled WASM build
 * ships with it OFF and no network file (a 575 KB .wasm against a 40 MB net), so
 * every analysis the app has ever produced used Stockfish 16's *classical*
 * evaluator. On quiet positions that is a much weaker judge: the same rook
 * endgame reads +0.53 classical and +3.77 NNUE — "equal" versus "winning", which
 * for a coaching tool is the difference between useful and misleading.
 *
 * A server has no 40 MB download to worry about, so it runs the real thing.
 * `verify.ts` pins both halves of that claim: NNUE off reproduces the browser
 * exactly, and NNUE on genuinely differs.
 */

/** Mirrors src/engine/engine.ts. Changing these forks the library's provenance. */
export const SHARED_UCI_OPTIONS = [
  'setoption name UCI_AnalyseMode value true',
  'setoption name Threads value 1',
  'setoption name Hash value 64',
] as const;

export type Evaluator = 'nnue' | 'classical';

export function evaluatorId(e: Evaluator): string {
  return e === 'nnue' ? 'stockfish-16-nnue' : 'stockfish-16-classical';
}

/**
 * One Stockfish process, one position at a time.
 *
 * Single-threaded on purpose: at a fixed depth with one thread Stockfish's
 * search is deterministic, so every evaluation is reproducible. Parallelism
 * comes from running N of these, not from giving one engine N threads.
 */
export class NativeEngine {
  private proc: ReturnType<typeof spawn>;
  private buffer = '';
  private listeners = new Set<(line: string) => void>();
  private readyPromise: Promise<void>;
  name = 'unknown';
  nnueActive = false;

  constructor(
    private binPath: string,
    private evaluator: Evaluator,
  ) {
    this.proc = spawn(binPath, [], { stdio: ['pipe', 'pipe', 'ignore'] });
    this.proc.stdout!.setEncoding('utf8');
    this.proc.stdout!.on('data', (c: string) => this.onData(c));
    this.proc.on('error', (err) => {
      throw new Error(`stockfish (${binPath}) failed to start: ${err.message}`);
    });
    this.readyPromise = this.handshake();
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (line) for (const l of [...this.listeners]) l(line);
    }
  }

  private send(cmd: string): void {
    this.proc.stdin!.write(`${cmd}\n`);
  }

  private until(
    pred: (l: string) => boolean,
    timeoutMs: number,
    what: string,
  ): Promise<string[]> {
    return new Promise((resolve, reject) => {
      const lines: string[] = [];
      const onLine = (line: string) => {
        lines.push(line);
        if (!pred(line)) return;
        clearTimeout(timer);
        this.listeners.delete(onLine);
        resolve(lines);
      };
      const timer = setTimeout(() => {
        this.listeners.delete(onLine);
        reject(new Error(`timeout waiting for ${what} after ${timeoutMs}ms`));
      }, timeoutMs);
      this.listeners.add(onLine);
    });
  }

  private async handshake(): Promise<void> {
    this.send('uci');
    const lines = await this.until((l) => l === 'uciok', 60_000, 'uciok');
    this.name = (lines.find((l) => l.startsWith('id name')) ?? '').replace('id name', '').trim();
    for (const o of SHARED_UCI_OPTIONS) this.send(o);
    // Set explicitly in both directions rather than relying on the build's
    // default, so the evaluator is a property of this code and not of whichever
    // binary happens to be on the box.
    this.send(`setoption name Use NNUE value ${this.evaluator === 'nnue'}`);
    this.nnueActive = this.evaluator === 'nnue';
    this.send('isready');
    await this.until((l) => l === 'readyok', 60_000, 'readyok');
  }

  async ready(): Promise<this> {
    await this.readyPromise;
    return this;
  }

  /**
   * Analyze one position, returning the browser's `AnalysisResult` shape.
   *
   * Score extraction mirrors `engine.ts`: accumulate `info` fields and keep the
   * last values seen before `bestmove`, rather than requiring a line tagged with
   * the exact target depth. Stockfish can finish on a shallower line (mate
   * found, or the search terminated early), and demanding `depth N` would drop
   * the score for precisely those positions.
   */
  async analyze(fen: string, depth: number): Promise<AnalysisResult> {
    await this.readyPromise;
    let lastDepth: number | null = null;
    let scoreCp: number | null = null;
    let scoreMate: number | null = null;
    let pv: string[] = [];

    const collect = (line: string) => {
      if (!line.startsWith('info ')) return;
      const d = /\bdepth (\d+)/.exec(line);
      if (d) lastDepth = Number(d[1]);
      const cp = /\bscore cp (-?\d+)/.exec(line);
      if (cp) {
        scoreCp = Number(cp[1]);
        scoreMate = null;
      }
      const mate = /\bscore mate (-?\d+)/.exec(line);
      if (mate) {
        scoreMate = Number(mate[1]);
        scoreCp = null;
      }
      const p = /\bpv (.+)$/.exec(line);
      if (p) pv = p[1].split(/\s+/);
    };

    this.listeners.add(collect);
    let bestMoveUci: string | null = null;
    try {
      this.send(`position fen ${fen}`);
      this.send(`go depth ${depth}`);
      // Generous: a pathological position at depth 18+ can take a while, and a
      // spurious timeout would abandon a game part-analyzed.
      const lines = await this.until(
        (l) => l.startsWith('bestmove'),
        300_000,
        `bestmove for ${fen}`,
      );
      const uci = (lines.find((l) => l.startsWith('bestmove')) ?? '').split(/\s+/)[1];
      bestMoveUci = uci && uci !== '(none)' ? uci : null;
    } finally {
      this.listeners.delete(collect);
    }

    return { depth: lastDepth ?? depth, bestMoveUci, scoreCp, scoreMate, pv };
  }

  terminate(): void {
    try {
      this.send('quit');
    } catch {
      /* already gone */
    }
    this.proc.kill();
  }
}

/**
 * N single-threaded engines behind a FIFO queue, with an in-memory eval cache —
 * the server-side counterpart to `EnginePool` + `cachedAnalyze`.
 *
 * The cache earns its place: across a library, games share long opening
 * prefixes, so early positions recur constantly. Keyed `fen|depth` exactly like
 * the browser's Dexie cache, and bounded so a multi-thousand-game run can't grow
 * it without limit.
 */
export class WorkerPool implements EngineBackend {
  private engines: NativeEngine[] = [];
  private idle: NativeEngine[] = [];
  private waiting: Array<(e: NativeEngine) => void> = [];
  private cache = new Map<string, AnalysisResult>();
  private inflight = new Map<string, Promise<AnalysisResult>>();
  stats = { hits: 0, misses: 0, coalesced: 0, bookSkips: 0 };
  engineName = 'unknown';

  constructor(
    binPath: string,
    readonly size: number,
    private evaluator: Evaluator,
    private cacheLimit = 400_000,
  ) {
    for (let i = 0; i < size; i++) {
      const e = new NativeEngine(binPath, evaluator);
      this.engines.push(e);
      this.idle.push(e);
    }
  }

  async ready(): Promise<this> {
    await Promise.all(this.engines.map((e) => e.ready()));
    this.engineName = this.engines[0]?.name ?? 'unknown';
    return this;
  }

  id(): string {
    return evaluatorId(this.evaluator);
  }

  private acquire(): Promise<NativeEngine> {
    const e = this.idle.pop();
    if (e) return Promise.resolve(e);
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  private release(e: NativeEngine): void {
    const next = this.waiting.shift();
    if (next) next(e);
    else this.idle.push(e);
  }

  analyze(fen: string, depth: number): Promise<AnalysisResult> {
    const key = `${fen}|${depth}`;
    const hit = this.cache.get(key);
    if (hit) {
      this.stats.hits++;
      return Promise.resolve(hit);
    }
    const pending = this.inflight.get(key);
    if (pending) {
      this.stats.coalesced++;
      return pending;
    }
    const p = (async () => {
      const engine = await this.acquire();
      try {
        const res = await engine.analyze(fen, depth);
        this.stats.misses++;
        if (this.cache.size < this.cacheLimit) this.cache.set(key, res);
        return res;
      } finally {
        this.release(engine);
      }
    })().finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  /**
   * `ucinewgame` is deliberately a no-op.
   *
   * The browser sends it once per game to clear the transposition table. Here
   * engines are shared across games analyzed concurrently, so honouring it would
   * wipe another game's table mid-search. Skipping it can only leave the search
   * better-informed, never worse, and since every position is searched to a
   * fixed depth a warmer table changes speed rather than the reported score.
   */
  async newGame(): Promise<void> {}

  noteBookSkip(): void {
    this.stats.bookSkips++;
  }

  terminate(): void {
    for (const e of this.engines) e.terminate();
  }
}
