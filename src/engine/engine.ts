export interface InfoLine {
  depth?: number;
  seldepth?: number;
  multipv?: number;
  scoreCp?: number;
  scoreMate?: number;
  nodes?: number;
  nps?: number;
  time?: number;
  pv?: string[];
}

export interface AnalysisResult {
  depth: number;
  bestMoveUci: string | null;
  scoreCp: number | null;
  scoreMate: number | null;
  pv: string[];
}

type Listener = (line: string) => void;

/** Live observation of the worker's UCI activity. Fires every time the
 *  worker emits an `info` line we can usefully parse, as well as on
 *  the lifecycle transitions of an `analyze()` call (start / done).
 *  Used by the engine cockpit (`<EngineCockpit>`) to render real-time
 *  Stockfish activity while the user is waiting for analysis. */
export interface EngineObservation {
  kind: 'start' | 'info' | 'done';
  /** FEN currently being analyzed. Set whenever the worker has an
   *  active job; null between jobs. */
  fen: string | null;
  /** Requested depth for the current job. Echoed back here so a
   *  consumer doesn't have to track it separately. */
  requestedDepth: number;
  /** Latest parsed info line (for `kind: 'info'`). Undefined for
   *  `start` / `done`. */
  info?: InfoLine;
}

type ObservationListener = (obs: EngineObservation) => void;

/**
 * One Stockfish worker. Owns its UCI handshake and runs at most one
 * analysis at a time — calling `analyze` while a prior analysis is in
 * flight cancels the prior one. Multiple instances can be created in
 * parallel (see `analysisPool`); they don't share state.
 */
export class EngineWorker {
  private worker: Worker | null = null;
  private ready: Promise<void> | null = null;
  private listeners = new Set<Listener>();
  private observers = new Set<ObservationListener>();
  private currentJob: { cancel: () => void } | null = null;
  private currentFen: string | null = null;
  private currentDepth = 0;
  /**
   * Which evaluator this engine is actually using — captured from the UCI
   * handshake rather than assumed.
   *
   * This matters because the bundled WASM build ships `Use NNUE` defaulting to
   * FALSE and no network file (the .wasm is ~575 KB against a 40 MB net), so
   * every analysis this app has ever produced used Stockfish 16's *classical*
   * evaluator. That is a materially weaker judge of quiet positions: on a rook
   * endgame, classical reports +0.53 where NNUE reports +3.77.
   *
   * `Analysis.engine` used to be the constant string 'stockfish-16', which did
   * not distinguish the two and so silently claimed more than was true. Reading
   * the real state here lets the analyzer stamp an honest value, and lets cloud
   * sync prefer an NNUE analysis over a classical one for the same game.
   */
  private nnueEnabled = false;

  private async init(): Promise<void> {
    if (this.ready) return this.ready;

    // Prefer the threaded build only when the page is cross-origin isolated;
    // otherwise SharedArrayBuffer exists but postMessage of wasm memory still fails.
    const canThread =
      typeof SharedArrayBuffer !== 'undefined' &&
      typeof crossOriginIsolated !== 'undefined' &&
      crossOriginIsolated === true;

    const candidates = canThread
      ? ['stockfish-nnue-16.js', 'stockfish-nnue-16-single.js']
      : ['stockfish-nnue-16-single.js'];

    let lastError: unknown = null;
    for (const file of candidates) {
      try {
        this.worker = await this.startWorker(file);
        this.ready = this.handshake();
        return this.ready;
      } catch (e) {
        lastError = e;
        if (this.worker) {
          this.worker.terminate();
          this.worker = null;
        }
      }
    }
    throw new Error(
      `Stockfish worker failed to start (${
        lastError instanceof Error ? lastError.message : String(lastError)
      })`,
    );
  }

