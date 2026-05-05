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
  if (liveEvalConsumers === 0 && liveEvalTeardownTimer === null) {
    liveEvalTeardownTimer = setTimeout(() => {
      liveEvalTeardownTimer = null;
      if (liveEvalConsumers === 0) terminateEngineIfIdle();
    }, LIVE_EVAL_IDLE_MS);
  }
}

interface LiveEvalData {
  depth: number;
  cpWhite: number;
  mate?: number;
  bestMoveUci?: string;
  bestMoveSan?: string;
  winrateWhite: number;
  running: boolean;
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
        setData({
          depth: res.depth,
          cpWhite,
          mate: res.scoreMate ?? undefined,
          bestMoveUci: res.bestMoveUci ?? undefined,
          bestMoveSan,
          winrateWhite: stm === 'w' ? winrateStm : 1 - winrateStm,
          running: false,
        });
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
