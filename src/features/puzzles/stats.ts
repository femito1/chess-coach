import type { PuzzleAttempt, PuzzleAttemptEvent, PuzzleOutcome } from '@/db/schema';
import {
  computePuzzleRating,
  type PuzzleRating,
  type RatedEvent,
} from './rating';
import { isSkillTheme } from './themeCatalog';

/**
 * Everything the Puzzles page derives from `puzzleAttempts`: the rating's
 * inputs, the Review schedule, and the Progress view's numbers.
 *
 * Pure and time-injected, like `recommend.ts`. Nothing here is persisted —
 * a retune of the review intervals or the theme ranking applies to all
 * history at once, with no migration.
 */

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/* =======================================================================
 *  Events
 * =======================================================================
 */

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

export function isSolved(outcome: PuzzleOutcome): boolean {
  return outcome !== 'revealed';
}

/** First attempts as rating inputs, in time order, tagged with their row so
 *  per-theme stats can line them up with the rating's predictions. */
export function ratedEvents(
  rows: readonly PuzzleAttempt[],
): (RatedEvent & { row: PuzzleAttempt })[] {
  return rows
    .map((row) => {
      const first = eventsOf(row)[0];
      return { at: first.at, puzzleRating: row.rating, win: first.outcome === 'clean', row };
    })
    .sort((a, b) => a.at - b.at);
}

export function ratingFromAttempts(
  rows: readonly PuzzleAttempt[],
  now: number,
): PuzzleRating {
  return computePuzzleRating(ratedEvents(rows), now);
}

/* =======================================================================
 *  Review — failed puzzles, brought back on a spacing schedule
 * =======================================================================
 *
 * A puzzle you got wrong is the most valuable one in the corpus: it is a
 * pattern you demonstrably don't see yet. Seeing it again in a minute tests
 * memory; seeing it again tomorrow, and then a few days later, is what makes
 * the pattern stick. So:
 *
 *   miss                          → due in ~1 day
 *   first clean retry after that  → due in 3 days
 *   second clean retry            → learned, leaves the queue
 *   any miss along the way        → back to the start
 *
 * Two steps rather than an open-ended SM-2 ladder on purpose: there are
 * always fresh puzzles of the same pattern, so the goal is to fix *this*
 * miss, not to keep one position alive for months. "~1 day" is 20 hours so
 * that reviewing at the same time each day finds yesterday's misses due.
 */

export const REVIEW_INTERVALS_MS: readonly number[] = [20 * HOUR_MS, 3 * DAY_MS];

export type ReviewStatus = 'none' | 'due' | 'later' | 'learned';

export interface ReviewState {
  status: ReviewStatus;
  /** When it next becomes due. Set for `due` and `later`. */
  dueAt?: number;
  /** Clean retries since the last miss (0..intervals). */
  stage: number;
}

export function reviewState(row: PuzzleAttempt, now: number): ReviewState {
  const events = eventsOf(row);
  let lastMiss = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].outcome !== 'clean') {
      lastMiss = i;
      break;
    }
  }
  if (lastMiss < 0) return { status: 'none', stage: 0 };
  const stage = events.length - 1 - lastMiss;
  if (stage >= REVIEW_INTERVALS_MS.length) return { status: 'learned', stage };
  const dueAt = events[events.length - 1].at + REVIEW_INTERVALS_MS[stage];
  return { status: dueAt <= now ? 'due' : 'later', dueAt, stage };
}

export interface ReviewQueue {
  /** Due now, the longest-overdue first. */
  due: PuzzleAttempt[];
  /** Not yet due, soonest first. */
  later: PuzzleAttempt[];
  /** When the soonest of `later` comes due; null when `later` is empty. */
  nextDueAt: number | null;
  learned: number;
}

