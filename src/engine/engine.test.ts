import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The real `nnue.ts` would probe the network for the net; these tests are about
// UCI line handling, so pin the classical path.
vi.mock('./nnue', () => ({
  CLASSICAL_EVALUATOR_ID: 'stockfish-16-classical',
  NNUE_EVALUATOR_ID: 'stockfish-16-nnue',
  nnueActive: async () => false,
  nnueEvalFileValue: () => 'unused.nnue',
  nnuePreferenceEnabled: () => false,
  intendedEvaluatorIdSync: () => 'stockfish-16-classical',
}));

import { EngineWorker } from './engine';

/**
 * A stand-in for the Stockfish Web Worker that keeps the two UCI properties the
 * bugs below depend on, as measured against native Stockfish 16:
 *
 *   - output is posted asynchronously, so lines the engine emitted before it saw
 *     a command are still delivered after the caller sent it;
 *   - `stop` is answered with the STOPPED search's `bestmove`, and a new search
 *     only starts once the running one has printed its `bestmove` (a `go`
 *     mid-search blocks every command behind it until then).
 *
 * No real worker, no WASM: `new Worker` is stubbed with this class.
 */
interface Canned {
  /** `info` lines, in order, each printed as the search deepens. */
  infos: string[];
  bestmove: string;
}

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const KRK = '8/8/8/8/8/2k5/8/K6R w - - 0 1';
const MATE_THEN_CP = '6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1';

const CANNED: Record<string, Canned> = {
  [START]: {
    infos: ['info depth 1 score cp 34 nodes 20 pv e2e4'],
    bestmove: 'bestmove e2e4 ponder e7e5',
  },
  [KRK]: {
    infos: ['info depth 1 score cp 534 nodes 19 pv h1h8 c3b4'],
    bestmove: 'bestmove h1h8 ponder c3b4',
  },
  // A shallow depth sees a mate that a deeper one refutes.
  [MATE_THEN_CP]: {
    infos: [
      'info depth 5 score mate 3 nodes 100 pv d1d8',
      'info depth 12 score cp 120 nodes 9000 pv g2g3 g7g6',
    ],
    bestmove: 'bestmove g2g3',
  },
};

class FakeStockfish {
  static instances: FakeStockfish[] = [];
  /** Every `position fen …` this worker was sent, in order. */
  positions: string[] = [];
  private listeners = new Map<string, Set<(ev: { data: string }) => void>>();
  private fen = START;
  private search: { fen: string; timer: ReturnType<typeof setTimeout> } | null = null;
  /** Commands held behind a `go` that arrived mid-search: Stockfish's UCI
   *  thread blocks on a new `go` until the running search has finished. */
  private blocked: string[] = [];

  /** Milliseconds a search takes when left alone. */
  static searchMs = 20;

  constructor() {
    FakeStockfish.instances.push(this);
  }

  addEventListener(type: string, cb: (ev: { data: string }) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(cb);
  }
  removeEventListener(type: string, cb: (ev: { data: string }) => void) {
    this.listeners.get(type)?.delete(cb);
  }
  terminate() {
    if (this.search) clearTimeout(this.search.timer);
    this.search = null;
  }

  private emit(line: string) {
    // Asynchronous, like a real worker's postMessage.
    setTimeout(() => {
      for (const cb of [...(this.listeners.get('message') ?? [])]) cb({ data: line });
    }, 0);
  }

  private finish() {
    if (!this.search) return;
    clearTimeout(this.search.timer);
    const canned = CANNED[this.search.fen];
    this.search = null;
    this.emit(canned.bestmove);
    const held = this.blocked;
    this.blocked = [];
    for (const c of held) this.postMessage(c);
  }

  postMessage(cmd: string) {
    if (this.blocked.length > 0 || (this.search && cmd.startsWith('go '))) {
      this.blocked.push(cmd);
      return;
    }
    if (cmd === 'uci') this.emit('uciok');
    else if (cmd === 'isready') this.emit('readyok');
    else if (cmd.startsWith('position fen ')) {
      this.fen = cmd.slice('position fen '.length);
      this.positions.push(this.fen);
    } else if (cmd.startsWith('go ')) {
      const fen = this.fen;
      // Infos are printed at once — so a stopped search's infos are already
      // in the channel when the next job attaches.
      for (const l of CANNED[fen].infos) this.emit(l);
      this.search = {
        fen,
        timer: setTimeout(() => this.finish(), FakeStockfish.searchMs),
      };
    } else if (cmd === 'stop') {
      this.finish();
    }
  }
}

beforeEach(() => {
  FakeStockfish.instances = [];
  FakeStockfish.searchMs = 20;
  vi.stubGlobal('Worker', FakeStockfish);
  // Quiets the single-threaded-build warning; the build choice is irrelevant here.
  vi.stubGlobal('crossOriginIsolated', true);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('EngineWorker.analyze — a cancelled search never answers for the next one', () => {
  /**
   * The bug: cancelling sent `stop` and attached the new job's listener at
   * once, so the stopped search's `bestmove` (and its in-flight `info`s) were
   * taken as the new job's result. Reproduced in the app as a KR-vs-K position
   * reporting the start position's `e2e4 cp 34`, and every later call one
   * result behind.
   */
  it('returns the new position\'s result, not the stopped one\'s', async () => {
    const w = new EngineWorker();
    const first = w.analyze(START, 20);
    const firstOutcome = first.then(
      () => 'resolved',
      (e: Error) => e.message,
    );
    // Let the first search actually start before preempting it.
    await new Promise((r) => setTimeout(r, 5));
    const second = await w.analyze(KRK, 8);

    expect(await firstOutcome).toBe('cancelled');
    expect(second.bestMoveUci).toBe('h1h8');
    expect(second.scoreCp).toBe(534);
    expect(second.pv[0]).toBe('h1h8');
  });

  it('stays in step afterwards — later calls are not one result behind', async () => {
    const w = new EngineWorker();
    void w.analyze(START, 20).catch(() => {});
    await new Promise((r) => setTimeout(r, 5));
    await w.analyze(KRK, 8);
    const third = await w.analyze(START, 8);
    expect(third.bestMoveUci).toBe('e2e4');
    expect(third.scoreCp).toBe(34);
  });

  it('survives several cancellations in a row', async () => {
    const w = new EngineWorker();
    await w.analyze(START, 1); // boot
    void w.analyze(KRK, 20).catch(() => {});
    void w.analyze(START, 20).catch(() => {});
    void w.analyze(KRK, 20).catch(() => {});
    const last = await w.analyze(START, 8);
    expect(last.bestMoveUci).toBe('e2e4');
    expect(last.scoreCp).toBe(34);
  });
});

describe('EngineWorker.analyze — score bookkeeping', () => {
  it('a later cp score clears an earlier mate score', async () => {
    const w = new EngineWorker();
    const r = await w.analyze(MATE_THEN_CP, 12);
    expect(r.scoreMate).toBeNull();
    expect(r.scoreCp).toBe(120);
    expect(r.depth).toBe(12);
  });
});
