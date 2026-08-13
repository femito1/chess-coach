import { describe, expect, it } from 'vitest';
import { Chess } from 'chess.js';
import { classifyMoveSound, type MoveSoundKind } from './moveSounds';

/**
 * Play a SAN sequence from the initial position (or a given FEN) and
 * classify the LAST move, exactly as `Board` does: the position before, the
 * position after, and the move in UCI.
 */
function cueAfter(sans: string[], startFen?: string): MoveSoundKind {
  const chess = startFen ? new Chess(startFen) : new Chess();
  let fenBefore = chess.fen();
  let uci = '';
  for (const san of sans) {
    fenBefore = chess.fen();
    const move = chess.move(san);
    uci = `${move.from}${move.to}${move.promotion ?? ''}`;
  }
  return classifyMoveSound({ fenBefore, fenAfter: chess.fen(), uci });
}

describe('classifyMoveSound', () => {
  it('calls a quiet move a move', () => {
    expect(cueAfter(['e4'])).toBe('move');
    expect(cueAfter(['e4', 'e5', 'Nf3'])).toBe('move');
  });

  it('hears a capture', () => {
    // 1. e4 d5 2. exd5
    expect(cueAfter(['e4', 'd5', 'exd5'])).toBe('capture');
  });

  it('hears an en-passant capture, where the taken pawn is not on the target square', () => {
    // 1. e4 a6 2. e5 d5 3. exd6 (en passant)
    expect(cueAfter(['e4', 'a6', 'e5', 'd5', 'exd6'])).toBe('capture');
  });

  it('hears castling on both sides', () => {
    expect(cueAfter(['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'O-O'])).toBe('castle');
    expect(
      cueAfter(['d4', 'd5', 'Nc3', 'Nc6', 'Bf4', 'Bf5', 'Qd2', 'Qd7', 'O-O-O']),
    ).toBe('castle');
  });

  it('hears a promotion', () => {
    // King on e5 so the new queen neither checks it (a8 sees the 8th rank,
    // the a-file and the a8-e4 diagonal — e5 is on none of them) nor
    // stalemates it; otherwise those cues would outrank the promotion.
    const fen = '8/P7/8/4k3/8/8/8/K7 w - - 0 1';
    expect(cueAfter(['a8=Q'], fen)).toBe('promote');
  });

  it('lets check win over the capture it came with', () => {
    // Rxe7+ takes a pawn AND checks. Not mate: the king can simply take
    // back, so `check` is the cue rather than `gameEnd`.
    const fen = '4k3/4p3/8/8/8/8/4R3/4K3 w - - 0 1';
    expect(cueAfter(['Rxe7+'], fen)).toBe('check');
  });

  it('announces the end of the game, not the check that ended it', () => {
    // Fool's mate: 1. f3 e5 2. g4 Qh4#
    expect(cueAfter(['f3', 'e5', 'g4', 'Qh4#'])).toBe('gameEnd');
  });

  it('treats stalemate as the end of the game too', () => {
    // Qf7 leaves the h8 king with no legal move and no check: stalemate.
    const fen = '7k/8/8/8/8/8/5Q2/K7 w - - 0 1';
    expect(cueAfter(['Qf7'], fen)).toBe('gameEnd');
  });

  it('falls back to a plain move when it cannot tell', () => {
    // No `fenBefore`, so a capture is indistinguishable from a quiet move.
    const chess = new Chess();
    chess.move('e4');
    chess.move('d5');
    const before = chess.fen();
    chess.move('exd5');
    expect(classifyMoveSound({ fenAfter: chess.fen(), uci: 'e4d5' })).toBe('move');
    // …and with it, the capture is heard.
    expect(
      classifyMoveSound({ fenBefore: before, fenAfter: chess.fen(), uci: 'e4d5' }),
    ).toBe('capture');
  });

  it('never throws on a malformed FEN', () => {
    expect(classifyMoveSound({ fenAfter: 'not a fen', uci: 'e2e4' })).toBe('move');
    expect(classifyMoveSound({ fenAfter: '', uci: '' })).toBe('move');
  });
});
