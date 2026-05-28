import { describe, expect, it } from 'vitest';
import { isUserMoveAt } from './LineMoveTokens';

const INITIAL_FEN =
  'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const AFTER_E4_FEN =
  'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';

describe('isUserMoveAt', () => {
  it('reads the side-to-move from the FEN when one is provided (initial)', () => {
    // Initial position → White to move; the user playing White owns
    // the move at ply 0.
    expect(isUserMoveAt(INITIAL_FEN, 'white', 0)).toBe(true);
    expect(isUserMoveAt(INITIAL_FEN, 'black', 0)).toBe(false);
  });

  it('reads the side-to-move from the FEN when one is provided (after 1.e4)', () => {
    // Position after 1.e4 → Black to move; the Black-side user owns
    // the move at ply 1.
    expect(isUserMoveAt(AFTER_E4_FEN, 'black', 1)).toBe(true);
    expect(isUserMoveAt(AFTER_E4_FEN, 'white', 1)).toBe(false);
  });

  it('falls back to the index-based heuristic when the FEN is missing', () => {
    // Standard initial position assumed: even indices = White's move.
    expect(isUserMoveAt(undefined, 'white', 0)).toBe(true); // 1.e4
    expect(isUserMoveAt(undefined, 'white', 1)).toBe(false); // 1...e5
    expect(isUserMoveAt(undefined, 'white', 2)).toBe(true); // 2.Nf3
    expect(isUserMoveAt(undefined, 'black', 0)).toBe(false);
    expect(isUserMoveAt(undefined, 'black', 1)).toBe(true);
  });

  it('falls back to the index when the FEN is malformed (defensive)', () => {
    // A FEN with no side-to-move field → fall back to the index
    // heuristic. The whole point of the fallback is that a corrupt
    // RepertoireLine.fens entry can't crash the picker.
    expect(isUserMoveAt('not-a-real-fen', 'white', 0)).toBe(true);
    expect(isUserMoveAt('also-not-a-fen', 'black', 1)).toBe(true);
  });

  it('respects the FEN even when it disagrees with the parity (mid-game start)', () => {
    // Position from a mid-game FEN where Black is to move at ply 0.
    // The fallback heuristic would say White (even index) but the
    // FEN wins.
    const blackToMoveMidGame =
      'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 2 2';
    expect(isUserMoveAt(blackToMoveMidGame, 'black', 0)).toBe(true);
    expect(isUserMoveAt(blackToMoveMidGame, 'white', 0)).toBe(false);
  });
});