export function reviewQueue(rows: readonly PuzzleAttempt[], now: number): ReviewQueue {
  const due: { row: PuzzleAttempt; at: number }[] = [];
  const later: { row: PuzzleAttempt; at: number }[] = [];
  let learned = 0;
  for (const row of rows) {
    const s = reviewState(row, now);
    if (s.status === 'due') due.push({ row, at: s.dueAt! });
    else if (s.status === 'later') later.push({ row, at: s.dueAt! });
    else if (s.status === 'learned') learned++;
  }
  later.sort((a, b) => a.at - b.at);
  return {
    due: due.sort((a, b) => a.at - b.at).map((e) => e.row),
    later: later.map((e) => e.row),
    nextDueAt: later[0]?.at ?? null,
    learned,
  };
}

/* =======================================================================
 *  Progress
 * =======================================================================
 */

export interface OverallStats {
  puzzles: number;
  attempts: number;
  /** Share of first attempts solved cleanly. Null with no attempts. */
  firstTryRate: number | null;
  /** Correct solver moves / all solver moves, over attempts that recorded
   *  move counts. Null until one has. */
  moveAccuracy: number | null;
  /** Median time of clean solves. Median, because one puzzle left open
   *  over lunch would wreck a mean. */
  medianCleanMs: number | null;
  /** Consecutive days, ending today or yesterday, with at least one attempt. */
  dayStreak: number;
  /** Attempts this calendar day, retries included, and how many were clean. */
  today: { attempts: number; clean: number };
}

export function overallStats(rows: readonly PuzzleAttempt[], now: number): OverallStats {
  let attempts = 0;
  let firstClean = 0;
  let good = 0;
  let total = 0;
  const cleanMs: number[] = [];
  const days = new Set<string>();
  const todayKey = dayKey(now);
  const today = { attempts: 0, clean: 0 };

  for (const row of rows) {
    attempts += row.attempts;
    const events = eventsOf(row);
    if (events[0].outcome === 'clean') firstClean++;
    for (const e of events) {
      days.add(dayKey(e.at));
      if (e.good !== undefined && e.bad !== undefined) {
        good += e.good;
        total += e.good + e.bad;
      }
      if (e.outcome === 'clean' && e.ms !== undefined) cleanMs.push(e.ms);
      if (dayKey(e.at) === todayKey) {
        today.attempts++;
        if (e.outcome === 'clean') today.clean++;
      }
    }
  }

  cleanMs.sort((a, b) => a - b);
  return {
    puzzles: rows.length,
    attempts,
    firstTryRate: rows.length > 0 ? firstClean / rows.length : null,
    moveAccuracy: total > 0 ? good / total : null,
    medianCleanMs: cleanMs.length > 0 ? cleanMs[Math.floor(cleanMs.length / 2)] : null,
    dayStreak: dayStreak(days, now),
    today,
  };
}

function dayStreak(days: Set<string>, now: number): number {
  // A streak survives until the end of the day after the last active one —
  // opening the page in the morning shouldn't read "0" before you've played.
  // Steps by calendar day, not by 24h: a fixed step skips the 23-hour day
  // of a spring-forward change when run just after midnight.
  const d = new Date(now);
  const back = () => d.setDate(d.getDate() - 1);
  if (!days.has(dayKey(d.getTime()))) back();
  let n = 0;
  while (days.has(dayKey(d.getTime()))) {
    n++;
    back();
  }
  return n;
}

