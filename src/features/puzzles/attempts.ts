import { db, type PuzzleAttempt } from '@/db/schema';

/**
 * Progress against the puzzle library. Thin Dexie wrapper, kept apart from
 * `corpus.ts` so puzzle *content* (fetched, immutable, shared by everyone)
 * and puzzle *progress* (local, mutable, personal) never get tangled.
 */

export interface RecordAttemptArgs {
  puzzleId: string;
  rating: number;
  /** Solved with no wrong move and no hint. Only these retire a puzzle. */
  clean: boolean;
  hintUsed: boolean;
  msTaken?: number;
}

/**
 * Record one finished attempt, merging with any prior attempt at the same
 * puzzle.
 *
 * `solvedClean` and `hintUsed` are both sticky-once-true across attempts,
 * but for opposite reasons. A clean solve is an achievement and shouldn't
 * be erased by later practice, so once earned it stands. A hint is a
 * disclosure — you've seen part of the answer, and that can't be un-seen —
 * so it also persists, and keeps a later "clean" solve of the same puzzle
 * from being credited as unaided.
 *
 * That ordering matters: we check `hintUsed` from the *merged* record, not
 * just this attempt, so revealing a hint and then re-solving from memory
 * doesn't launder into a clean solve.
 */
export async function recordAttempt(args: RecordAttemptArgs): Promise<void> {
  const now = Date.now();
  await db.transaction('rw', db.puzzleAttempts, async () => {
    const prior = await db.puzzleAttempts.get(args.puzzleId);
    const hintUsed = (prior?.hintUsed ?? false) || args.hintUsed;
    const next: PuzzleAttempt = {
      puzzleId: args.puzzleId,
      rating: args.rating,
      firstSeenAt: prior?.firstSeenAt ?? now,
      lastAttemptedAt: now,
      attempts: (prior?.attempts ?? 0) + 1,
      solvedClean: (prior?.solvedClean ?? false) || (args.clean && !hintUsed),
      hintUsed,
      ...(args.msTaken !== undefined ? { msTaken: args.msTaken } : {}),
    };
    await db.puzzleAttempts.put(next);
  });
}

/**
 * Ids to skip when building a queue: everything solved cleanly.
 *
 * Returned as a Set because the queue builders test membership once per
 * candidate row and can scan thousands of rows to fill a run.
 *
 * Note this excludes only *clean* solves — a puzzle you got wrong, or
 * needed a hint for, stays in rotation. That's the point: those are the
 * ones still worth seeing again.
 *
 * Full scan + JS filter rather than an indexed query: `solvedClean` is a
 * boolean and IndexedDB can't index those (see the v12 schema comment). The
 * scan is over attempted puzzles only — thousands at most, not the 191k
 * corpus — so it's cheap and runs once per page mount.
 */
export async function loadSolvedIds(): Promise<Set<string>> {
  const ids = new Set<string>();
  await db.puzzleAttempts.each((r) => {
    if (r.solvedClean) ids.add(r.puzzleId);
  });
  return ids;
}

export interface PuzzleProgressStats {
  attempted: number;
  solvedClean: number;
  /** Rating of the hardest cleanly-solved puzzle. 0 when none yet. */
  bestRating: number;
  /** Mean rating of cleanly-solved puzzles. 0 when none yet — a rough
   *  "where am I" figure for the progress strip. */
  avgSolvedRating: number;
}

export async function loadProgressStats(): Promise<PuzzleProgressStats> {
  const rows = await db.puzzleAttempts.toArray();
  const clean = rows.filter((r) => r.solvedClean);
  const sum = clean.reduce((a, r) => a + r.rating, 0);
  return {
    attempted: rows.length,
    solvedClean: clean.length,
    bestRating: clean.reduce((a, r) => Math.max(a, r.rating), 0),
    avgSolvedRating: clean.length > 0 ? Math.round(sum / clean.length) : 0,
  };
}
