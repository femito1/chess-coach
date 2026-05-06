import { describe, expect, it } from 'vitest';
import { chessComGameToGame, parseOpeningFromEcoUrl, reparseOpeningFromPgn } from './importer';

describe('parseOpeningFromEcoUrl', () => {
  it('returns undefined for missing input', () => {
    expect(parseOpeningFromEcoUrl(undefined)).toBeUndefined();
    expect(parseOpeningFromEcoUrl('')).toBeUndefined();
  });
  it('inserts a colon after the first variation/defense marker', () => {
    // Markers are tried in order: Variation, Defense, Attack, Gambit,
    // System, Opening — so "Variation" wins over "Defense" here.
    expect(
      parseOpeningFromEcoUrl(
        'https://www.chess.com/openings/Sicilian-Defense-Najdorf-Variation-6.Be2',
      ),
    ).toBe('Sicilian Defense Najdorf Variation: 6.Be2');
  });
  it('uses the Defense marker when no Variation token is present', () => {
    expect(
      parseOpeningFromEcoUrl('https://www.chess.com/openings/Caro-Kann-Defense-Main-Line'),
    ).toBe('Caro Kann Defense: Main Line');
  });
  it('falls back to the decoded slug when no marker is present', () => {
    expect(parseOpeningFromEcoUrl('https://www.chess.com/openings/Some-Random-Slug')).toBe(
      'Some Random Slug',
    );
  });
});

describe('reparseOpeningFromPgn', () => {
  it('returns null when neither ECO nor Opening is present', () => {
    expect(reparseOpeningFromPgn('1. e4 e5')).toBeNull();
  });
  it('extracts ECO + Opening from PGN headers', () => {
    const pgn = `[ECO "B90"]\n[Opening "Sicilian Defense: Najdorf"]\n\n1. e4 c5`;
    expect(reparseOpeningFromPgn(pgn)).toEqual({
      eco: 'B90',
      opening: 'Sicilian Defense: Najdorf',
    });
  });
  it('falls back to ECOUrl-derived opening if Opening tag is missing', () => {
    const pgn = `[ECO "B90"]\n[ECOUrl "https://www.chess.com/openings/Sicilian-Defense-Najdorf-Variation"]\n\n1. e4 c5`;
    expect(reparseOpeningFromPgn(pgn)?.opening).toMatch(/Sicilian Defense/);
  });
});

describe('chessComGameToGame', () => {
  // Minimal-shaped fixture matching `ChessComGame` enough for the importer.
  const fixture = (overrides: Partial<Record<string, unknown>> = {}) =>
    ({
      url: 'https://www.chess.com/game/live/9999999',
      pgn: `[ECO "C50"]\n[Opening "Italian Game"]\n\n1. e4 e5 2. Nf3 Nc6 3. Bc4 1-0`,
      time_control: '600',
      time_class: 'rapid',
      end_time: 1_700_000_000,
      eco: 'https://www.chess.com/openings/Italian-Game',
      white: { username: 'Hero', rating: 1500, result: 'win' },
      black: { username: 'Villain', rating: 1480, result: 'checkmated' },
      ...overrides,
    }) as Parameters<typeof chessComGameToGame>[0];

  it('detects user color and opponent from username', () => {
    const g = chessComGameToGame(fixture(), 'hero');
    expect(g.userColor).toBe('white');
    expect(g.opponent).toBe('Villain');
    expect(g.userRating).toBe(1500);
    expect(g.opponentRating).toBe(1480);
  });

  it('flips when user is black', () => {
    const g = chessComGameToGame(fixture(), 'villain');
    expect(g.userColor).toBe('black');
    expect(g.opponent).toBe('Hero');
    expect(g.result).toBe('loss');
  });

  it('maps win/loss/draw correctly from chess.com result codes', () => {
    expect(chessComGameToGame(fixture(), 'hero').result).toBe('win');
    const draw = fixture({
      white: { username: 'Hero', rating: 1500, result: 'agreed' },
      black: { username: 'Villain', rating: 1480, result: 'agreed' },
    });
    expect(chessComGameToGame(draw, 'hero').result).toBe('draw');
  });

  it('extracts ECO code (not URL) and opening name from PGN headers', () => {
    const g = chessComGameToGame(fixture(), 'hero');
    expect(g.eco).toBe('C50');
    expect(g.opening).toBe('Italian Game');
  });

  it('produces a stable, content-addressed id from the game URL', () => {
    const a = chessComGameToGame(fixture(), 'hero');
    const b = chessComGameToGame(fixture(), 'hero');
    expect(a.id).toBe(b.id);
    expect(a.id).toMatch(/^[0-9a-f]+$/);
  });

  it('converts end_time to milliseconds', () => {
    const g = chessComGameToGame(fixture(), 'hero');
    expect(g.endTime).toBe(1_700_000_000_000);
  });
});
