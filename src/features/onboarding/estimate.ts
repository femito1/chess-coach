/**
 * Pure-logic helpers for the onboarding import-time estimator.
 *
 * Maps `(gameCount, msPerGame, workers)` → human-readable wall-clock
 * estimates. Centralised here so the wizard renderer + future "expand
 * import history" buttons in Settings agree on the numbers.
 *
 * The estimate is intentionally rough — Stockfish runtime varies per
 * position (sharp middlegames are slower than book lines), and the eval
 * cache cuts shared opening prefixes to ~0 so warm-import is faster than
 * cold-import. We round generously up so users aren't surprised by
 * "should-take-12-min, actually-took-22-min" — under-promising is the
 * goal.
 */

/**
 * Fallback per-game analysis time when the device probe hasn't run or
 * returned an unusable number. These are conservative middle-of-the-road
 * estimates tuned to what we measured on a 2024 mid-range laptop.
 *
 * Multi-thread vs single-thread matters because COOP/COEP-less hosts
 * (e.g. plain GitHub Pages) fall back to single-thread Stockfish. The gap is
 * **~11×**, not the 3–4× this comment used to claim: that older figure predates
 * NNUE, and the `-single` build is dramatically worse at NNUE specifically.
 * Measured on one 59-ply game, depth 18, 4 workers:
 *
 *     stockfish-nnue-16.js         (threaded)    9 716 ms
 *     stockfish-nnue-16-single.js  (fallback)  110 199 ms
 *
 * The probe picks the real number up automatically; these constants only apply
 * when it hasn't run or returned something unusable, so an understated fallback
 * shows a new user "~20 min" for an import that will actually take hours.
 */
export const FALLBACK_MS_PER_GAME_MULTI = 8_000;
export const FALLBACK_MS_PER_GAME_SINGLE = 90_000;

export interface ImportTimeEstimate {
  /** Estimated wall-clock seconds. Best for sorting/comparison. */
  totalSeconds: number;
  /** Same number, formatted for display ("~12 min", "~2 hr"). */
  label: string;
}

/**
 * Estimate wall-clock time to analyze `gameCount` games at `msPerGame`
 * each, assuming `workers` Stockfish workers run in parallel. Returns
 * both the raw number and a rounded human label.
 *
 * `workers` defaults to 2, which matches the queue's default
 * `EnginePool.maxWorkers` for initial-import throttling. Caller can
 * override (e.g. when the user chose "high priority" and the pool is
 * running 4 workers).
 *
 * Empty / non-positive `gameCount` returns "~0 sec" — caller is expected
 * to hide the estimate row in that case rather than displaying it.
 */
export function estimateImportTime(
  gameCount: number,
  msPerGame: number,
  workers = 2,
): ImportTimeEstimate {
  const safeWorkers = Math.max(1, workers | 0);
  const safeMs = msPerGame > 0 ? msPerGame : FALLBACK_MS_PER_GAME_MULTI;
  const safeGames = gameCount > 0 ? gameCount | 0 : 0;
  const totalMs = (safeGames * safeMs) / safeWorkers;
  const totalSeconds = Math.ceil(totalMs / 1000);
  return { totalSeconds, label: formatDuration(totalSeconds) };
}

/**
 * Format a wall-clock duration as a coarse "~N unit" string. Rounds up
 * generously so we don't under-promise: "1 min 35 sec" → "~2 min".
 *
 * Units used (in increasing magnitude):
 *   < 1 min      → seconds, no rounding
 *   < 1 hr       → minutes, ceiling
 *   < 24 hr      → hours, ceiling, with optional half-hour granularity
 *   ≥ 24 hr      → "more than a day"
 */
export function formatDuration(totalSeconds: number): string {
  if (totalSeconds <= 0) return '~0 sec';
  if (totalSeconds < 60) return `~${totalSeconds} sec`;
  // Sub-hour: minutes, ceiling. We use < 60 min (not < 60 totalSeconds /
  // 3600) so that exactly 60 min collapses into the hour branch below.
  const totalMinutes = Math.ceil(totalSeconds / 60);
  if (totalMinutes < 60) {
    return `~${totalMinutes} min`;
  }
  // Sub-day: half-hour granularity in the 1-to-24-hr range so the
  // user can distinguish "1 hr" from "1.5 hr".
  if (totalSeconds < 86_400) {
    const halfHours = Math.ceil((totalSeconds / 3600) * 2) / 2;
    if (halfHours <= 24) return `~${halfHours} hr`;
  }
  return 'more than a day';
}
