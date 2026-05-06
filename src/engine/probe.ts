/**
 * Device probe: run Stockfish on a single representative middlegame
 * position and measure how long it takes. The result feeds the
 * onboarding wizard's import-time estimator (`estimateImportTime`) so
 * users see calibrated estimates ("~12 min") rather than the
 * conservative fallback ("~25 min").
 *
 * Behaviour contract (see `PASS4_PLAN.md § Pass 4.3`):
 *
 *  - Idempotent: a second call returns the cached value from
 *    `Settings.deviceAnalysisMsPerGame` without re-running the engine.
 *    Pass `{ force: true }` to re-probe (e.g. after the user moves to a
 *    different machine via cloud restore).
 *  - Robust to engine failures: if Stockfish errors out (WASM boot
 *    crash, SAB-less host with a flaky single-thread fallback), we
 *    *still* persist a fallback value to Settings so we don't keep
 *    paying the failed-probe cost on every page load. Marked
 *    `fromFallback: true` so callers can hint that the estimate is
 *    rougher than usual.
 *  - Single-shot: runs in its own `EngineWorker`, terminates the worker
 *    when done. The onboarding flow's actual import will spin up a
 *    fresh `EnginePool` anyway — we don't want the probe leaving a hot
 *    worker around when the next thing to happen is "spin up 2-4
 *    workers for the import queue", and we don't want to share with
 *    the analysis queue (it might be picking up other games).
 */

import { EngineWorker } from './engine';
import { getSettings, updateSettings } from '@/db/schema';
import {
  FALLBACK_MS_PER_GAME_MULTI,
  FALLBACK_MS_PER_GAME_SINGLE,
} from '@/features/onboarding/estimate';

/**
 * Italian Game, after 5...d6 — a classic ply-9 middlegame the engine
 * always has to think about (no entry in the openings library at this
 * exact FEN, both sides have full material, the position is balanced
 * but rich enough that depth-16 search isn't trivial).
 */
const PROBE_FEN = 'r1bqk2r/ppp2ppp/2np1n2/2b1p3/2B1P3/2NP1N2/PPP2PPP/R1BQK2R w KQkq - 0 6';

/**
 * Typical plies-per-game for users with a mostly-rapid library. We
 * measure ms-per-position and multiply by this constant. The estimate
 * is intentionally rough — actual games range 30-120 plies — but for
 * onboarding purposes ("~10 min vs ~30 min") it's plenty.
 */
const TYPICAL_PLIES_PER_GAME = 60;

/**
 * Cap the per-game number we'll persist to a sane range. If Stockfish
 * spends 60 s on the probe (something is very wrong), we don't want to
 * tell the user their import will take 100 hours; clamp to the
 * single-thread fallback. Likewise the lower bound prevents an
 * absurdly-fast probe from making the estimate "~30 sec" for a 1000-
 * game import.
 */
const PROBE_MIN_MS_PER_GAME = 200;
const PROBE_MAX_MS_PER_GAME = 60_000;

export interface ProbeResult {
  /** Wall-clock ms taken to analyze PROBE_FEN at the user's depth. */
  msPerPosition: number;
  /** Estimated ms per game (= msPerPosition × TYPICAL_PLIES_PER_GAME),
   *  clamped to a sane range. This is what the onboarding estimator
   *  reads. */
  msPerGame: number;
  /** Whether the multi-threaded Stockfish build was used (crossOriginIsolated). */
  multiThreaded: boolean;
  /** True when we returned a hardcoded fallback (engine failed or
   *  not-runnable in this context). */
  fromFallback: boolean;
  /** True when this call returned a cached value rather than running
   *  the engine. */
  fromCache: boolean;
}

interface ProbeOpts {
  /** Force a fresh probe even if Settings already has a cached value. */
  force?: boolean;
}

/**
 * Run the device probe. Returns the cached value if one is on file,
 * otherwise spins up a one-shot worker, measures, persists, and
 * returns. Errors short-circuit to a fallback estimate.
 */
export async function probeDevice(opts: ProbeOpts = {}): Promise<ProbeResult> {
  const settings = await getSettings();
  const multiThreaded = detectMultiThreaded();

  if (!opts.force && typeof settings.deviceAnalysisMsPerGame === 'number') {
    return {
      msPerPosition: settings.deviceAnalysisMsPerGame / TYPICAL_PLIES_PER_GAME,
      msPerGame: settings.deviceAnalysisMsPerGame,
      multiThreaded,
      fromFallback: false,
      fromCache: true,
    };
  }

  const depth = settings.engineDepth ?? 16;
  const worker = new EngineWorker();

  let msPerPosition = NaN;
  let fromFallback = false;
  try {
    const t0 = performance.now();
    await worker.analyze(PROBE_FEN, depth);
    msPerPosition = performance.now() - t0;
  } catch (err) {
    // Don't throw — the onboarding flow has to make progress even on
    // a host where Stockfish is broken (e.g. SAB unavailable AND the
    // single-thread fallback also fails to load). Log for diagnosis,
    // then persist a conservative fallback so the next probe call is a
    // cache hit and we don't keep retrying on every nav.
    console.warn('[probe] engine probe failed; falling back', err);
    fromFallback = true;
  } finally {
    worker.terminate();
  }

  let msPerGame: number;
  if (fromFallback || !Number.isFinite(msPerPosition)) {
    msPerGame = multiThreaded
      ? FALLBACK_MS_PER_GAME_MULTI
      : FALLBACK_MS_PER_GAME_SINGLE;
    msPerPosition = msPerGame / TYPICAL_PLIES_PER_GAME;
    fromFallback = true;
  } else {
    msPerGame = clamp(
      msPerPosition * TYPICAL_PLIES_PER_GAME,
      PROBE_MIN_MS_PER_GAME,
      PROBE_MAX_MS_PER_GAME,
    );
  }

  await updateSettings({ deviceAnalysisMsPerGame: msPerGame });

  return {
    msPerPosition,
    msPerGame,
    multiThreaded,
    fromFallback,
    fromCache: false,
  };
}

/**
 * Same crossOriginIsolated branch logic as `engine.ts` uses to pick
 * between the multi-thread and single-thread Stockfish builds. Pulled
 * out here so the probe can label its result accurately.
 */
function detectMultiThreaded(): boolean {
  return (
    typeof SharedArrayBuffer !== 'undefined' &&
    typeof crossOriginIsolated !== 'undefined' &&
    crossOriginIsolated === true
  );
}

function clamp(n: number, lo: number, hi: number): number {
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}
