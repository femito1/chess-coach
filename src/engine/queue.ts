import { create } from 'zustand';
import {
  analyzeGamePgn,
  computeAccuracy,
  countUserBrilliancies,
} from './analyzer';
import {
  getSettings,
  db,
} from '@/db/schema';
import {
  backfillBrilliantCounts,
  backfillUserTimeStats,
  nextPendingGame,
  recomputeClassificationsAndAccuracies,
  refreshOpeningMetadata,
  requeueStaleErrors,
  resetRunningToPending,
  saveAnalysis,
  setAnalysisStatus,
} from '@/db/queries';
import { computeUserTimeStats } from '@/features/dashboard/progress';
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

/**
 * Module-singleton flags stored on `globalThis` rather than as
 * module-scoped variables so divergent import paths (`'@/engine/queue'`
 * vs `'/src/engine/queue.ts'` in tests, or HMR re-instantiation) all
 * see the same boot state. Without this, the queue could start twice
 * (one boot from AppLayout + one from a test-side import), each with
 * its own `started=false`, attaching duplicate visibility listeners
 * and racing two `runLoop` instances.
 */
const QUEUE_STATE_KEY = '__chessCoachQueueState';
interface QueueModuleState {
  started: boolean;
  visibilityAttached: boolean;
  priorMaxWorkers: number | null;
  /**
   * Game ids the user is actually looking at, newest request first.
   *
   * Deliberately in-memory and not a column on `Game`. It is a statement about
   * *this moment* — which review page is open — not a property of the game, and
   * it should not survive a reload: after a reload the review page mounts again
   * and asks again. A persisted priority flag would instead rot, and would sync
   * to other devices where it means nothing.
   */
  priority: string[];
  /** Abort handle for the game currently being analyzed, so a demand request can
   *  preempt it. Null when the queue is idle. */
  inFlight: { gameId: string; signal: { aborted: boolean } } | null;
}
function queueModuleState(): QueueModuleState {
  const g = globalThis as typeof globalThis & {
    [QUEUE_STATE_KEY]?: QueueModuleState;
  };
  if (!g[QUEUE_STATE_KEY]) {
    g[QUEUE_STATE_KEY] = {
      started: false,
      visibilityAttached: false,
      priorMaxWorkers: null,
      priority: [],
      inFlight: null,
    };
  }
  return g[QUEUE_STATE_KEY];
}

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
  const qstate = queueModuleState();
  if (qstate.started) return;
  qstate.started = true;

  attachVisibilityThrottle();

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

    boot.setPhase('phaseHealing');
    await bootStep('requeueStaleErrors', async () => {
      const healed = await requeueStaleErrors();
      if (healed > 0) {
        console.info(
          `[queue] requeued ${healed} stale-error games from a previous session`,
        );
      }
    });

    boot.setPhase('phaseRefreshingOpenings');
    await bootStep('refreshOpeningMetadata', async () => {
      const reopened = await refreshOpeningMetadata();
      if (reopened > 0) {
        console.info(
          `[queue] refreshed opening metadata for ${reopened} games`,
        );
      }
    });

    boot.setPhase('phaseRecomputing');
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

    // Backfill cached per-game time stats (`userTimeSec` / `userPlyCount`)
    // for games analyzed before v9 shipped. After this completes once
    // per DB, the dashboard's "Hours played" tile reads the cached
    // fields directly and never re-parses PGN on render. Version-
    // stamped + chunked + run in the background, same as the other
    // boot passes — a warm boot returns in single-digit ms.
    boot.setPhase('phaseCachingTime');
    await bootStep('backfillUserTimeStats', async () => {
      const backfilled = await backfillUserTimeStats();
      if (backfilled > 0) {
        console.info(
          `[queue] cached user-time stats for ${backfilled} games`,
        );
      }
    });

    // Stamp `brilliantCount` for games analyzed before the Games-tab
    // badge shipped. Reuses the "caching" phase label rather than adding
    // a banner of its own: it only re-reads classifications already in
    // `analyses`, so it's orders of magnitude cheaper than the recompute
    // above and finishes too fast to be worth announcing.
    await bootStep('backfillBrilliantCounts', async () => {
      const stamped = await backfillBrilliantCounts();
      if (stamped > 0) {
        console.info(`[queue] stamped brilliant counts for ${stamped} games`);
      }
    });

    clearTimeout(bannerTimer);
    boot.setPhase(null);
    boot.setStarted(false);
  })();
}

