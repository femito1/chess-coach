/**
 * Human-like think-time helpers for engine and scripted opponent replies.
 *
 * The Stockfish search at `depth ≤ 14` from a typical mid-game position is
 * sub-second on modern hardware (often under 200 ms warm), and the puzzle
 * solver's "auto-played opponent reply" is a synchronous chess.js move
 * application — both feel uncomfortably fast next to a real game where
 * the opponent visibly "thinks" before each move.
 *
 * These helpers return a delay in milliseconds drawn from a small uniform
 * window with a per-call jitter, so back-to-back moves don't feel
 * metronomic. Keep the window narrow enough that a patient user doesn't
 * stare at an idle board, but wide enough that a quick recapture (where
 * a human would barely pause) doesn't take the same time as a deep
 * positional decision.
 *
 * Pure / no DOM — easily unit-tested. The single source of randomness is
 * `Math.random()`, so call sites can stub it for deterministic tests if
 * they need to.
 */

import type { FreePlayStrength } from '@/engine/freePlayEngine';

/** Range in ms — both inclusive on the low end. */
interface Range {
  min: number;
  max: number;
}

/**
 * Mid-window "human reply" range in milliseconds for puzzle / repertoire
 * auto-replies. Covers the common chess.com-bot feel — quick enough that
 * the user doesn't fidget, slow enough that the reply doesn't blur with
 * the user's own move animation. Used by:
 *   - PuzzlesPage opponent auto-reply (was synchronous; piece would just
 *     "appear" already moved on the same frame as the user's commit)
 *   - any other "scripted opponent" we add later.
 */
export const PUZZLE_REPLY_DELAY_MS: Range = { min: 550, max: 1100 };

/**
 * Free-play (vs Stockfish) think-time bands per strength. Lower-rated
 * play feels deliberately *faster* than top-level — humans at ~1200 don't
 * sit on every move for two seconds — but never so fast it feels
 * mechanical. Maximum-strength play has a wider window so the engine
 * appears to actually weigh complicated positions.
 */
export const FREE_PLAY_THINK_MS: Record<FreePlayStrength, Range> = {
  max: { min: 1200, max: 3000 },
  '2000': { min: 900, max: 2200 },
  '1600': { min: 700, max: 1700 },
  '1200': { min: 500, max: 1300 },
};

/** Sample a single delay from a range, uniform over `[min, max]`. */
export function sampleDelay(range: Range): number {
  const span = Math.max(0, range.max - range.min);
  return Math.round(range.min + Math.random() * span);
}

/**
 * Wait until at least `targetMs` have elapsed since `startedAt`, no-op
 * if the deadline has already passed. Used to floor an engine-move
 * commit at a human-feeling latency: we still let Stockfish search at
 * full speed (so the eval is correct), but we hold the visible move
 * commit until the floor is reached. Returns a Promise resolved when
 * the wait is done.
 */
export function waitUntilElapsed(
  startedAt: number,
  targetMs: number,
): Promise<void> {
  const remaining = targetMs - (Date.now() - startedAt);
  if (remaining <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    setTimeout(resolve, remaining);
  });
}
