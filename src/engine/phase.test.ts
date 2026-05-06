import { describe, expect, it } from 'vitest';
import {
  baseSecondsFromTimeControl,
  deriveTimeSpent,
  detectPhase,
  extractClocks,
} from './phase';

describe('detectPhase', () => {
  it('classifies the start position as opening', () => {
    const fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    expect(detectPhase(fen)).toBe('opening');
  });

  it('classifies a position with both queens off and few minors as endgame', () => {
    // K + R vs K + N — clearly endgame.
    const fen = '4k3/8/8/8/8/8/4n3/4K2R w K - 0 30';
    expect(detectPhase(fen)).toBe('endgame');
  });

  it('classifies a fully-loaded position past move 20 as middlegame', () => {
    const fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 25';
    expect(detectPhase(fen)).toBe('middlegame');
  });

  it('falls back to middlegame on garbage input', () => {
    expect(detectPhase('not-a-fen')).toBe('middlegame');
  });
});

describe('extractClocks', () => {
  it('extracts %clk annotations in order', () => {
    const pgn =
      '1. e4 {[%clk 0:09:55]} e5 {[%clk 0:09:50]} 2. Nf3 {[%clk 0:09:40]} Nc6 {[%clk 0:09:48]}';
    expect(extractClocks(pgn)).toEqual([595, 590, 580, 588]);
  });
  it('returns [] when no clocks are present', () => {
    expect(extractClocks('1. e4 e5 2. Nf3 Nc6')).toEqual([]);
  });
});

describe('deriveTimeSpent', () => {
  it('uses the base-seconds fallback for the first move of each side', () => {
    // Two players, base 600s each. Clocks: [w595, b598, w590, b595].
    const out = deriveTimeSpent([595, 598, 590, 595], 600);
    expect(out).toEqual([5, 2, 5, 3]);
  });

  it('clamps negative deltas (clock increment exceeds think time) to 0', () => {
    // A clock that grows due to increment should not produce negative time.
    const out = deriveTimeSpent([595, 600, 599, 605], 600);
    expect(out.every((v) => v === undefined || v >= 0)).toBe(true);
  });

  it('returns undefined when no base is known and we have <2 prior plies', () => {
    expect(deriveTimeSpent([595, 598], undefined)).toEqual([undefined, undefined]);
  });
});

describe('baseSecondsFromTimeControl', () => {
  it('parses simple "600"', () => {
    expect(baseSecondsFromTimeControl('600')).toBe(600);
  });
  it('parses "180+2" as 180', () => {
    expect(baseSecondsFromTimeControl('180+2')).toBe(180);
  });
  it('returns undefined for missing/invalid input', () => {
    expect(baseSecondsFromTimeControl(undefined)).toBeUndefined();
    expect(baseSecondsFromTimeControl('')).toBeUndefined();
    // Daily time controls come through as `1/86400` — this isn't a real
    // base-time-in-seconds, and `Number('1/86400')` is NaN, so the
    // function correctly punts. Daily time-spent is computed elsewhere.
    expect(baseSecondsFromTimeControl('1/86400')).toBeUndefined();
  });
});