  private startWorker(file: string): Promise<Worker> {
    return new Promise<Worker>((resolve, reject) => {
      const url = `${import.meta.env.BASE_URL}stockfish/${file}`;
      let worker: Worker;
      try {
        worker = new Worker(url);
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
        return;
      }

      let settled = false;
      const onError = (ev: ErrorEvent) => {
        if (settled) return;
        settled = true;
        const msg =
          [ev.message, ev.filename, ev.lineno ? `line ${ev.lineno}` : '']
            .filter(Boolean)
            .join(' @ ') || 'worker error';
        reject(new Error(msg));
      };
      const onMessageError = () => {
        if (settled) return;
        settled = true;
        reject(new Error('worker messageerror'));
      };
      const onFirstMessage = () => {
        if (settled) return;
        settled = true;
        worker.removeEventListener('error', onError);
        worker.removeEventListener('messageerror', onMessageError);
        // Keep the error listener for runtime errors.
        worker.addEventListener('error', (e) =>
          console.error('[stockfish] runtime error', e),
        );
        // Re-forward messages to the engine's listener set.
        worker.addEventListener('message', (ev: MessageEvent) => {
          const line = typeof ev.data === 'string' ? ev.data : String(ev.data);
          for (const l of this.listeners) l(line);
        });
        // Forward the first message we just saw (don't drop it).
        // (It's listened below before resolve.)
        resolve(worker);
      };

      worker.addEventListener('error', onError);
      worker.addEventListener('messageerror', onMessageError);

      // The first message from the worker indicates the script is alive.
      // Capture it and also forward to listeners.
      const firstMsg = (ev: MessageEvent) => {
        worker.removeEventListener('message', firstMsg);
        const line = typeof ev.data === 'string' ? ev.data : String(ev.data);
        for (const l of this.listeners) l(line);
        onFirstMessage();
      };
      worker.addEventListener('message', firstMsg);

      // If nothing happens in 8 seconds, assume it's stuck.
      setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error(`timeout loading ${file}`));
        }
      }, 8000);

      // Poke it: some builds only start producing output after the first command.
      // Sending "uci" is always safe once the worker exists; if the script isn't
      // ready yet, the Worker buffers postMessage and delivers when onmessage is set.
      try {
        worker.postMessage('uci');
      } catch {
        // Worker not ready yet; ignore. The startup will produce messages anyway.
      }
    });
  }

  private handshake(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (!this.worker) return reject(new Error('no worker'));
      const timer = setTimeout(() => {
        offReady();
        reject(new Error('UCI handshake timeout'));
      }, 10000);
      const offReady = this.onLine((line) => {
        // `option name Use NNUE type check default <bool>` arrives during the
        // `uci` response. Since we never set the option, its default IS the
        // state; if a future build defaults it on, this picks that up with no
        // code change.
        const nnue = /^option name Use NNUE type check default (true|false)/.exec(line);
        if (nnue) this.nnueEnabled = nnue[1] === 'true';
        if (line === 'readyok') {
          clearTimeout(timer);
          offReady();
          resolve();
        }
      });
      this.send('uci');
      this.send('setoption name UCI_AnalyseMode value true');
      this.send('setoption name Threads value 1');
      this.send('setoption name Hash value 64');
      this.send('isready');
    });
  }

  /**
   * Evaluator identity for `Analysis.engine`, e.g. `stockfish-16-classical`.
   *
   * Only meaningful after the handshake; callers should await `analyze()` or
   * `waitReady()` first. Defaults to the classical label because that is what
   * the current bundled build actually does.
   */
  evaluatorId(): string {
    return this.nnueEnabled ? 'stockfish-16-nnue' : 'stockfish-16-classical';
  }

  isNnueEnabled(): boolean {
    return this.nnueEnabled;
  }

  private send(cmd: string): void {
    this.worker?.postMessage(cmd);
  }

  private onLine(cb: Listener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /**
   * Subscribe to live engine activity (start / info / done events for
   * each `analyze()` call). Returns an unsubscribe function. Multiple
   * listeners can coexist; the worker fires each in registration order
   * synchronously from its own message handler, so listeners must NOT
   * throw — uncaught exceptions would be re-emitted as worker errors.
   *
   * Cheap to subscribe to: when there are zero observers we still
   * parse `info` lines internally for the analyze() result, but we
   * skip the dispatch loop entirely in that case so the steady-state
   * cost is one `Set.size` check per line.
   */
  addInfoListener(cb: ObservationListener): () => void {
    this.observers.add(cb);
    return () => {
      this.observers.delete(cb);
    };
  }

  private fanOut(obs: EngineObservation): void {
    if (this.observers.size === 0) return;
    for (const o of this.observers) {
      try {
        o(obs);
      } catch (err) {
        // Observers must not throw — log loudly the first time and
        // keep going so a buggy panel can't take down the engine.
        console.error('[engine] observer threw', err);
      }
    }
  }

  async newGame(): Promise<void> {
    await this.init();
    this.send('ucinewgame');
    await this.waitReady();
  }

  /**
   * Set a UCI option on the worker. Used by free-play to flip
   * `UCI_LimitStrength` / `Skill Level` between user-chosen strength
   * levels. Issued *before* the next `analyze()` call so Stockfish
   * picks them up at the start of its search. Caller is responsible
   * for any subsequent `isready` round-trip if it cares about the
   * option being acknowledged before the search begins; for the
   * strength-tuning use case Stockfish honours options as soon as the
   * next `go` arrives, so we just fire-and-forget.
   *
   * Public counterpart of the private `send`. Kept narrow on purpose:
   * we don't want callers reaching into the worker for arbitrary
   * commands.
   */
  async setOption(name: string, value: string | number | boolean): Promise<void> {
    await this.init();
    const v =
      typeof value === 'boolean'
        ? value
          ? 'true'
          : 'false'
        : String(value);
    this.send(`setoption name ${name} value ${v}`);
  }

  private waitReady(): Promise<void> {
    return new Promise((resolve) => {
      const off = this.onLine((line) => {
        if (line === 'readyok') {
          off();
          resolve();
        }
      });
      this.send('isready');
    });
  }

  /**
   * Analyze a single position to given depth. Returns best move and eval.
   * Only one analysis may run at a time; calling again cancels the previous.
   */
  async analyze(fen: string, depth: number): Promise<AnalysisResult> {
    await this.init();
    if (this.currentJob) this.currentJob.cancel();
    this.currentFen = fen;
    this.currentDepth = depth;
    this.fanOut({ kind: 'start', fen, requestedDepth: depth });

    return new Promise<AnalysisResult>((resolve, reject) => {
      let cancelled = false;
      let lastInfo: InfoLine = {};

      const off = this.onLine((line) => {
        if (cancelled) return;
        if (line.startsWith('info ')) {
          const parsed = parseInfo(line);
          // We want the latest info with a PV and the requested depth.
          if (parsed.pv && parsed.pv.length > 0) {
            lastInfo = { ...lastInfo, ...parsed };
          }
          // Fan out *every* info line that carries any parsed field
          // (depth / score / nps / pv) so the cockpit can render the
          // engine's progress as it deepens. Skip empty parses (a
          // malformed line) to avoid emitting noise.
          if (
            this.observers.size > 0 &&
            (parsed.depth != null ||
              parsed.scoreCp != null ||
              parsed.scoreMate != null ||
              parsed.nps != null ||
              (parsed.pv && parsed.pv.length > 0))
          ) {
            this.fanOut({
              kind: 'info',
              fen: this.currentFen,
              requestedDepth: this.currentDepth,
              info: parsed,
            });
          }
        } else if (line.startsWith('bestmove ')) {
          off();
          this.currentJob = null;
          const bestMove = line.split(/\s+/)[1] ?? null;
          this.fanOut({
            kind: 'done',
            fen: this.currentFen,
            requestedDepth: this.currentDepth,
          });
          this.currentFen = null;
          this.currentDepth = 0;
          resolve({
            depth: lastInfo.depth ?? depth,
            bestMoveUci: bestMove === '(none)' ? null : bestMove,
            scoreCp: lastInfo.scoreCp ?? null,
            scoreMate: lastInfo.scoreMate ?? null,
            pv: lastInfo.pv ?? [],
          });
        }
      });

      this.currentJob = {
        cancel: () => {
          cancelled = true;
          off();
          this.send('stop');
          this.fanOut({
            kind: 'done',
            fen: this.currentFen,
            requestedDepth: this.currentDepth,
          });
          this.currentFen = null;
          this.currentDepth = 0;
          reject(new Error('cancelled'));
        },
      };

      this.send(`position fen ${fen}`);
      this.send(`go depth ${depth}`);
    });
  }

  terminate(): void {
    this.worker?.terminate();
    this.worker = null;
    this.ready = null;
    this.listeners.clear();
    // Note: we deliberately do NOT clear `observers` here. The cockpit
    // store holds long-lived observer subscriptions across pool
    // teardowns / rehydrations (the pool spins down workers after 8 s
    // of idle and respawns them on the next analyze call), and we want
    // the same store subscription to keep receiving events after the
    // respawn. Per-job lifecycle is handled by `start` / `done` events
    // instead.
    this.currentJob = null;
    this.currentFen = null;
    this.currentDepth = 0;
  }

  /** Whether this worker is currently running an analysis. Used by the
   *  pool to pick a free worker, and to know when to wait. */
  isBusy(): boolean {
    return this.currentJob !== null;
  }

  /** Cancel any in-flight analysis without starting a new one. Used when
   *  the last live-eval consumer unmounts, so `isBusy()` clears and idle
   *  teardown can actually free the WASM heap instead of no-op'ing for
   *  the remaining search depth.
   *
   *  Callers must own the worker: on the shared `engine` singleton this
   *  kills whatever job is running, whoever started it. `LiveEval` only
   *  calls it once its consumer refcount hits zero. */
  cancelAnalysis(): void {
    if (!this.currentJob) return;
    this.currentJob.cancel();
    this.currentJob = null;
  }
}

