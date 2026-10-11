import { describe, expect, it } from 'vitest';
import type { PuzzleAttempt, PuzzleAttemptEvent, PuzzleOutcome } from '@/db/schema';
import {
  MIN_THEME_SAMPLE,
  REVIEW_INTERVALS_MS,
  bandStats,
  dayKey,
  eventsOf,
  overallStats,
  reviewQueue,
  reviewState,
  summarize,
  themeStats,
} from './stats';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Local noon, so ±24h steps never cross a calendar-day edge even on a
 *  DST-change day, whatever TZ the runner is in. */
const local = (m: number, d: number, h = 12) => new Date(2026, m, d, h).getTime();
const T0 = local(9, 1);

const row = (over: Partial<PuzzleAttempt> = {}): PuzzleAttempt => ({
  puzzleId: 'p1',
  firstSeenAt: T0,
  lastAttemptedAt: T0,
  attempts: 1,
  solvedClean: false,
  hintUsed: false,
  rating: 1500,
  ...over,
});

const ev = (at: number, outcome: PuzzleOutcome, extra: Partial<PuzzleAttemptEvent> = {}) => ({
  at,
  outcome,
  ...extra,
});

/** A row whose recorded history is exactly `events`. */
const withHistory = (events: PuzzleAttemptEvent[], over: Partial<PuzzleAttempt> = {}) =>
  row({
    firstSeenAt: events[0].at,
    lastAttemptedAt: events[events.length - 1].at,
    attempts: events.length,
    history: events,
    ...over,
  });

/* ---------- events ------------------------------------------------------ */

describe('eventsOf — legacy rows', () => {
  it('one clean attempt is a clean event, with its time', () => {
    expect(eventsOf(row({ solvedClean: true, msTaken: 4_000 }))).toEqual([
      { at: T0, outcome: 'clean', ms: 4_000 },
    ]);
  });

  it('one unclean attempt is a hint or a mistake, per hintUsed', () => {
    expect(eventsOf(row({ hintUsed: true }))).toEqual([{ at: T0, outcome: 'hint' }]);
    expect(eventsOf(row({ hintUsed: false }))).toEqual([{ at: T0, outcome: 'mistake' }]);
  });

  it('several attempts ending clean: a first miss and the retiring clean solve', () => {
    // The old queue retired a puzzle on its first clean solve, so a puzzle
    // seen 3 times was missed first and solved last. The middle attempt is
    // unknowable and must not be invented.
    const r = row({
      attempts: 3,
      solvedClean: true,
      hintUsed: true,
      firstSeenAt: T0,
      lastAttemptedAt: T0 + 2 * DAY,
      msTaken: 9_000,
    });
    expect(eventsOf(r)).toEqual([
      { at: T0, outcome: 'mistake' },
      { at: T0 + 2 * DAY, outcome: 'clean', ms: 9_000 },
    ]);
  });

  it('several attempts never clean: only the first miss is knowable', () => {
    const r = row({ attempts: 2, lastAttemptedAt: T0 + DAY, msTaken: 3_000 });
    expect(eventsOf(r)).toEqual([{ at: T0, outcome: 'mistake' }]);
  });

  it('returns recorded history as is', () => {
    const history = [ev(T0, 'hint'), ev(T0 + DAY, 'clean', { ms: 2_000, good: 3, bad: 0 })];
    // Aggregates that disagree with the history must not leak in.
    expect(eventsOf(row({ history, solvedClean: true, attempts: 1 }))).toBe(history);
  });

  it('treats an empty history as legacy', () => {
    expect(eventsOf(row({ history: [], solvedClean: true }))).toEqual([
      { at: T0, outcome: 'clean' },
    ]);
  });
});

/* ---------- review ------------------------------------------------------ */

describe('reviewState', () => {
  const [FIRST, SECOND] = REVIEW_INTERVALS_MS;

  it('never queues a puzzle solved cleanly first time', () => {
    expect(reviewState(withHistory([ev(T0, 'clean')]), T0 + 10 * DAY)).toEqual({
      status: 'none',
      stage: 0,
    });
  });

  it('a miss comes due after 20 hours, not before', () => {
    const r = withHistory([ev(T0, 'mistake')]);
    expect(FIRST).toBe(20 * HOUR);
    expect(reviewState(r, T0 + 20 * HOUR - 1)).toEqual({
      status: 'later',
      dueAt: T0 + 20 * HOUR,
      stage: 0,
    });
    expect(reviewState(r, T0 + 20 * HOUR).status).toBe('due');
  });

  it('one clean retry after a miss waits 3 days from that retry', () => {
    const retry = T0 + DAY;
    const r = withHistory([ev(T0, 'mistake'), ev(retry, 'clean')]);
    expect(SECOND).toBe(3 * DAY);
    expect(reviewState(r, retry + 3 * DAY - 1)).toEqual({
      status: 'later',
      dueAt: retry + 3 * DAY,
      stage: 1,
    });
    expect(reviewState(r, retry + 3 * DAY).status).toBe('due');
  });

  it('two clean retries after a miss is learned', () => {
    const r = withHistory([ev(T0, 'mistake'), ev(T0 + DAY, 'clean'), ev(T0 + 4 * DAY, 'clean')]);
    expect(reviewState(r, T0 + 100 * DAY)).toEqual({ status: 'learned', stage: 2 });
  });

  it('a miss along the way sends it back to stage 0', () => {
    const r = withHistory([ev(T0, 'mistake'), ev(T0 + DAY, 'clean'), ev(T0 + 4 * DAY, 'revealed')]);
    expect(reviewState(r, T0 + 4 * DAY)).toEqual({
      status: 'later',
      dueAt: T0 + 4 * DAY + FIRST,
      stage: 0,
    });
  });
});

