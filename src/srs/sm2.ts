import type { SrsState } from '@/db/schema';

/**
 * Simplified SM-2. Grade maps to SuperMemo quality:
 *   again = 0, hard = 3, good = 4, easy = 5.
 */
export type Grade = 'again' | 'hard' | 'good' | 'easy';

const DAY_MS = 86_400_000;

export function newSrsState(now = Date.now()): SrsState {
  return {
    ease: 2.5,
    intervalDays: 0,
    reps: 0,
    dueAt: now,
    lapses: 0,
  };
}

export function gradeSrs(state: SrsState, grade: Grade, now = Date.now()): SrsState {
  const q = grade === 'again' ? 0 : grade === 'hard' ? 3 : grade === 'good' ? 4 : 5;
  let { ease, intervalDays, reps, lapses } = state;

  // Ease update (SM-2 formula, clamped at 1.3).
  ease = ease + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02));
  if (ease < 1.3) ease = 1.3;

  if (grade === 'again') {
    lapses++;
    reps = 0;
    // Re-show in 10 minutes on fail; we approximate that as 0.007 days.
    intervalDays = 10 / 1440;
  } else {
    reps++;
    if (reps === 1) intervalDays = 1;
    else if (reps === 2) intervalDays = 3;
    else intervalDays = Math.round(intervalDays * ease * 10) / 10;
    if (grade === 'hard') intervalDays = Math.max(1, intervalDays * 0.8);
    if (grade === 'easy') intervalDays = intervalDays * 1.3;
  }

  return {
    ease,
    intervalDays,
    reps,
    lapses,
    dueAt: now + intervalDays * DAY_MS,
    lastReviewedAt: now,
  };
}

/** True when an SRS card is due for review right now. */
export function isDue(state: SrsState | undefined, now = Date.now()): boolean {
  if (!state) return true;
  return state.dueAt <= now;
}

export function summarizeIntervals(intervalDays: number): string {
  if (intervalDays < 1) {
    const mins = Math.max(1, Math.round(intervalDays * 1440));
    return `${mins}m`;
  }
  if (intervalDays < 30) return `${Math.round(intervalDays)}d`;
  if (intervalDays < 365) return `${Math.round(intervalDays / 30)}mo`;
  return `${(intervalDays / 365).toFixed(1)}y`;
}
