import { create } from 'zustand';
import { analyzeGamePgn, computeAccuracy } from './analyzer';
import {
  getSettings,
  db,
} from '@/db/schema';
import {
  nextPendingGame,
  recomputeClassificationsAndAccuracies,
  refreshOpeningMetadata,
  requeueStaleErrors,
  resetRunningToPending,
  saveAnalysis,
  setAnalysisStatus,
} from '@/db/queries';

interface QueueState {
  running: boolean;
  currentGameId: string | null;
  currentPly: number;
  currentTotal: number;
  setProgress: (ply: number, total: number) => void;
  setCurrent: (id: string | null) => void;
  setRunning: (running: boolean) => void;
  paused: boolean;
  setPaused: (paused: boolean) => void;
}

export const useQueueStore = create<QueueState>((set) => ({
  running: false,
  currentGameId: null,
  currentPly: 0,
  currentTotal: 0,
  paused: false,
  setProgress: (ply, total) => set({ currentPly: ply, currentTotal: total }),
  setCurrent: (id) => set({ currentGameId: id, currentPly: 0, currentTotal: 0 }),
  setRunning: (running) => set({ running }),
  setPaused: (paused) => set({ paused }),
}));

let started = false;

export async function startAnalysisQueue(): Promise<void> {
  if (started) return;
  started = true;
  // Recover any games that were mid-analysis on last load.
  await resetRunningToPending();
  // Self-heal: requeue games that errored due to older, now-fixed bugs.
  const healed = await requeueStaleErrors();
  if (healed > 0) {
    console.info(`[queue] requeued ${healed} stale-error games from a previous session`);
  }
  // Backfill opening metadata for previously imported games whose opening
  // wasn't captured due to an older importer bug.
  const reopened = await refreshOpeningMetadata();
  if (reopened > 0) {
    console.info(`[queue] refreshed opening metadata for ${reopened} games`);
  }
  // Re-classify moves and refresh accuracy with the current rules, without
  // re-running Stockfish. Any change in thresholds or bucketing since the
  // game was last analyzed is picked up here.
  const recomputed = await recomputeClassificationsAndAccuracies();
  if (recomputed > 0) {
    console.info(
      `[queue] re-classified + recomputed accuracy for ${recomputed} games`,
    );
  }
  void runLoop();
}

async function runLoop(): Promise<void> {
  const store = useQueueStore.getState;
  while (true) {
    if (store().paused) {
      await sleep(500);
      continue;
    }

    const game = await nextPendingGame();
    if (!game) {
      useQueueStore.setState({
        running: false,
        currentGameId: null,
        currentPly: 0,
        currentTotal: 0,
      });
      await sleep(2000);
      continue;
    }

    useQueueStore.setState({
      running: true,
      currentGameId: game.id,
      currentPly: 0,
      currentTotal: 0,
    });

    const settings = await getSettings();
    await setAnalysisStatus(game.id, 'running');

    try {
      const analysis = await analyzeGamePgn(
        game.id,
        game.pgn,
        settings.engineDepth,
        ({ ply, totalPlies }) => {
          useQueueStore.getState().setProgress(ply, totalPlies);
        },
        undefined,
        {
          hasOpening: Boolean(game.eco || game.opening),
          timeControl: game.timeControl,
        },
      );
      await saveAnalysis(analysis);
      const accuracy = computeAccuracy(analysis.moves);
      await db.games.update(game.id, { accuracy, analysisStatus: 'done' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await setAnalysisStatus(game.id, 'error', msg);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