/** Singleton worker used by single-position consumers (live eval in the
 *  review screen). Keeps the original "cancel previous" semantics: a new
 *  `analyze()` call cancels any in-flight one on the same worker. */
export const engine = new EngineWorker();

/**
 * Tear down the singleton `engine` worker if it hasn't been used for
 * `idleMs`. The worker rehydrates lazily on the next `analyze()` call
 * via `init()`, so this is invisible to consumers and frees the WASM
 * heap (~30 MB / NNUE net) while the user isn't on the review screen.
 *
 * Returns true if the worker was actually terminated.
 */
export function terminateEngineIfIdle(): boolean {
  if (engine.isBusy()) return false;
  // We can't tell from here whether the worker was ever started, but
  // calling terminate() on a never-started worker is a cheap no-op
  // (`this.worker?.terminate()` short-circuits on null).
  engine.terminate();
  return true;
}

function parseInfo(line: string): InfoLine {
  const info: InfoLine = {};
  const tokens = line.split(/\s+/);
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    const next = tokens[i + 1];
    switch (t) {
      case 'depth':
        info.depth = Number(next);
        i++;
        break;
      case 'seldepth':
        info.seldepth = Number(next);
        i++;
        break;
      case 'multipv':
        info.multipv = Number(next);
        i++;
        break;
      case 'nodes':
        info.nodes = Number(next);
        i++;
        break;
      case 'nps':
        info.nps = Number(next);
        i++;
        break;
      case 'time':
        info.time = Number(next);
        i++;
        break;
      case 'score': {
        const kind = tokens[i + 1];
        const val = Number(tokens[i + 2]);
        if (kind === 'cp') info.scoreCp = val;
        else if (kind === 'mate') info.scoreMate = val;
        i += 2;
        break;
      }
      case 'pv':
        info.pv = tokens.slice(i + 1);
        i = tokens.length;
        break;
    }
  }
  return info;
}
