import { useEffect, useState } from 'react';
import { engine, terminateEngineIfIdle } from '@/engine/engine';
import { cpToWinrate, mateToCp } from '@/engine/classify';
import { Chess } from 'chess.js';

/** Shared idle-teardown timer for the singleton review engine. We
 *  schedule a teardown when the last `useLiveEval` consumer unmounts;
 *  if a new consumer mounts before the timer fires (e.g. the user
 *  navigates from one review back into another), we cancel it. */
let liveEvalTeardownTimer: ReturnType<typeof setTimeout> | null = null;
let liveEvalConsumers = 0;
const LIVE_EVAL_IDLE_MS = 5000;

function acquireLiveEval(): void {
  liveEvalConsumers++;
  if (liveEvalTeardownTimer) {
    clearTimeout(liveEvalTeardownTimer);
    liveEvalTeardownTimer = null;
  }
}

function releaseLiveEval(): void {
  liveEvalConsumers = Math.max(0, liveEvalConsumers - 1);
  if (liveEvalConsumers === 0) {
    // Stop any in-flight search so `isBusy()` clears and the idle
    // teardown below can actually free the WASM heap. Without this,
    // unmount while analyzing left the worker busy for up to the full
    // remaining depth and `terminateEngineIfIdle` no-op'd.
    engine.cancelAnalysis();
    if (liveEvalTeardownTimer === null) {
      liveEvalTeardownTimer = setTimeout(() => {
        liveEvalTeardownTimer = null;
        if (liveEvalConsumers === 0) terminateEngineIfIdle();
      }, LIVE_EVAL_IDLE_MS);
    }
  }
}

export interface LiveEvalData {
  depth: number;
  cpWhite: number;
  mate?: number;
  bestMoveUci?: string;
  bestMoveSan?: string;
  winrateWhite: number;
  /** Side-to-move's winrate at this position (for classification, which
   *  is always expressed from the mover's perspective). */
  winrateStm: number;
  running: boolean;
}

/**
 * In-memory cache of completed live evals keyed by FEN. The review page
 * uses this to look up the "before" position's eval after the user has
 * made an off-mainline move (the active `useLiveEval` will then be
 * crunching the *new* "after" position; we'd have lost the previous
 * result without a stash like this).
 *
 * Bounded so very long exploration sessions can't grow it unboundedly.
 */
const LIVE_EVAL_CACHE_MAX = 64;
const liveEvalCache = new Map<string, LiveEvalData>();

function rememberLiveEval(fen: string, data: LiveEvalData): void {
  // Map insertion order = LRU; bump on update by deleting first.
  liveEvalCache.delete(fen);
  liveEvalCache.set(fen, data);
  while (liveEvalCache.size > LIVE_EVAL_CACHE_MAX) {
    const oldest = liveEvalCache.keys().next().value;
    if (oldest === undefined) break;
    liveEvalCache.delete(oldest);
  }
}

export function getCachedLiveEval(fen: string): LiveEvalData | undefined {
  return liveEvalCache.get(fen);
}

/**
 * Runs a quick Stockfish analysis on the given FEN and returns the result.
 * Re-runs whenever fen changes. Cancels the previous run automatically through
 * engine.analyze's built-in cancellation.
 */
export function useLiveEval(fen: string, depth = 14): LiveEvalData | null {
  const [data, setData] = useState<LiveEvalData | null>(null);

  // Reference-count consumers so we know when to release the worker.
  useEffect(() => {
    acquireLiveEval();
    return () => releaseLiveEval();
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!fen) {
      // Stop any in-flight search. Previously callers passed `''` into
      // `analyze`, which cancelled via the "new job replaces old" path
      // but also kicked off a useless empty-FEN search. Cancel-only is
      // the correct idle behaviour.
      engine.cancelAnalysis();
      setData(null);
      return () => {
        cancelled = true;
      };
    }
    setData((prev) => (prev ? { ...prev, running: true } : null));

    (async () => {
      try {
        const res = await engine.analyze(fen, depth);
        if (cancelled) return;
        const stm = fen.split(' ')[1] === 'w' ? 'w' : 'b';
        const cpStm =
          res.scoreMate != null ? mateToCp(res.scoreMate) : (res.scoreCp ?? 0);
        const cpWhite = stm === 'w' ? cpStm : -cpStm;
        const winrateStm = cpToWinrate(cpStm);
        let bestMoveSan: string | undefined;
        if (res.bestMoveUci) {
          try {
            const c = new Chess();
            c.load(fen);
            const move = c.move({
              from: res.bestMoveUci.slice(0, 2),
              to: res.bestMoveUci.slice(2, 4),
              promotion: res.bestMoveUci.slice(4, 5) || undefined,
            });
            bestMoveSan = move?.san;
          } catch {
            bestMoveSan = undefined;
          }
        }
        const next: LiveEvalData = {
          depth: res.depth,
          cpWhite,
          mate: res.scoreMate ?? undefined,
          bestMoveUci: res.bestMoveUci ?? undefined,
          bestMoveSan,
          winrateWhite: stm === 'w' ? winrateStm : 1 - winrateStm,
          winrateStm,
          running: false,
        };
        rememberLiveEval(fen, next);
        setData(next);
      } catch (e) {
        if ((e as Error).message !== 'cancelled' && !cancelled) {
          setData(null);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [fen, depth]);

  return data;
}

export function formatCp(cp: number, mate?: number): string {
  if (mate != null) return `M${mate}`;
  const v = cp / 100;
  return `${v > 0 ? '+' : ''}${v.toFixed(2)}`;
}
