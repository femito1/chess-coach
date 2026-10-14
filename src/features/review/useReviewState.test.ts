import { describe, expect, it } from 'vitest';
import { replayMainline } from './useReviewState';

describe('replayMainline', () => {
  it('replays a standard game from the standard start', () => {
    const { mainlineFens, mainlineHistory } = replayMainline('1. e4 e5 2. Nf3 *');
    expect(mainlineHistory.map((m) => m.san)).toEqual(['e4', 'e5', 'Nf3']);
    expect(mainlineFens).toHaveLength(4);
    expect(mainlineFens[0]).toBe(
      'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    );
  });

  /**
   * The bug: the replay started from `new Chess()` whatever the PGN said, so a
   * game set up from a position threw "Invalid move" on its first SAN — inside
   * a render-time memo, outside its try — and crashed the review page.
   */
  it('starts a set-up game from its [FEN] header', () => {
    const start = '8/8/8/8/8/2k5/8/K6R w - - 0 1';
    const { mainlineFens, mainlineHistory } = replayMainline(
      `[SetUp "1"]\n[FEN "${start}"]\n\n1. Rh8 Kb3 2. Rh3+ *`,
    );
    expect(mainlineHistory.map((m) => m.san)).toEqual(['Rh8', 'Kb3', 'Rh3+']);
    expect(mainlineFens[0]).toBe(start);
    expect(mainlineFens).toHaveLength(4);
  });

  it('shows a set-up position with no moves rather than the standard start', () => {
    const start = '8/8/8/8/8/2k5/8/K6R b - - 0 1';
    const { mainlineFens } = replayMainline(`[SetUp "1"]\n[FEN "${start}"]\n\n*`);
    expect(mainlineFens).toEqual([start]);
  });

  it('returns an empty mainline for a PGN that will not parse, instead of throwing', () => {
    expect(() => replayMainline('1. e4 e5 2. Ke3 Kxe3')).not.toThrow();
    expect(replayMainline('1. e4 e5 2. Ke3 Kxe3').mainlineFens).toEqual([]);
  });
});
