import { describe, expect, it } from 'vitest';
import type { OpeningLine } from './library';
import {
  buildPersonalOpeningStats,
  openingLineKey,
  personalRecordForLine,
  rankOpeningLines,
  recommendedStarterLines,
} from './recommendations';

function line(
  name: string,
  uci: string[],
  globalGames: number,
  globalShare = 0.5,
): OpeningLine {
  return {
    eco: 'C00',
    name,
    family: 'Test Opening',
    variation: name,
    uci,
    pgn: '',
    globalGames,
    globalShare,
  };
}

const E4 = ['e2e4', 'e7e5', 'g1f3'];
const ITALIAN = ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4'];
const SCOTCH = ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'd2d4'];
const QUEENS_GAMBIT = ['d2d4', 'd7d5', 'c2c4'];

describe('buildPersonalOpeningStats', () => {
  it('counts every played UCI prefix for the requested player color', () => {
    const stats = buildPersonalOpeningStats(
      [
        {
          userColor: 'white',
          pgn: '1. e4 e5 2. Nf3 Nc6 3. Bc4',
        },
        {
          userColor: 'black',
          pgn: '1. d4 d5 2. c4',
        },
      ],
      'white',
    );

    expect(stats.relevantGames).toBe(1);
    expect(stats.prefixCounts.get(openingLineKey(ITALIAN))).toBe(1);
    expect(stats.prefixCounts.has(openingLineKey(QUEENS_GAMBIT))).toBe(false);
  });
});

describe('personal win/draw/loss records', () => {
  const ITALIAN_LONG = [...ITALIAN, 'g8f6', 'd2d3']; // 7-ply extension of ITALIAN

  function whiteGame(pgn: string, result: 'win' | 'loss' | 'draw' | 'unknown') {
    return { userColor: 'white' as const, pgn, result };
  }

  it('accumulates W/D/L per prefix from the user perspective', () => {
    const stats = buildPersonalOpeningStats(
      [
        whiteGame('1. e4 e5 2. Nf3 Nc6 3. Bc4', 'win'),
        whiteGame('1. e4 e5 2. Nf3 Nc6 3. Bc4', 'loss'),
        whiteGame('1. e4 e5 2. Nf3 Nc6 3. Bc4', 'draw'),
      ],
      'white',
    );
    expect(stats.prefixRecords.get(openingLineKey(ITALIAN))).toEqual({
      wins: 1,
      draws: 1,
      losses: 1,
    });
  });

  it("omits 'unknown' results from W/D/L but still counts the prefix", () => {
    const stats = buildPersonalOpeningStats(
      [whiteGame('1. e4 e5 2. Nf3 Nc6 3. Bc4', 'unknown')],
      'white',
    );
    expect(stats.prefixCounts.get(openingLineKey(ITALIAN))).toBe(1);
    expect(stats.prefixRecords.has(openingLineKey(ITALIAN))).toBe(false);
  });

  it('returns null when no prefix has at least the minimum games', () => {
    const stats = buildPersonalOpeningStats(
      [
        whiteGame('1. e4 e5 2. Nf3 Nc6 3. Bc4', 'win'),
        whiteGame('1. e4 e5 2. Nf3 Nc6 3. Bc4', 'loss'),
      ],
      'white',
    );
    // Only 2 games at any prefix; default threshold is 4.
    expect(personalRecordForLine(stats, ITALIAN)).toBeNull();
  });

  it('reports an exact-line record when the line itself was played enough', () => {
    const stats = buildPersonalOpeningStats(
      Array.from({ length: 5 }, () =>
        whiteGame('1. e4 e5 2. Nf3 Nc6 3. Bc4', 'win'),
      ),
      'white',
    );
    const rec = personalRecordForLine(stats, ITALIAN);
    expect(rec).not.toBeNull();
    expect(rec!.depth).toBe(ITALIAN.length);
    expect(rec!.inherited).toBe(false);
    expect(rec!.wins).toBe(5);
    expect(rec!.games).toBe(5);
  });

  it('inherits the deepest sufficiently-played ancestor for an unplayed line', () => {
    // Five games through the Italian (5-ply), never the 7-ply extension.
    const stats = buildPersonalOpeningStats(
      Array.from({ length: 5 }, () =>
        whiteGame('1. e4 e5 2. Nf3 Nc6 3. Bc4', 'draw'),
      ),
      'white',
    );
    const rec = personalRecordForLine(stats, ITALIAN_LONG);
    expect(rec).not.toBeNull();
    expect(rec!.depth).toBe(ITALIAN.length); // inherited from the 5-ply prefix
    expect(rec!.inherited).toBe(true);
    expect(rec!.draws).toBe(5);
  });

  it('prefers the deepest qualifying prefix over shallower ones', () => {
    // 6 games reach the Italian; of those, 4 continue to the 7-ply line.
    const stats = buildPersonalOpeningStats(
      [
        ...Array.from({ length: 4 }, () =>
          whiteGame('1. e4 e5 2. Nf3 Nc6 3. Bc4 Nf6 4. d3', 'win'),
        ),
        ...Array.from({ length: 2 }, () =>
          whiteGame('1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5', 'loss'),
        ),
      ],
      'white',
    );
    const rec = personalRecordForLine(stats, ITALIAN_LONG);
    expect(rec!.depth).toBe(ITALIAN_LONG.length); // the exact 7-ply line, 4 games
    expect(rec!.inherited).toBe(false);
    expect(rec!.wins).toBe(4);
    expect(rec!.games).toBe(4);
  });
});