describe('reviewQueue', () => {
  it('orders due by longest-overdue and later by soonest, and counts learned', () => {
    const now = T0 + 10 * DAY;
    const dueOld = withHistory([ev(T0, 'mistake')], { puzzleId: 'dueOld' });
    const dueNew = withHistory([ev(now - 21 * HOUR, 'hint')], { puzzleId: 'dueNew' });
    const laterSoon = withHistory([ev(now - 19 * HOUR, 'mistake')], { puzzleId: 'laterSoon' });
    const laterFar = withHistory([ev(now - DAY, 'mistake'), ev(now - HOUR, 'clean')], {
      puzzleId: 'laterFar',
    });
    const learned = withHistory([ev(T0, 'mistake'), ev(T0 + DAY, 'clean'), ev(T0 + 4 * DAY, 'clean')], {
      puzzleId: 'learned',
    });
    const clean = withHistory([ev(T0, 'clean')], { puzzleId: 'clean' });

    const q = reviewQueue([laterFar, clean, dueNew, learned, laterSoon, dueOld], now);
    expect(q.due.map((r) => r.puzzleId)).toEqual(['dueOld', 'dueNew']);
    expect(q.later.map((r) => r.puzzleId)).toEqual(['laterSoon', 'laterFar']);
    expect(q.learned).toBe(1);
    // laterSoon's miss was 19h ago, so it comes due in an hour.
    expect(q.nextDueAt).toBe(now + HOUR);
  });

  it('has no nextDueAt when nothing is waiting', () => {
    const now = T0 + 10 * DAY;
    const due = withHistory([ev(T0, 'mistake')]);
    expect(reviewQueue([due], now).nextDueAt).toBeNull();
    expect(reviewQueue([], now)).toEqual({ due: [], later: [], nextDueAt: null, learned: 0 });
  });
});

/* ---------- progress ---------------------------------------------------- */

describe('overallStats', () => {
  const NOW = local(9, 11);

  it('is all-null with no rows', () => {
    expect(overallStats([], NOW)).toEqual({
      puzzles: 0,
      attempts: 0,
      firstTryRate: null,
      moveAccuracy: null,
      medianCleanMs: null,
      dayStreak: 0,
      today: { attempts: 0, clean: 0 },
    });
  });

  it('first-try rate counts only first attempts', () => {
    const rows = [
      withHistory([ev(T0, 'clean')]),
      withHistory([ev(T0, 'mistake'), ev(T0 + DAY, 'clean')]),
      withHistory([ev(T0, 'hint')]),
      withHistory([ev(T0, 'clean'), ev(T0 + DAY, 'mistake')]),
    ];
    const s = overallStats(rows, NOW);
    expect(s.puzzles).toBe(4);
    expect(s.attempts).toBe(6);
    expect(s.firstTryRate).toBe(0.5);
  });

  it('move accuracy uses only events that recorded move counts', () => {
    const rows = [
      withHistory([ev(T0, 'clean', { good: 3, bad: 0 }), ev(T0 + DAY, 'mistake', { good: 1, bad: 2 })]),
      // A legacy row and an event missing `bad` must not dilute the ratio.
      row({ solvedClean: true }),
      withHistory([ev(T0, 'mistake', { good: 5 })]),
    ];
    expect(overallStats(rows, NOW).moveAccuracy).toBeCloseTo(4 / 6, 10);
  });

  it('median clean time ignores unclean attempts', () => {
    const rows = [
      withHistory([ev(T0, 'clean', { ms: 1_000 })]),
      withHistory([ev(T0, 'clean', { ms: 9_000 })]),
      withHistory([ev(T0, 'mistake', { ms: 100 }), ev(T0 + DAY, 'clean', { ms: 4_000 })]),
    ];
    expect(overallStats(rows, NOW).medianCleanMs).toBe(4_000);
  });

  it('counts today’s attempts and clean ones', () => {
    const rows = [
      withHistory([ev(local(9, 11, 8), 'mistake'), ev(local(9, 11, 10), 'clean')]),
      withHistory([ev(local(9, 10, 23), 'clean')]),
    ];
    expect(overallStats(rows, NOW).today).toEqual({ attempts: 2, clean: 1 });
  });

  describe('dayStreak', () => {
    const streak = (days: number[], now = NOW) =>
      overallStats(
        days.map((d, i) => withHistory([ev(local(9, d, 9), 'clean')], { puzzleId: `p${i}` })),
        now,
      ).dayStreak;

    it('counts consecutive days ending today', () => {
      expect(streak([11, 10, 9])).toBe(3);
    });

    it('still counts when the last active day was yesterday', () => {
      // Opening the page in the morning shouldn't read 0 before you've played.
      expect(streak([10, 9, 8])).toBe(3);
    });

    it('is 0 once a whole day has been missed', () => {
      expect(streak([9, 8])).toBe(0);
    });

    it('stops at the first gap', () => {
      expect(streak([11, 10, 8, 7])).toBe(2);
    });

    it('counts several attempts on one day once', () => {
      expect(streak([11, 11, 11])).toBe(1);
    });
  });
});

