import { describe, expect, it } from 'vitest';
import {
  accuracyTrend,
  chartOpeningFamily,
  computeUserTimeStats,
  effectiveModeSelection,
  stripOpeningMoves,
  totalSecondsPlayed,
  winRateByOpening,
  type GameForCharts,
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

describe('accuracyTrend filtering', () => {
  function chartGame(
    timeClass: string,
    accuracy: number,
    endTimeSec: number,
  ): GameForCharts {
    // Minimal structural Game shape — only the fields accuracyTrend
    // touches matter for the filter contract under test.
    return {
      id: `${timeClass}-${endTimeSec}`,
      source: 'chesscom',
      pgn: '',
      url: '',
      timeClass,
      timeControl: '600',
      result: 'win',
      userColor: 'white',
      userRating: 1500,
      opponent: 'someone',
      opponentRating: 1500,
      endTime: endTimeSec,
      eco: 'A00',
      opening: 'Test',
      analysisStatus: 'done',
      accuracy: { white: accuracy, black: accuracy },
    } as unknown as GameForCharts;
  }

  const games: GameForCharts[] = [
    chartGame('rapid', 90, 1700000000),
    chartGame('blitz', 80, 1700000100),
    chartGame('bullet', 70, 1700000200),
    chartGame('rapid', 85, 1700000300),
  ];

  it('returns every game when filter is "all" (default)', () => {
    expect(accuracyTrend(games)).toHaveLength(4);
  });

  it('filters down to a single class when given a string', () => {
    const out = accuracyTrend(games, 'rapid');
    expect(out).toHaveLength(2);
    expect(out.every((p) => p.timeClass === 'rapid')).toBe(true);
  });

  it('filters down to a multi-class subset when given an array', () => {
    const out = accuracyTrend(games, ['rapid', 'blitz']);
    expect(out).toHaveLength(3);
    expect(out.every((p) => p.timeClass === 'rapid' || p.timeClass === 'blitz')).toBe(true);
  });

  it('returns an empty series when the array is empty (every chip deselected)', () => {
    const out = accuracyTrend(games, []);
    expect(out).toHaveLength(0);
  });

  it('rolling mean is computed only over the filtered points', () => {
    // With 2 rapid points, the rolling window's "min 5" gate prevents
    // a value being emitted (we only emit `rolling` once we have at
    // least 5 samples) — but the per-point `accuracy` is preserved.
    const out = accuracyTrend(games, ['rapid']);
    expect(out.map((p) => p.accuracy)).toEqual([90, 85]);
    // And critically, the rolling line never sees blitz/bullet data.
    expect(out.every((p) => p.timeClass === 'rapid')).toBe(true);
  });
});

describe('winRateByOpening filtering', () => {
  function chartGame(
    timeClass: string,
    opening: string,
    result: 'win' | 'loss' | 'draw',
    endTimeSec: number,
  ): GameForCharts {
    return {
      id: `${timeClass}-${opening}-${endTimeSec}`,
      source: 'chesscom',
      pgn: '',
      url: '',
      timeClass,
      timeControl: '600',
      result,
      userColor: 'white',
      userRating: 1500,
      opponent: 'someone',
      opponentRating: 1500,
      endTime: endTimeSec,
      eco: 'A00',
      opening,
      analysisStatus: 'done',
    } as unknown as GameForCharts;
  }

  // Two opening families across three time classes. The Italian Game
  // (4 rapid wins, 1 blitz loss) and the French Defense (1 bullet win).
  const games: GameForCharts[] = [
    chartGame('rapid', 'Italian Game', 'win', 1),
    chartGame('rapid', 'Italian Game', 'win', 2),
    chartGame('rapid', 'Italian Game', 'win', 3),
    chartGame('rapid', 'Italian Game: Classical', 'win', 4),
    chartGame('blitz', 'Italian Game', 'loss', 5),
    chartGame('bullet', 'French Defense', 'win', 6),
  ];

  it('returns every family when filter is "all" (default)', () => {
    const out = winRateByOpening(games);
    const families = new Set(out.map((o) => o.family));
    expect(families.has('Italian Game')).toBe(true);
    expect(families.has('French Defense')).toBe(true);
    const italian = out.find((o) => o.family === 'Italian Game')!;
    expect(italian.games).toBe(5); // 4 rapid + 1 blitz
  });

  it('filters by a single time class string', () => {
    const out = winRateByOpening(games, 10, 'rapid');
    const italian = out.find((o) => o.family === 'Italian Game');
    expect(italian).toBeTruthy();
    expect(italian!.games).toBe(4); // only rapid Italians
    expect(italian!.wins).toBe(4);
    // French Defense is bullet-only — not in the rapid slice.
    expect(out.find((o) => o.family === 'French Defense')).toBeUndefined();
  });

  it('filters by a multi-class array', () => {
    const out = winRateByOpening(games, 10, ['rapid', 'blitz']);
    const italian = out.find((o) => o.family === 'Italian Game')!;
    expect(italian.games).toBe(5);
    expect(italian.wins).toBe(4);
    expect(italian.losses).toBe(1);
    expect(out.find((o) => o.family === 'French Defense')).toBeUndefined();
  });

  it('returns an empty list when the filter array is empty (every chip deselected)', () => {
    const out = winRateByOpening(games, 10, []);
    expect(out).toHaveLength(0);
  });

  it('respects topN against the filtered set', () => {
    // Force the filter down to just blitz; that's a single Italian
    // Game game. Asking for top 10 still produces just the one row.
    const out = winRateByOpening(games, 10, 'blitz');
    expect(out).toHaveLength(1);
    expect(out[0].family).toBe('Italian Game');
    expect(out[0].losses).toBe(1);
  });

  /**
   * The colon `openingFamily()` splits on lands wherever the importer met
   * its first marker word, so one opening used to arrive as many rows —
   * on real data the Caro-Kann was split across eight. Every spelling
   * below is one `parseOpeningFromEcoUrl` actually produced.
   */
  it('files every spelling of one opening under one canonical row', () => {
    const caro = [
      'Caro Kann Defense: 2.Nf3 d5',
      'Caro Kann Defense Exchange Variation: 3...cxd5',
      'Caro Kann Defense: Advance Variation',
      'Caro Kann Defense Advance Short Variation',
      'Caro Kann Defense...3.d3 dxe4 4.dxe4 Qxd1 5.Kxd1',
      'Caro Kann Defense',
    ].map((name, i) => chartGame('rapid', name, 'win', 100 + i));
    const out = winRateByOpening(caro);
    expect(out.map((o) => o.family)).toEqual(['Caro-Kann Defense']);
    expect(out[0].games).toBe(6);
  });
});

describe('chartOpeningFamily', () => {
  it('resolves to the library spelling, which the deep link needs', () => {
    expect(chartOpeningFamily('Reti Opening: Kings Indian Attack')).toBe(
      'Réti Opening',
    );
    expect(chartOpeningFamily('Scotch Game 3...d6')).toBe('Scotch Game');
    expect(chartOpeningFamily('Pirc Defense...4.c3 Bg7')).toBe('Pirc Defense');
  });

  // Names the library doesn't know still fold their variations together,
  // and keep Chess.com's spelling so the move-based link fallback (and
  // `chart-opening-links.mjs`, which finds the row by this text) work.
  it('falls back to the name cut after its family-ending word', () => {
    expect(chartOpeningFamily('Kings Fianchetto Opening')).toBe(
      'Kings Fianchetto Opening',
    );
    expect(chartOpeningFamily('Queens Pawn Opening Zukertort Variation')).toBe(
      'Queens Pawn Opening',
    );
    expect(chartOpeningFamily('Queens Pawn Opening: 1...d5 2.Nf3')).toBe(
      'Queens Pawn Opening',
    );
    expect(
      chartOpeningFamily('Indian Game East Indian London System...4.e3 O O'),
    ).toBe('Indian Game');
    expect(chartOpeningFamily(undefined)).toBe('Unknown');
  });
});

describe('stripOpeningMoves', () => {
  it('drops a move tail however it was introduced', () => {
    expect(stripOpeningMoves('Caro Kann Defense: 2.Nf3 d5')).toBe(
      'Caro Kann Defense',
    );
    expect(stripOpeningMoves('Sicilian Defense: Najdorf Variation, 6.Be2')).toBe(
      'Sicilian Defense: Najdorf Variation',
    );
    expect(stripOpeningMoves('Scotch Game 3...d6')).toBe('Scotch Game');
    expect(stripOpeningMoves('Pirc Defense...4.c3 Bg7')).toBe('Pirc Defense');
    expect(
      stripOpeningMoves('French Defense Advance Variation 3...dxe4 4.Nxe4'),
    ).toBe('French Defense Advance Variation');
  });

  it('leaves names without moves alone', () => {
    expect(stripOpeningMoves('Caro Kann Defense: Advance Variation')).toBe(
      'Caro Kann Defense: Advance Variation',
    );
    expect(stripOpeningMoves("Van't Kruijs Opening")).toBe("Van't Kruijs Opening");
  });
});

describe('effectiveModeSelection', () => {
  it('passes "all" through and drops classes with no data', () => {
    expect(effectiveModeSelection(null, ['rapid'])).toBeNull();
    expect(effectiveModeSelection(['rapid', 'blitz'], ['rapid', 'bullet'])).toEqual([
      'rapid',
    ]);
  });

  // The bug: a stored ['blitz'] once only rapid games remained left every
  // chart on "no mode selected", with the chips hidden (one class) so
  // nothing could undo it.
  it('falls back to all when the stored pick matches nothing available', () => {
    expect(effectiveModeSelection(['blitz'], ['rapid'])).toBeNull();
    expect(effectiveModeSelection(['blitz'], ['rapid', 'bullet'])).toBeNull();
  });

  it('keeps a deliberate empty pick only while chips can change it', () => {
    expect(effectiveModeSelection([], ['rapid', 'blitz'])).toEqual([]);
    expect(effectiveModeSelection([], ['rapid'])).toBeNull();
  });
});
