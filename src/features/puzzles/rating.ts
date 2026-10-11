/**
 * The user's puzzle rating — Glicko-1 over first attempts.
 *
 * ── Why a rating at all ────────────────────────────────────────────────
 * The page used to offer three fixed tiers (400-1299, 1300-1899, 1900+).
 * Each was ~600 points wide, so "Easy" spanned puzzles a beginner can't see
 * and puzzles a club player solves at a glance. A rating fixes that at the
 * root: difficulty becomes *relative to you* ("Normal" = puzzles near your
 * rating, "Harder" = +200), the window can be narrow (±60) because the
 * centre is right, and it follows you as you improve instead of you having
 * to notice and switch tabs.
 *
 * ── Why Glicko rather than Elo ─────────────────────────────────────────
 * A new user's rating is a guess. Glicko carries that uncertainty (`rd`) and
 * moves fast while it's large, so ~10 puzzles calibrate a newcomer instead
 * of ~50; Elo with a fixed K is either sluggish at the start or jittery
 * forever. It is also what produced the corpus's own ratings, so "rating
 * 1500" means the same thing on both sides of the comparison.
 *
 * ── What counts ────────────────────────────────────────────────────────
 * Only a puzzle's FIRST attempt. A retry tests whether you remember the
 * answer, not whether you can find it, and counting it would let Review
 * farm rating out of puzzles you already failed. A first attempt scores 1
 * only when clean — any wrong move, hint or reveal is a 0, the rule Lichess
 * applies.
 *
 * Pure: every caller passes the events, so the maths is unit-testable.
 */

export const START_RATING = 1500;
/** Glicko's "knows nothing" deviation. */
export const START_RD = 350;
/** Floor on deviation, so a long-established rating can still move. */
export const MIN_RD = 60;
/** RD above this reads as provisional ("1520?"). Same idea as Lichess's `?`. */
export const PROVISIONAL_RD = 110;
/** Deviation of the corpus's own ratings. The build keeps only puzzles with
 *  Lichess RD ≤ 90 (`MAX_RATING_DEVIATION`), so 75 is a fair typical. */
export const PUZZLE_RD = 75;
/** Deviation regained per idle day (Glicko's `c`). After a year away RD is
 *  back to ~160 — confident enough to start you in the right place, loose
 *  enough to re-calibrate in a handful of puzzles. */
const RD_PER_IDLE_DAY = 8;

const Q = Math.LN10 / 400;
const DAY_MS = 86_400_000;

export interface RatedEvent {
  at: number;
  puzzleRating: number;
  win: boolean;
}

export interface RatingPoint {
  at: number;
  rating: number;
  rd: number;
  /** Probability of a clean solve that the rating predicted BEFORE this
   *  result — what lets theme stats say "you under-perform on pins" rather
   *  than just "you fail pins", which would mostly reflect how hard the
   *  pins you happened to get were. */
  expected: number;
  delta: number;
}

export interface PuzzleRating {
  rating: number;
  rd: number;
  provisional: boolean;
  /** One point per rated event, in time order. */
  series: RatingPoint[];
}

function g(rd: number): number {
  return 1 / Math.sqrt(1 + (3 * Q * Q * rd * rd) / (Math.PI * Math.PI));
}

export function expectedScore(rating: number, puzzleRating: number): number {
  return 1 / (1 + Math.pow(10, (-g(PUZZLE_RD) * (rating - puzzleRating)) / 400));
}

/** RD after `days` without play. */
export function inflateRd(rd: number, days: number): number {
  if (days <= 0) return rd;
  return Math.min(START_RD, Math.sqrt(rd * rd + RD_PER_IDLE_DAY * RD_PER_IDLE_DAY * days));
}

/** One Glicko-1 update against a single puzzle. */
export function updateRating(
  rating: number,
  rd: number,
  puzzleRating: number,
  win: boolean,
): { rating: number; rd: number; expected: number } {
  const gj = g(PUZZLE_RD);
  const e = expectedScore(rating, puzzleRating);
  const d2 = 1 / (Q * Q * gj * gj * e * (1 - e));
  const denom = 1 / (rd * rd) + 1 / d2;
  return {
    rating: rating + (Q / denom) * gj * ((win ? 1 : 0) - e),
    rd: Math.max(MIN_RD, Math.sqrt(1 / denom)),
    expected: e,
  };
}

/**
 * Replay rated events into a current rating. `now` inflates RD for the
 * time since the last puzzle, so a rating left alone for months shows as
 * provisional again rather than claiming a precision it lost.
 */
export function computePuzzleRating(
  events: readonly RatedEvent[],
  now: number,
): PuzzleRating {
  const sorted = events.slice().sort((a, b) => a.at - b.at);
  let rating = START_RATING;
  let rd = START_RD;
  let lastAt: number | null = null;
  const series: RatingPoint[] = [];

  for (const ev of sorted) {
    if (lastAt !== null) rd = inflateRd(rd, (ev.at - lastAt) / DAY_MS);
    const next = updateRating(rating, rd, ev.puzzleRating, ev.win);
    series.push({
      at: ev.at,
      rating: next.rating,
      rd: next.rd,
      expected: next.expected,
      delta: next.rating - rating,
    });
    rating = next.rating;
    rd = next.rd;
    lastAt = ev.at;
  }

  if (lastAt !== null) rd = inflateRd(rd, (now - lastAt) / DAY_MS);
  return { rating, rd, provisional: rd > PROVISIONAL_RD, series };
}
