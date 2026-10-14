import type { PuzzleAttempt, PuzzleAttemptEvent } from '@/db/schema';

/**
 * A puzzle row's per-attempt history: reading it (`eventsOf`), appending to
 * it (`withEvent`) and capping it (`capHistory`).
 *
 * Its own module, with type-only imports, because both `stats.ts` and the
 * sync merge (`sync/diff.ts`, shared with the Node worker) need the same
 * reading of a legacy row — and the merge must not pull in the theme
 * catalogue or Dexie to get it.
 */

/** Attempts kept per puzzle. A puzzle tried 25 times has told you
 *  everything a 26th entry would. Re-exported by `sync/diff.ts`. */
export const MAX_ATTEMPT_HISTORY = 25;

/**
 * A row's attempts as events, oldest first.
 *
 * Rows recorded before `history` existed carry only aggregates, and this
 * reconstructs exactly what those can prove and no more:
 *
 *  - The FIRST attempt is knowable. One attempt + `solvedClean` → clean.
 *    Anything else → not clean: the old queue retired a puzzle on its first
 *    clean solve, so a puzzle attempted twice was not solved cleanly the
 *    first time. Which kind of failure is unknowable, so it is `mistake`.
 *  - With 2+ attempts the LAST is knowable too when `solvedClean` is set:
 *    that is the attempt that retired it.
 *  - Attempts in between are left out rather than invented. `attempts`
 *    still reports the true count.
 *
 * Synthesized events have no move counts, so they never enter move accuracy.
 */
export function eventsOf(row: PuzzleAttempt): PuzzleAttemptEvent[] {
  if (row.history && row.history.length > 0) return row.history;
  const firstClean = row.attempts <= 1 && row.solvedClean;
  const first: PuzzleAttemptEvent = {
    at: row.firstSeenAt,
    outcome: firstClean ? 'clean' : row.hintUsed && row.attempts <= 1 ? 'hint' : 'mistake',
    ...(row.attempts <= 1 && row.msTaken !== undefined ? { ms: row.msTaken } : {}),
  };
  if (row.attempts > 1 && row.solvedClean) {
    return [
      first,
      {
        at: row.lastAttemptedAt,
        outcome: 'clean',
        ...(row.msTaken !== undefined ? { ms: row.msTaken } : {}),
      },
    ];
  }
  return [first];
}

/**
 * Cap a time-sorted history to `MAX_ATTEMPT_HISTORY`: the FIRST event plus
 * the newest `MAX_ATTEMPT_HISTORY - 1`.
 *
 * The first is pinned because it is the one the rating, first-try stats and
 * band stats read (`eventsOf(row)[0]`). A plain newest-N slice dropped it on
 * the 26th attempt and silently re-keyed all of those to attempt #2. It is a
 * function of the event *set* only, so the sync merge that calls it stays
 * commutative and idempotent.
 */
export function capHistory(sorted: PuzzleAttemptEvent[]): PuzzleAttemptEvent[] {
  if (sorted.length <= MAX_ATTEMPT_HISTORY) return sorted;
  return [sorted[0], ...sorted.slice(-(MAX_ATTEMPT_HISTORY - 1))];
}

/**
 * The history after one more attempt.
 *
 * Seeds from `eventsOf(prior)`, not `prior.history`: a row recorded before
 * `history` existed has none, and appending to an empty list made the retry
 * its only event — so `eventsOf` stopped synthesizing the legacy first
 * attempt, and retrying an old miss cleanly re-scored it as a clean first
 * try (rating jump, gone from Review).
 */
export function withEvent(
  prior: PuzzleAttempt | undefined,
  event: PuzzleAttemptEvent,
): PuzzleAttemptEvent[] {
  return capHistory([...(prior ? eventsOf(prior) : []), event]);
}