describe('dayKey', () => {
  it('formats the local calendar day, zero-padded', () => {
    expect(dayKey(new Date(2026, 0, 5, 23, 59).getTime())).toBe('2026-01-05');
    expect(dayKey(new Date(2026, 11, 31, 0, 0).getTime())).toBe('2026-12-31');
  });
});

describe('bandStats', () => {
  it('buckets first attempts by 100-point band, ascending', () => {
    const rows = [
      withHistory([ev(T0, 'clean')], { rating: 1720 }),
      withHistory([ev(T0, 'clean')], { rating: 1450 }),
      withHistory([ev(T0, 'mistake'), ev(T0 + DAY, 'clean')], { rating: 1499 }),
      withHistory([ev(T0, 'hint')], { rating: 1500 }),
    ];
    expect(bandStats(rows)).toEqual([
      { lo: 1400, attempts: 2, clean: 1 },
      { lo: 1500, attempts: 1, clean: 0 },
      { lo: 1700, attempts: 1, clean: 1 },
    ]);
  });
});

describe('themeStats', () => {
  it('ranks the under-performing theme first and unranked themes last', () => {
    // Forks always solved, pins always missed, at the same puzzle rating —
    // so the rating's predictions are comparable and pins must come first.
    // Every row also carries 'crushing', a descriptor that is not a skill.
    const rows: PuzzleAttempt[] = [];
    for (let i = 0; i < 6; i++) {
      rows.push(
        withHistory([ev(T0 + (2 * i) * HOUR, 'clean')], {
          puzzleId: `f${i}`,
          themes: ['fork', 'crushing'],
        }),
        withHistory([ev(T0 + (2 * i + 1) * HOUR, 'mistake')], {
          puzzleId: `p${i}`,
          themes: ['pin', 'crushing'],
        }),
      );
    }
    rows.push(
      withHistory([ev(T0 + 20 * HOUR, 'mistake')], { puzzleId: 's0', themes: ['skewer'] }),
      withHistory([ev(T0 + 21 * HOUR, 'mistake')], { puzzleId: 's1', themes: ['skewer'] }),
    );

    const stats = themeStats(rows, T0 + DAY);
    expect(stats.map((s) => s.theme)).toEqual(['pin', 'fork', 'skewer']);
    expect(stats[0].edge).toBeLessThan(0);
    expect(stats[1].edge).toBeGreaterThan(0);
    // Skewer is the worst by raw rate but has too few samples to rank.
    expect(stats[2].attempts).toBeLessThan(MIN_THEME_SAMPLE);

    const pin = stats[0];
    expect(pin.attempts).toBe(6);
    expect(pin.clean).toBe(0);
    expect(pin.edge).toBeCloseTo((pin.clean - pin.expected) / pin.attempts, 10);
  });
});

describe('summarize', () => {
  it('summarizes a row’s attempts', () => {
    const r = withHistory([
      ev(T0, 'mistake', { ms: 500, good: 1, bad: 1 }),
      ev(T0 + DAY, 'clean', { ms: 6_000, good: 2, bad: 0 }),
      ev(T0 + 2 * DAY, 'clean', { ms: 3_000 }),
    ]);
    const s = summarize(r, T0 + 3 * DAY);
    expect(s.first).toBe('mistake');
    expect(s.last).toBe('clean');
    expect(s.cleanCount).toBe(2);
    expect(s.moveAccuracy).toBeCloseTo(3 / 4, 10);
    // Fastest CLEAN solve — the quicker miss doesn't count.
    expect(s.bestMs).toBe(3_000);
    expect(s.review.status).toBe('learned');
  });
});
