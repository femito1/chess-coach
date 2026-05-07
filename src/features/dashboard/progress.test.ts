import { describe, expect, it } from 'vitest';
import {
  computeUserTimeStats,
  totalSecondsPlayed,
  type GameForTimeStats,
} from './progress';

/**
 * The fixture PGN below carries `%clk` annotations so `extractClocks`
 * picks them up. Times are White's then Black's per move; with a 600+0
 * base time control and the clocks declining a few seconds per move,
 * derived "time spent" comes out to small positive integers.
 *
 * Most tests that touch `totalSecondsPlayed` only need the *cached*
 * fields (`userTimeSec` / `userPlyCount`); we use this PGN only for
 * the legacy / fallback path tests so we still cover the regex path.
 */
const CLOCKED_PGN = `[Event "Live Chess"]
[Site "Chess.com"]
[White "alice"]
[Black "bob"]
[Result "1-0"]
[TimeControl "600"]

1. e4 {[%clk 0:09:55]} e5 {[%clk 0:09:50]} 2. Nf3 {[%clk 0:09:50]} Nc6 {[%clk 0:09:45]} 3. Bc4 {[%clk 0:09:40]} Bc5 {[%clk 0:09:30]} 1-0
`;

describe('computeUserTimeStats', () => {
  it('returns userTimeSec from %clk for a clock-rich rapid game', () => {
    const stats = computeUserTimeStats({
      timeClass: 'rapid',
      timeControl: '600',
      userColor: 'white',
      pgn: CLOCKED_PGN,
    });
    expect(stats.userTimeSec).toBeGreaterThan(0);
    // White went from 600 → 595 → 590 → 580. That's ~20 s spent.
    expect(stats.userTimeSec).toBeLessThan(60);
    expect(stats.userPlyCount).toBe(6);
  });

  it('returns black-side time when userColor is black', () => {
    const white = computeUserTimeStats({
      timeClass: 'rapid',
      timeControl: '600',
      userColor: 'white',
      pgn: CLOCKED_PGN,
    });
    const black = computeUserTimeStats({
      timeClass: 'rapid',
      timeControl: '600',
      userColor: 'black',
      pgn: CLOCKED_PGN,
    });
    expect(white.userTimeSec).not.toBe(black.userTimeSec);
    // Black went from 600 → 590 → 585 → 570. ~30 s spent — strictly
    // more than White's 20 s in this fixture.
    expect((black.userTimeSec ?? 0)).toBeGreaterThan((white.userTimeSec ?? 0));
  });

  it('excludes daily games (returns undefined seconds, but still counts plies)', () => {
    const stats = computeUserTimeStats({
      timeClass: 'daily',
      timeControl: '1/86400',
      userColor: 'white',
      pgn: CLOCKED_PGN,
    });
    expect(stats.userTimeSec).toBeUndefined();
    // We still parse plies even for excluded games — cheap and lets
    // future features use the count.
    expect(stats.userPlyCount).toBe(6);
  });

  it('falls back to half-base heuristic when no clocks are present', () => {
    const noClockPgn = `[Event "Live"]
[White "a"]
[Black "b"]
[TimeControl "300"]
[Result "*"]

1. e4 e5 2. Nf3 Nc6 *
`;
    const stats = computeUserTimeStats({
      timeClass: 'blitz',
      timeControl: '300',
      userColor: 'white',
      pgn: noClockPgn,
    });
    // 4 plies → 2 user plies; guess = min(600, 150 + 2*2) = 154.
    expect(stats.userTimeSec).toBeCloseTo(154, 0);
    expect(stats.userPlyCount).toBe(4);
  });

  it('returns undefined seconds for a clock-less game with no usable base (e.g. correspondence outside daily)', () => {
    const pgn = `[Event "?"]
[TimeControl "1/86400"]
[Result "*"]

1. e4 e5 *
`;
    // A 24-hour-per-move correspondence game NOT classed as daily —
    // the heuristic refuses to estimate (base > 2h). The fallback's
    // own filter guards against absurd numbers ("you played 86 400 s").
    const stats = computeUserTimeStats({
      timeClass: 'classical', // mis-classed, but base is what guards
      timeControl: '1/86400',
      userColor: 'white',
      pgn,
    });
    expect(stats.userTimeSec).toBeUndefined();
  });
});

describe('totalSecondsPlayed', () => {
  /**
   * Build a partially-typed Game stand-in for the function under test.
   * We can pass a structural subtype because `GameForTimeStats` only
   * needs five fields; we exploit that to test all the branches
   * without dragging the full Game shape along.
   */
  function game(partial: Partial<GameForTimeStats>): GameForTimeStats {
    return {
      timeClass: 'rapid',
      timeControl: '600',
      userColor: 'white',
      ...partial,
    };
  }

  it('prefers the cached userTimeSec field over PGN parsing (the hot path)', () => {
    // Cached value: 1234 s. PGN points to a different value, but the
    // cache wins. This is the steady-state dashboard render path.
    const total = totalSecondsPlayed([
      game({ userTimeSec: 1234, pgn: CLOCKED_PGN }),
    ]);
    expect(total).toBe(1234);
  });

  it('falls back to PGN parsing when userTimeSec is undefined and pgn is present', () => {
    // Mirrors a pre-backfill row that still has PGN in JS heap (rare
    // in production after the migration but covers the transition
    // window and tests).
    const total = totalSecondsPlayed([
      game({ userTimeSec: undefined, pgn: CLOCKED_PGN }),
    ]);
    expect(total).toBeGreaterThan(0);
    expect(total).toBeLessThan(60);
  });

  it("skips a row entirely when both userTimeSec and pgn are absent (light projection, pre-backfill)", () => {
    // The dashboard's `listGamesLight()` strips PGN. If a row hasn't
    // yet been backfilled, we *deliberately* skip it rather than
    // falling back to "load every PGN" — better to under-count for one
    // boot than reintroduce the freeze.
    const total = totalSecondsPlayed([
      game({ userTimeSec: undefined, pgn: undefined }),
    ]);
    expect(total).toBe(0);
  });

  it('aggregates cached values across multiple games', () => {
    const total = totalSecondsPlayed([
      game({ userTimeSec: 100 }),
      game({ userTimeSec: 200 }),
      game({ userTimeSec: 300 }),
    ]);
    expect(total).toBe(600);
  });

  it('skips daily games even when userTimeSec is present', () => {
    // Cached but classed daily — exclude (matches the policy: daily /
    // correspondence think time is not interesting for "hours played").
    const total = totalSecondsPlayed([
      game({ timeClass: 'daily', userTimeSec: 999_999 }),
    ]);
    expect(total).toBe(0);
  });

  it('treats userTimeSec === 0 as "nothing to add" (skip-style)', () => {
    // Practically never happens, but defensive: a zero is a no-op
    // rather than a "use undefined fallback" trigger.
    const total = totalSecondsPlayed([
      game({ userTimeSec: 0, pgn: CLOCKED_PGN }),
    ]);
    expect(total).toBe(0);
  });
});
