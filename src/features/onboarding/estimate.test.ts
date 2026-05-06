import { describe, expect, it } from 'vitest';
import {
  FALLBACK_MS_PER_GAME_MULTI,
  estimateImportTime,
  formatDuration,
} from './estimate';

describe('estimateImportTime', () => {
  it('divides total time across workers', () => {
    const e = estimateImportTime(100, 8000, 2);
    expect(e.totalSeconds).toBe(400);
    expect(e.label).toBe('~7 min');
  });

  it('caps workers to >= 1', () => {
    const e = estimateImportTime(10, 1000, 0);
    // 0 workers must not divide-by-zero.
    expect(e.totalSeconds).toBeGreaterThan(0);
  });

  it('uses fallback ms when probe time is missing or non-positive', () => {
    const expected = (50 * FALLBACK_MS_PER_GAME_MULTI) / 2 / 1000;
    expect(estimateImportTime(50, 0, 2).totalSeconds).toBe(expected);
    expect(estimateImportTime(50, -1, 2).totalSeconds).toBe(expected);
  });

  it('returns ~0 sec for zero games', () => {
    const e = estimateImportTime(0, 8000, 2);
    expect(e.totalSeconds).toBe(0);
    expect(e.label).toBe('~0 sec');
  });

  it('rounds the seconds up so we under-promise', () => {
    // 7 games × 1500 ms / 2 workers = 5250 ms = 5.25 sec → ceil to 6
    const e = estimateImportTime(7, 1500, 2);
    expect(e.totalSeconds).toBe(6);
  });
});

describe('formatDuration', () => {
  it('formats sub-minute as seconds', () => {
    expect(formatDuration(0)).toBe('~0 sec');
    expect(formatDuration(1)).toBe('~1 sec');
    expect(formatDuration(59)).toBe('~59 sec');
  });

  it('formats sub-hour as ceiling-minutes', () => {
    expect(formatDuration(60)).toBe('~1 min');
    expect(formatDuration(61)).toBe('~2 min');
    expect(formatDuration(599)).toBe('~10 min');
    // Boundary case: 3599 sec rounds up to 60 min, but we'd rather say
    // "~1 hr" than "~60 min" since they're the same and the latter is
    // less natural. Verifies the if-totalMinutes-<-60 guard.
    expect(formatDuration(3599)).toBe('~1 hr');
  });

  it('formats sub-day as half-hour-rounded hours', () => {
    expect(formatDuration(3600)).toBe('~1 hr');
    // 1 hr 5 min = 65 min = 1.083 hr → ceil to 1.5 hr
    expect(formatDuration(60 * 65)).toBe('~1.5 hr');
    // 2 hr exactly
    expect(formatDuration(2 * 3600)).toBe('~2 hr');
    // 23 hr 59 min
    expect(formatDuration(86_399)).toBe('~24 hr');
  });

  it('caps at "more than a day" beyond 24 hours', () => {
    expect(formatDuration(86_400)).toBe('more than a day');
    expect(formatDuration(86_401)).toBe('more than a day');
  });
});
