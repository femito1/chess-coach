import {
  db,
  type PuzzleAttempt,
  type PuzzleAttemptEvent,
  type PuzzleOutcome,
} from '@/db/schema';
import { PUZZLE_SHARDS } from '@/data/puzzles.meta.generated';
import { loadShard, type LibraryPuzzle } from './corpus';
import { withEvent } from './events';

/**
 * Progress against the puzzle library. Thin Dexie wrapper, kept apart from
 * `corpus.ts` so puzzle *content* (fetched, immutable, shared by everyone)
 * and puzzle *progress* (local, mutable, personal) never get tangled.
 *
 * The one place they touch is the content snapshot on each row (`fen`,
 * `solution`, `themes`): a few hundred bytes that let the history grid and
 * Review work without fetching a ~400 KB shard per puzzle.
 */

export interface RecordAttemptArgs {
  puzzle: LibraryPuzzle;
  outcome: PuzzleOutcome;
  /** The solver's correct / wrong moves this attempt. */
  good: number;
  bad: number;
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
 * doesn't launder into a clean solve. (The per-attempt `history` keeps the
 * honest per-attempt outcome either way; Review reads that, not this flag.)
 */
export async function recordAttempt(args: RecordAttemptArgs): Promise<PuzzleAttempt> {
  const now = Date.now();
  const { puzzle } = args;
  let saved!: PuzzleAttempt;
  await db.transaction('rw', db.puzzleAttempts, async () => {
    const prior = await db.puzzleAttempts.get(puzzle.id);
    const hintUsed = (prior?.hintUsed ?? false) || args.outcome === 'hint';
    const event: PuzzleAttemptEvent = {
      at: now,
      outcome: args.outcome,
      good: args.good,
      bad: args.bad,
      ...(args.msTaken !== undefined ? { ms: args.msTaken } : {}),
    };
    const history = withEvent(prior, event);
    saved = {
      puzzleId: puzzle.id,
      rating: puzzle.rating,
      firstSeenAt: prior?.firstSeenAt ?? now,
      lastAttemptedAt: now,
      attempts: (prior?.attempts ?? 0) + 1,
      solvedClean:
        (prior?.solvedClean ?? false) || (args.outcome === 'clean' && !hintUsed),
      hintUsed,
      ...(args.msTaken !== undefined ? { msTaken: args.msTaken } : {}),
      history,
      fen: puzzle.fen,
      solution: puzzle.solution,
      themes: puzzle.themes,
    };
    await db.puzzleAttempts.put(saved);
  });
  return saved;
}

/**
 * Ids to keep out of a run of *new* puzzles: everything ever attempted.
 *
 * This used to be clean solves only, so a failed puzzle came straight back
 * the next time its tier ladder reached it — usually minutes later, which
 * tests short-term memory rather than the pattern. Failures now go to
 * Review instead (`stats.ts` § review), which brings them back on a spaced
 * schedule. So a fresh run is genuinely fresh, and the puzzle rating only
 * ever sees first attempts.
 *
 * Returned as a Set because the queue builders test membership once per
 * candidate row and can scan thousands of rows to fill a run.
 */
export async function loadAttemptedIds(): Promise<Set<string>> {
  const ids = new Set<string>();
  await db.puzzleAttempts.each((r) => {
    ids.add(r.puzzleId);
  });
  return ids;
}

/** A row's stored puzzle, or null for a legacy row not yet backfilled. */
export function puzzleFromAttempt(row: PuzzleAttempt): LibraryPuzzle | null {
  if (!row.fen || !row.solution || row.solution.length === 0) return null;
  return {
    id: row.puzzleId,
    fen: row.fen,
    solution: row.solution,
    rating: row.rating,
    themes: row.themes ?? [],
  };
}

/**
 * Locate a puzzle by id, using its rating to narrow the search to the one
 * or two shards whose span covers it. Shards are cut by rating, so a rating
 * on a shard boundary can sit in either neighbour; both are tried.
 */
export async function findPuzzle(id: string, rating: number): Promise<LibraryPuzzle | null> {
  const shards = PUZZLE_SHARDS.filter(
    (s) => rating >= s.minRating && rating <= s.maxRating,
  );
  for (const s of shards) {
    const hit = (await loadShard(s)).find((p) => p.id === id);
    if (hit) return hit;
  }
  return null;
}

/**
 * Copy puzzle content onto rows recorded before rows carried it.
 *
 * One-off per row: once written, the row syncs with its content and never
 * needs this again. Rows are grouped so each shard is fetched once.
 * Returns the number of rows patched.
 */
export async function backfillAttemptContent(): Promise<number> {
  const missing = (await db.puzzleAttempts.toArray()).filter((r) => !r.fen);
  let patched = 0;
  for (const row of missing) {
    const p = await findPuzzle(row.puzzleId, row.rating);
    if (!p) continue;
    await db.puzzleAttempts.update(row.puzzleId, {
      fen: p.fen,
      solution: p.solution,
      themes: p.themes,
    });
    patched++;
  }
  return patched;
}