/** Local calendar day, `YYYY-MM-DD`. Local because "today" is the user's. */
export function dayKey(ms: number): string {
  const d = new Date(ms);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

/** Attempts per local day, for the activity calendar. */
export function activityByDay(rows: readonly PuzzleAttempt[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const row of rows) {
    for (const e of eventsOf(row)) {
      const k = dayKey(e.at);
      out.set(k, (out.get(k) ?? 0) + 1);
    }
  }
  return out;
}

export interface BandStat {
  /** Lower bound of the 100-point band. */
  lo: number;
  attempts: number;
  clean: number;
}

/** First-try results per 100-point band of puzzle rating — "where does my
 *  solving fall off", which a single rating number can't show. */
export function bandStats(rows: readonly PuzzleAttempt[]): BandStat[] {
  const byLo = new Map<number, BandStat>();
  for (const row of rows) {
    const lo = Math.floor(row.rating / 100) * 100;
    const b = byLo.get(lo) ?? { lo, attempts: 0, clean: 0 };
    b.attempts++;
    if (eventsOf(row)[0].outcome === 'clean') b.clean++;
    byLo.set(lo, b);
  }
  return [...byLo.values()].sort((a, b) => a.lo - b.lo);
}

/** First attempts at a theme before its success rate is ranked. Below this,
 *  one unlucky puzzle swings the rate by 25+ points. */
export const MIN_THEME_SAMPLE = 4;

export interface ThemeStat {
  theme: string;
  attempts: number;
  clean: number;
  /** Clean solves the rating predicted, summed over these attempts. */
  expected: number;
  /** (clean − expected) / attempts: how far above (+) or below (−) your own
   *  rating you perform on this theme. The ranking key — raw success rate
   *  would mostly rank themes by how hard their puzzles happened to be
   *  (mates-in-1 are easy, so "you're great at mate in 1" says nothing). */
  edge: number;
}

/**
 * Per-theme first-attempt performance relative to what your rating
 * predicted at the time. Sorted weakest first; themes under
 * `MIN_THEME_SAMPLE` come last, unranked.
 */
export function themeStats(rows: readonly PuzzleAttempt[], now: number): ThemeStat[] {
  const events = ratedEvents(rows);
  const rating = computePuzzleRating(events, now);
  const byTheme = new Map<string, ThemeStat>();
  events.forEach((ev, i) => {
    const expected = rating.series[i]?.expected ?? 0.5;
    for (const theme of ev.row.themes ?? []) {
      if (!isSkillTheme(theme)) continue;
      const s = byTheme.get(theme) ?? { theme, attempts: 0, clean: 0, expected: 0, edge: 0 };
      s.attempts++;
      if (ev.win) s.clean++;
      s.expected += expected;
      byTheme.set(theme, s);
    }
  });
  const out = [...byTheme.values()];
  for (const s of out) s.edge = (s.clean - s.expected) / s.attempts;
  const ranked = (s: ThemeStat) => s.attempts >= MIN_THEME_SAMPLE;
  return out.sort(
    (a, b) =>
      Number(ranked(b)) - Number(ranked(a)) ||
      (ranked(a) ? a.edge - b.edge : b.attempts - a.attempts) ||
      (a.theme < b.theme ? -1 : 1),
  );
}

/* =======================================================================
 *  Per-puzzle summary, for the history grid
 * =======================================================================
 */

export interface PuzzleSummary {
  row: PuzzleAttempt;
  events: PuzzleAttemptEvent[];
  first: PuzzleOutcome;
  last: PuzzleOutcome;
  /** Of the recorded attempts, how many were clean. */
  cleanCount: number;
  /** Correct solver moves / all solver moves across attempts, or null when
   *  no attempt recorded move counts. */
  moveAccuracy: number | null;
  /** Fastest clean solve. */
  bestMs: number | null;
  review: ReviewState;
}

export function summarize(row: PuzzleAttempt, now: number): PuzzleSummary {
  const events = eventsOf(row);
  let good = 0;
  let total = 0;
  let cleanCount = 0;
  let bestMs: number | null = null;
  for (const e of events) {
    if (e.outcome === 'clean') {
      cleanCount++;
      if (e.ms !== undefined && (bestMs === null || e.ms < bestMs)) bestMs = e.ms;
    }
    if (e.good !== undefined && e.bad !== undefined) {
      good += e.good;
      total += e.good + e.bad;
    }
  }
  return {
    row,
    events,
    first: events[0].outcome,
    last: events[events.length - 1].outcome,
    cleanCount,
    moveAccuracy: total > 0 ? good / total : null,
    bestMs,
    review: reviewState(row, now),
  };
}