async function runLoop(): Promise<void> {
  const store = useQueueStore.getState;
  const qstate = queueModuleState();
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

      const game = await nextGameToAnalyze();
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

      // Published so `requestAnalysisNow` can abandon this game if the user
      // opens a different one. Cleared in `finally`, so an early return or throw
      // can never leave a stale handle that would abort the *next* game.
      const signal = { aborted: false };
      qstate.inFlight = { gameId: game.id, signal };

      try {
        const analysis = await analyzeGamePgn(
          game.id,
          game.pgn,
          settings.engineDepth,
          ({ ply, totalPlies }) => {
            useQueueStore.getState().setProgress(ply, totalPlies);
          },
          signal,
          {
            hasOpening: Boolean(game.eco || game.opening),
            timeControl: game.timeControl,
          },
        );
        await saveAnalysis(analysis);
        const accuracy = computeAccuracy(analysis.moves);
        // Stamp the per-game time stats while we already have the PGN
        // hot in JS heap (we just iterated every move). The dashboard's
        // "Hours played" tile reads these cached fields and falls back
        // to PGN-parsing only when absent — see `totalSecondsPlayed`.
        // Doing it here means newly-analyzed games never land in the
        // pre-backfill state where the dashboard would have to re-parse.
        const timeStats = computeUserTimeStats({
          timeClass: game.timeClass,
          timeControl: game.timeControl,
          userColor: game.userColor,
          pgn: game.pgn,
        });
        await db.games.update(game.id, {
          accuracy,
          analysisStatus: 'done',
          userTimeSec: timeStats.userTimeSec,
          userPlyCount: timeStats.userPlyCount,
          brilliantCount: countUserBrilliancies(analysis.moves, game.userColor),
        });
        // Finished normally — it is no longer something the user is waiting on.
        const done = qstate.priority.indexOf(game.id);
        if (done !== -1) qstate.priority.splice(done, 1);
      } catch (err) {
        if (signal.aborted) {
          // Preempted, not broken. Back to `pending` so it is picked up again
          // later; recording an error here would surface a scary "analysis
          // failed" on a game whose analysis we cancelled on purpose, and
          // `requeueStaleErrors` would then have to undo it.
          await setAnalysisStatus(game.id, 'pending');
        } else {
          const msg = err instanceof Error ? err.message : String(err);
          await setAnalysisStatus(game.id, 'error', msg);
        }
      } finally {
        qstate.inFlight = null;
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

/* =======================================================================
 *  Tab-visibility throttle
 * =======================================================================
 *
 *  Background tabs in Chrome/Edge are throttled aggressively (timers
 *  clamp to ~1 Hz, audio backgrounds, etc.) but Web Workers running
 *  Stockfish are NOT throttled — a hidden tab can happily peg every CPU
 *  core analyzing a backlog of games, which in practice means a hot
 *  laptop and visible battery drain when the user is doing something
 *  else in another tab.
 *
 *  Strategy: when the tab goes hidden, drop the engine pool's worker
 *  cap to 1 so analysis still progresses (we don't *stop* the queue —
 *  the user came back to a fresh-import tab specifically to have it
 *  process in the background) but at a fraction of the heat. When the
 *  user comes back, restore the prior cap.
 *
 *  Idempotent: attaching twice is a no-op (we guard with `attached`).
 *  Browser-only — `document` is undefined under SSR / vitest jsdom
 *  configs that don't include it, so we no-op cleanly there.
 */

/**
 * "I am looking at this game — analyze it next."
 *
 * Called by the review page when it lands on a game with no analysis. Two things
 * happen: the id goes to the front of the queue, and if a *different* game is
 * mid-analysis it is abandoned so the workers switch over immediately.
 *
 * ── Why preempting is nearly free ────────────────────────────────────────
 *
 * Abandoning a half-analyzed game normally means throwing away work. Here it does
 * not: `cachedAnalyze` persists every finished position to `evalCache` as it
 * completes, keyed by (fen, depth, evaluator). So the abandoned game keeps
 * whatever positions it already evaluated, and when the queue comes back to it
 * those are cache hits. The only loss is the single position in flight per worker.
 *
 * That is what makes "jump the queue" the right call rather than a trade-off.
 * Without it, opening an older unanalyzed game means waiting for every newer
 * pending game first — `nextPendingGame` is strictly newest-first — which on a
 * fresh import is minutes, not seconds.
 *
 * Idempotent and cheap: requesting the game already at the front, or the game
 * already being analyzed, does nothing.
 */
export function requestAnalysisNow(gameId: string): void {
  const qstate = queueModuleState();

  // Already the one being worked on — nothing to do. Importantly this is checked
  // BEFORE the preempt below, or a review page re-render would abort the very
  // analysis it is waiting for, forever.
  if (qstate.inFlight?.gameId === gameId) return;

  const at = qstate.priority.indexOf(gameId);
  if (at !== -1) qstate.priority.splice(at, 1);
  qstate.priority.unshift(gameId);
  // Bounded: this is a "recently viewed" list, not a backlog. Ten is far more
  // than a user can be looking at, and it stops a long browsing session from
  // accumulating an unbounded array of ids that will never be prioritized again.
  if (qstate.priority.length > 10) qstate.priority.length = 10;

  if (qstate.inFlight) {
    console.info(
      `[queue] preempting ${qstate.inFlight.gameId} for ${gameId} (user is viewing it)`,
    );
    qstate.inFlight.signal.aborted = true;
  }
}

/** Test/diagnostic seam: the current priority list, newest request first. */
export function _priorityIds(): string[] {
  return [...queueModuleState().priority];
}

/**
 * Test seam: run the pump's own game chooser.
 *
 * Exported so `analysis-priority.mjs` asserts against the real selection path
 * rather than a reimplementation of it — a hand-rolled copy of "priority first,
 * else newest" would pass even if the pump ignored the priority list entirely.
 */
export function _nextGameToAnalyzeForTest() {
  return nextGameToAnalyze();
}

/** Test seam: pretend a game is mid-analysis, so preemption can be exercised
 *  without running a real multi-second analysis. */
export function _setInFlightForTest(
  v: { gameId: string; signal: { aborted: boolean } } | null,
): void {
  queueModuleState().inFlight = v;
}

/**
 * Next game to analyze: anything the user is looking at, else newest-first.
 *
 * A priority id is dropped once it is no longer analyzable (done, or deleted), so
 * the list drains itself rather than needing separate cleanup.
 */
async function nextGameToAnalyze() {
  const qstate = queueModuleState();
  while (qstate.priority.length > 0) {
    const id = qstate.priority[0];
    const game = await db.games.get(id);
    if (game && game.analysisStatus !== 'done') return game;
    qstate.priority.shift();
  }
  return nextPendingGame();
}

/**
 * Apply a new engine-worker cap to the live pool.
 *
 * Lives here rather than in the Settings page because of the visibility throttle
 * below: while the tab is hidden the pool is deliberately shrunk to 1 and
 * `priorMaxWorkers` holds the cap to restore. Calling `pool.setMaxWorkers()`
 * directly in that state would be undone the moment the user came back to the
 * tab — the change would appear to work and then silently revert. So when hidden
 * we rewrite the remembered value and leave the pool throttled.
 */
export function applyWorkerCount(n: number): void {
  const qstate = queueModuleState();
  if (qstate.priorMaxWorkers !== null) {
    qstate.priorMaxWorkers = Math.max(1, Math.floor(n));
    return;
  }
  analysisPool().setMaxWorkers(n);
}

function attachVisibilityThrottle(): void {
  const qstate = queueModuleState();
  if (qstate.visibilityAttached) return;
  if (typeof document === 'undefined') return;
  qstate.visibilityAttached = true;

  const onVisibilityChange = () => {
    const pool = analysisPool();
    if (document.hidden) {
      if (qstate.priorMaxWorkers === null) {
        qstate.priorMaxWorkers = pool.capacity;
      }
      pool.setMaxWorkers(1);
    } else {
      if (qstate.priorMaxWorkers !== null) {
        pool.setMaxWorkers(qstate.priorMaxWorkers);
        qstate.priorMaxWorkers = null;
      }
    }
  };

  document.addEventListener('visibilitychange', onVisibilityChange);
  // Apply once on attach in case the tab is already hidden when the
  // queue boots (e.g. user opens the app, switches tabs, the queue
  // finally finishes its boot housekeeping in the background).
  onVisibilityChange();
}
