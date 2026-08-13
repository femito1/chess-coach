import { describe, expect, it } from 'vitest';
import { Chess } from 'chess.js';
import type { Classification } from '@/db/schema';
import { classifyMoveSound, type MoveSoundKind } from './moveSounds';

/**
 * Play a SAN sequence from the initial position (or a given FEN) and
 * classify the LAST move, exactly as `Board` does: the position before, the
 * position after, the move in UCI, and any classification the surface has.
 */
function cueAfter(
  sans: string[],
  startFen?: string,
  classification?: Classification,
): MoveSoundKind {
  const chess = startFen ? new Chess(startFen) : new Chess();
  let fenBefore = chess.fen();
  let uci = '';
  for (const san of sans) {
    fenBefore = chess.fen();
    const move = chess.move(san);
    uci = `${move.from}${move.to}${move.promotion ?? ''}`;
  }
  return classifyMoveSound({
    fenBefore,
    fenAfter: chess.fen(),
    uci,
    classification,
  });
}

describe('classifyMoveSound', () => {
  it('calls a quiet move a move', () => {
    expect(cueAfter(['e4'])).toBe('move');
    expect(cueAfter(['e4', 'e5', 'Nf3'])).toBe('move');
  });

  it('hears a capture', () => {
    expect(cueAfter(['e4', 'd5', 'exd5'])).toBe('capture');
  });

  it('hears an en-passant capture, where the taken pawn is not on the target square', () => {
    expect(cueAfter(['e4', 'a6', 'e5', 'd5', 'exd6'])).toBe('capture');
  });

  it('gives castling and promotion no cue of their own — they are moves', () => {
    // Both used to get bespoke cues; the doubled click for castling is
    // exactly what read as two sounds.
    expect(cueAfter(['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'O-O'])).toBe('move');
    expect(
      cueAfter(['d4', 'd5', 'Nc3', 'Nc6', 'Bf4', 'Bf5', 'Qd2', 'Qd7', 'O-O-O']),
    ).toBe('move');
    const promo = '8/P7/8/4k3/8/8/8/K7 w - - 0 1';
    expect(cueAfter(['a8=Q'], promo)).toBe('move');
  });

  it('lets check win over the capture it came with', () => {
    // Rxe7+ takes a pawn AND checks; not mate, since the king can take back.
    const fen = '4k3/4p3/8/8/8/8/4R3/4K3 w - - 0 1';
    expect(cueAfter(['Rxe7+'], fen)).toBe('check');
  });

  it('announces mate rather than the check that delivered it', () => {
    // Fool's mate: 1. f3 e5 2. g4 Qh4#
    expect(cueAfter(['f3', 'e5', 'g4', 'Qh4#'])).toBe('mate');
  });

  it('uses the mate cue for stalemate too — the game is over either way', () => {
    const fen = '7k/8/8/8/8/8/5Q2/K7 w - - 0 1';
    expect(cueAfter(['Qf7'], fen)).toBe('mate');
  });

  it('sounds brilliant above check and capture', () => {
    // A brilliant move that also checks announces the brilliance.
    const fen = '4k3/4p3/8/8/8/8/4R3/4K3 w - - 0 1';
    expect(cueAfter(['Rxe7+'], fen, 'brilliant')).toBe('brilliant');
    // …and a brilliant quiet move, likewise.
    expect(cueAfter(['e4'], undefined, 'brilliant')).toBe('brilliant');
  });

  it('still announces mate over brilliance — a finished game outranks a compliment', () => {
    expect(cueAfter(['f3', 'e5', 'g4', 'Qh4#'], undefined, 'brilliant')).toBe('mate');
  });

  it('ignores every classification other than brilliant', () => {
    const others: Classification[] = [
      'best',
      'excellent',
      'good',
      'book',
      'inaccuracy',
      'miss',
      'mistake',
    ];
    for (const c of others) {
      expect(cueAfter(['e4', 'd5', 'exd5'], undefined, c)).toBe('capture');
      expect(cueAfter(['e4'], undefined, c)).toBe('move');
    }
  });

  it('falls back to a plain move when it cannot tell', () => {
    const chess = new Chess();
    chess.move('e4');
    chess.move('d5');
    const before = chess.fen();
    chess.move('exd5');
    // No `fenBefore`, so a capture is indistinguishable from a quiet move.
    expect(classifyMoveSound({ fenAfter: chess.fen(), uci: 'e4d5' })).toBe('move');
    expect(
      classifyMoveSound({ fenBefore: before, fenAfter: chess.fen(), uci: 'e4d5' }),
    ).toBe('capture');
  });

  it('never throws on a malformed FEN', () => {
    expect(classifyMoveSound({ fenAfter: 'not a fen', uci: 'e2e4' })).toBe('move');
    expect(classifyMoveSound({ fenAfter: '', uci: '' })).toBe('move');
  });
});