describe('rankOpeningLines', () => {
  it('falls back to bundled global popularity without personal history', () => {
    const ranked = rankOpeningLines(
      [
        line('Rare', SCOTCH, 10),
        line('Popular', ITALIAN, 10_000),
      ],
      { relevantGames: 0, prefixCounts: new Map(), prefixRecords: new Map() },
    );

    expect(ranked[0].line.name).toBe('Popular');
  });

  it('lets repeated personal experience outweigh the global prior', () => {
    const games = Array.from({ length: 20 }, () => ({
      userColor: 'white' as const,
      pgn: '1. e4 e5 2. Nf3 Nc6 3. d4',
    }));
    const ranked = rankOpeningLines(
      [
        line('Italian', ITALIAN, 20_000),
        line('Scotch', SCOTCH, 2_000),
      ],
      buildPersonalOpeningStats(games, 'white'),
    );

    expect(ranked[0].line.name).toBe('Scotch');
    expect(ranked[0].personalCount).toBe(20);
  });

  it('does not let one personal game overwhelm a strong global prior', () => {
    const ranked = rankOpeningLines(
      [
        line('Italian', ITALIAN, 50_000),
        line('Scotch', SCOTCH, 50),
      ],
      buildPersonalOpeningStats(
        [{ userColor: 'white', pgn: '1. e4 e5 2. Nf3 Nc6 3. d4' }],
        'white',
      ),
    );

    expect(ranked[0].line.name).toBe('Italian');
  });

  it('promotes branch diversity in the starter set', () => {
    const ranked = recommendedStarterLines(
      [
        line('King pawn shell', E4, 1_000),
        line('Italian', ITALIAN, 950),
        line('Queens Gambit', QUEENS_GAMBIT, 900),
      ],
      { relevantGames: 0, prefixCounts: new Map(), prefixRecords: new Map() },
      3,
    );

    expect(ranked[0].line.name).toBe('King pawn shell');
    expect(ranked[1].line.name).toBe('Queens Gambit');
  });

  it('uses stable name ordering when every signal ties', () => {
    const ranked = rankOpeningLines(
      [
        line('Beta', ['d2d4'], 0, 0),
        line('Alpha', ['e2e4'], 0, 0),
      ],
      { relevantGames: 0, prefixCounts: new Map(), prefixRecords: new Map() },
    );

    expect(ranked.map((entry) => entry.line.name)).toEqual(['Alpha', 'Beta']);
  });
});
