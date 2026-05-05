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

/**
 * Run a boot-step in isolation. Any error inside is logged but never
 * propagated — boot steps are best-effort housekeeping (self-heal,
 * backfill, recompute) and historically a single failure could swallow
 * the entire queue startup, leaving newly imported games stuck at
 * `pending` until the user manually reloaded. We log loudly so the
 * issue is still discoverable in the console.
 */
async function bootStep(label: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    console.error(`[queue] boot step "${label}" failed; continuing`, err);
  }
}

export async function startAnalysisQueue(): Promise<void> {
  if (started) return;
  started = true;

  // Step 1 (CRITICAL): recover any games that were mid-analysis on last
  // load. Must run before runLoop so we don't double-pick or starve.
  // Anything more expensive than that runs in the background so a slow
  // recompute pass over thousands of games can't delay the queue from
  // picking up newly imported games.
  await bootStep('resetRunningToPending', () => resetRunningToPending());

  // Kick the main loop off NOW. Newly imported games start analyzing
  // immediately; they don't have to wait for housekeeping to finish.
  void runLoop();

  // Step 2+ (BACKGROUND): housekeeping. None of these are required for
  // correctness of *new* analyses, just for fixing up old data. Run
  // them sequentially in the background so they don't compete with the
  // engine workers.
  void (async () => {
    await bootStep('requeueStaleErrors', async () => {
      const healed = await requeueStaleErrors();
      if (healed > 0) {
        console.info(
          `[queue] requeued ${healed} stale-error games from a previous session`,
        );
      }
    });
    await bootStep('refreshOpeningMetadata', async () => {
      const reopened = await refreshOpeningMetadata();
      if (reopened > 0) {
        console.info(
          `[queue] refreshed opening metadata for ${reopened} games`,
        );
      }
    });
    // Re-classify moves and refresh accuracy with the current rules,
    // without re-running Stockfish. Slow on large libraries (~10s+ for
    // hundreds of games), which is why it lives off the critical path.
    await bootStep('recomputeClassificationsAndAccuracies', async () => {
      const recomputed = await recomputeClassificationsAndAccuracies();
      if (recomputed > 0) {
        console.info(
          `[queue] re-classified + recomputed accuracy for ${recomputed} games`,
        );
      }
    });
  })();
}

async function runLoop(): Promise<void> {
  const store = useQueueStore.getState;
  // Outer guard: any unhandled throw from a single iteration (DB hiccup,
  // module-load failure during HMR, etc.) used to kill the loop forever
  // — the page would have to be reloaded to re-arm analysis. We now wrap
  // every iteration in a try/catch and back off briefly on unexpected
  // failures, so the queue self-heals.
  while (true) {
    try {
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
    } catch (err) {
      console.error('[queue] runLoop iteration failed; backing off', err);
      await sleep(3000);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
