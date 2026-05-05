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
import { analysisPool } from './pool';

/** How long the queue has to be idle (no pending games found) before we
 *  tear down the engine pool. The pool transparently rehydrates on the
 *  next analyze() call, so freeing workers between bursts of imports is
 *  pure win — each worker holds ~30 MB of WASM heap (NNUE net + hash
 *  table) that we don't need while the user is, e.g., browsing the
 *  dashboard or studying a repertoire. */
const IDLE_TEARDOWN_MS = 8000;

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

/**
 * Boot pipeline state. This is separate from the queue's running state
 * because the *housekeeping* passes (recompute / opening refresh) can
 * be slow on large libraries, and we want a global UI signal — a
 * spinner / progress overlay — for the user to know "the app is busy
 * fixing up old data, hang on" rather than thinking it's hung.
 *
 * `phase` is the human-readable label of the slowest in-flight pass.
 * `null` means boot housekeeping is fully done.
 */
interface BootState {
  /** Human label of the in-flight pass, or null when idle. */
  phase: string | null;
  /** Whether the slow housekeeping has actually started. We delay
   *  surfacing the overlay until this is true, so fast boots (skipped
   *  passes thanks to the version stamp) never flash a spinner. */
  started: boolean;
  setPhase: (phase: string | null) => void;
  setStarted: (started: boolean) => void;
}

export const useBootStore = create<BootState>((set) => ({
  phase: null,
  started: false,
  setPhase: (phase) => set({ phase }),
  setStarted: (started) => set({ started }),
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
    const boot = useBootStore.getState();

    // We delay surfacing the boot banner so warm boots — where every
    // pass either has nothing to do or short-circuits via its version
    // stamp — never flash a spinner. The banner is only shown if the
    // overall housekeeping work is still going past `BOOT_BANNER_DELAY_MS`.
    const BOOT_BANNER_DELAY_MS = 400;
    const bannerTimer = setTimeout(() => {
      // If we're still here after the grace period, we have real work;
      // surface the banner.
      boot.setStarted(true);
    }, BOOT_BANNER_DELAY_MS);

    boot.setPhase('Healing stale errors…');
    await bootStep('requeueStaleErrors', async () => {
      const healed = await requeueStaleErrors();
      if (healed > 0) {
        console.info(
          `[queue] requeued ${healed} stale-error games from a previous session`,
        );
      }
    });

    boot.setPhase('Refreshing opening metadata…');
    await bootStep('refreshOpeningMetadata', async () => {
      const reopened = await refreshOpeningMetadata();
      if (reopened > 0) {
        console.info(
          `[queue] refreshed opening metadata for ${reopened} games`,
        );
      }
    });

    boot.setPhase('Recomputing classifications & accuracy…');
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

    clearTimeout(bannerTimer);
    boot.setPhase(null);
    boot.setStarted(false);
  })();
}

async function runLoop(): Promise<void> {
  const store = useQueueStore.getState;
  // Track when we first noticed the queue was empty so we can free the
  // engine pool's workers after a grace period (see IDLE_TEARDOWN_MS).
  let idleSince: number | null = null;
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
        // Idle: opportunistically tear down the engine pool once we've
        // been idle for IDLE_TEARDOWN_MS. Each Stockfish worker holds
        // ~30 MB of resident WASM memory; freeing them between import
        // bursts is a meaningful RAM win and the pool transparently
        // rehydrates on the next analyze() call.
        const now = Date.now();
        if (idleSince === null) idleSince = now;
        if (now - idleSince >= IDLE_TEARDOWN_MS) {
          const pool = analysisPool();
          if (pool.terminateIfIdle()) {
            console.info('[queue] idle — released engine workers');
          }
          // Stretch the polling cadence once we've torn down. We're not
          // expecting work; checking every 4s is plenty.
          await sleep(4000);
        } else {
          await sleep(2000);
        }
        continue;
      }
      // We have work — reset the idle clock.
      idleSince = null;

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
