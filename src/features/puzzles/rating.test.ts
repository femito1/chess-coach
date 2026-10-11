import { describe, expect, it } from 'vitest';
import {
  MIN_RD,
  PROVISIONAL_RD,
  START_RATING,
  START_RD,
  computePuzzleRating,
  expectedScore,
  inflateRd,
  updateRating,
  type RatedEvent,
} from './rating';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 9, 1);

/** `n` events an hour apart, so idle-day inflation stays negligible. */
function run(results: boolean[], puzzleRating = 1500): RatedEvent[] {
  return results.map((win, i) => ({ at: T0 + i * HOUR, puzzleRating, win }));
}

describe('expectedScore', () => {
  it('is 0.5 at equal ratings and symmetric around it', () => {
    expect(expectedScore(1500, 1500)).toBeCloseTo(0.5, 10);
    expect(expectedScore(1700, 1500) + expectedScore(1500, 1700)).toBeCloseTo(1, 10);
    expect(expectedScore(1700, 1500)).toBeGreaterThan(0.5);
  });
});

describe('updateRating', () => {
  it('raises the rating on a win and lowers it on a loss', () => {
    const win = updateRating(1500, 200, 1500, true);
    const loss = updateRating(1500, 200, 1500, false);
    expect(win.rating).toBeGreaterThan(1500);
    expect(loss.rating).toBeLessThan(1500);
    // At equal ratings the two moves mirror each other.
    expect(win.rating - 1500).toBeCloseTo(1500 - loss.rating, 6);
  });

  it('shrinks RD with every result, but never below MIN_RD', () => {
    let rd = START_RD;
    let rating = START_RATING;
    for (let i = 0; i < 500; i++) {
      const next = updateRating(rating, rd, 1500, i % 2 === 0);
      expect(next.rd).toBeLessThanOrEqual(rd);
      expect(next.rd).toBeGreaterThanOrEqual(MIN_RD);
      rd = next.rd;
      rating = next.rating;
    }
    expect(rd).toBe(MIN_RD);
  });
});

describe('inflateRd', () => {
  it('grows with idle days and caps at START_RD', () => {
    expect(inflateRd(MIN_RD, 0)).toBe(MIN_RD);
    expect(inflateRd(MIN_RD, -5)).toBe(MIN_RD);
    const week = inflateRd(MIN_RD, 7);
    const year = inflateRd(MIN_RD, 365);
    expect(week).toBeGreaterThan(MIN_RD);
    expect(year).toBeGreaterThan(week);
    expect(inflateRd(MIN_RD, 100_000)).toBe(START_RD);
  });
});

describe('computePuzzleRating', () => {
  it('starts provisional at the start rating', () => {
    const r = computePuzzleRating([], T0);
    expect(r).toEqual({ rating: START_RATING, rd: START_RD, provisional: true, series: [] });
  });

  it('settles out of provisional after ~30 mixed results near the rating', () => {
    const events = run(Array.from({ length: 30 }, (_, i) => i % 2 === 0));
    const r = computePuzzleRating(events, events[events.length - 1].at + HOUR);
    expect(r.rd).toBeLessThan(PROVISIONAL_RD);
    expect(r.provisional).toBe(false);
    expect(Math.abs(r.rating - 1500)).toBeLessThan(50);
  });

  it('turns provisional again after a long break', () => {
    const events = run(Array.from({ length: 30 }, (_, i) => i % 2 === 0));
    const last = events[events.length - 1].at;
    expect(computePuzzleRating(events, last + 2 * DAY).provisional).toBe(false);
    expect(computePuzzleRating(events, last + 365 * DAY).provisional).toBe(true);
  });

  it('moves a newcomer well above 1500 on a run of wins against 1800s', () => {
    // The whole point of Glicko over fixed-K Elo: a large RD lets ~10
    // puzzles calibrate someone who is plainly stronger than the default.
    const events = run(Array(10).fill(true), 1800);
    const r = computePuzzleRating(events, events[9].at);
    expect(r.rating).toBeGreaterThan(1750);
  });

  it('sorts by time, so input order does not matter', () => {
    const events = run([true, false, true, true, false, false, true, false, true, true]).map(
      (e, i) => ({ ...e, puzzleRating: 1300 + i * 50 }),
    );
    const shuffled = [events[7], events[2], events[9], events[0], events[5], events[1],
      events[8], events[3], events[6], events[4]];
    const now = T0 + DAY;
    expect(computePuzzleRating(shuffled, now)).toEqual(computePuzzleRating(events, now));
  });

  it('emits one series point per event, carrying the pre-update prediction', () => {
    const events = run([true, false, true, false, true], 1600);
    const r = computePuzzleRating(events, T0 + DAY);
    expect(r.series).toHaveLength(events.length);

    // Replay by hand: each point's `expected` must be what the rating
    // BEFORE that result predicted, or theme stats would credit a result
    // with a prediction it already influenced.
    let prev = START_RATING;
    r.series.forEach((p, i) => {
      expect(p.at).toBe(events[i].at);
      expect(p.expected).toBeCloseTo(expectedScore(prev, 1600), 10);
      expect(p.delta).toBeCloseTo(p.rating - prev, 10);
      prev = p.rating;
    });
    expect(r.rating).toBe(prev);
  });
});
