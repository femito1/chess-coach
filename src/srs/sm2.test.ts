import { describe, expect, it } from 'vitest';
import { gradeSrs, isDue, newSrsState, summarizeIntervals } from './sm2';

const NOW = 1_700_000_000_000; // fixed timestamp so tests are deterministic
const DAY_MS = 86_400_000;

describe('newSrsState', () => {
  it('seeds an unreviewed card as due now with default ease', () => {
    const s = newSrsState(NOW);
    expect(s.ease).toBe(2.5);
    expect(s.intervalDays).toBe(0);
    expect(s.reps).toBe(0);
    expect(s.lapses).toBe(0);
    expect(s.dueAt).toBe(NOW);
  });
});

describe('gradeSrs', () => {
  it('schedules first "good" review one day out', () => {
    const next = gradeSrs(newSrsState(NOW), 'good', NOW);
    expect(next.reps).toBe(1);
    expect(next.intervalDays).toBe(1);
    expect(next.dueAt).toBe(NOW + 1 * DAY_MS);
    expect(next.lastReviewedAt).toBe(NOW);
  });

  it('uses the SM-2 fixed step at reps=2 (3 days for "good")', () => {
    let s = newSrsState(NOW);
    s = gradeSrs(s, 'good', NOW);
    s = gradeSrs(s, 'good', NOW);
    expect(s.reps).toBe(2);
    expect(s.intervalDays).toBe(3);
  });

  it('multiplies by ease on later "good" reviews', () => {
    let s = newSrsState(NOW);
    s = gradeSrs(s, 'good', NOW);
    s = gradeSrs(s, 'good', NOW);
    const before = s.intervalDays;
    s = gradeSrs(s, 'good', NOW);
    expect(s.intervalDays).toBeGreaterThan(before);
  });

  it('lapses bump the lapse counter and reset reps', () => {
    let s = newSrsState(NOW);
    s = gradeSrs(s, 'good', NOW);
    s = gradeSrs(s, 'again', NOW);
    expect(s.lapses).toBe(1);
    expect(s.reps).toBe(0);
    // 10 minutes ≈ 0.007 days, so dueAt is well within an hour.
    expect(s.dueAt - NOW).toBeLessThan(DAY_MS);
  });

  it('clamps ease at 1.3', () => {
    let s = newSrsState(NOW);
    for (let i = 0; i < 20; i++) s = gradeSrs(s, 'again', NOW);
    expect(s.ease).toBeGreaterThanOrEqual(1.3);
    expect(s.ease).toBeLessThanOrEqual(1.31);
  });

  it('"easy" grows the interval faster than "good"', () => {
    let goodSeq = newSrsState(NOW);
    let easySeq = newSrsState(NOW);
    for (let i = 0; i < 4; i++) {
      goodSeq = gradeSrs(goodSeq, 'good', NOW);
      easySeq = gradeSrs(easySeq, 'easy', NOW);
    }
    expect(easySeq.intervalDays).toBeGreaterThan(goodSeq.intervalDays);
  });
});

describe('isDue', () => {
  it('treats undefined state as due', () => {
    expect(isDue(undefined, NOW)).toBe(true);
  });
  it('returns true when dueAt has passed', () => {
    expect(isDue({ ease: 2.5, intervalDays: 1, reps: 1, dueAt: NOW - 1, lapses: 0 }, NOW)).toBe(
      true,
    );
  });
  it('returns false when dueAt is in the future', () => {
    expect(
      isDue({ ease: 2.5, intervalDays: 1, reps: 1, dueAt: NOW + DAY_MS, lapses: 0 }, NOW),
    ).toBe(false);
  });
});

describe('summarizeIntervals', () => {
  it('formats sub-day intervals as minutes', () => {
    expect(summarizeIntervals(10 / 1440)).toBe('10m');
  });
  it('formats <30d as days', () => {
    expect(summarizeIntervals(5)).toBe('5d');
  });
  it('formats <365d as months', () => {
    expect(summarizeIntervals(60)).toBe('2mo');
  });
  it('formats >=365d as years', () => {
    expect(summarizeIntervals(800)).toBe('2.2y');
  });
});
