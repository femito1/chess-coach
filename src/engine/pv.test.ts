import { describe, it, expect } from 'vitest';
import { formatPv, formatPvLine } from './pv';

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

describe('formatPv', () => {
  it('returns empty when given no UCIs', () => {
    const r = formatPv(START_FEN, []);
    expect(r.sans).toEqual([]);
    expect(r.invalid).toBe(0);
  });

  it('formats a clean PV from the initial position', () => {
    const r = formatPv(START_FEN, ['e2e4', 'e7e5', 'g1f3', 'b8c6']);
    expect(r.sans).toEqual(['e4', 'e5', 'Nf3', 'Nc6']);
    expect(r.invalid).toBe(0);
  });

  it('handles promotion UCIs (5-char)', () => {
    // Pawn on a7, white to move: a7-a8 promotes to queen.
    const fen = '4k3/P7/8/8/8/8/8/4K3 w - - 0 1';
    const r = formatPv(fen, ['a7a8q']);
    // Promoted with check from a8 to the e8 king.
    expect(r.sans).toEqual(['a8=Q+']);
    expect(r.invalid).toBe(0);
  });

  it('bails defensively on a malformed start FEN', () => {
    const r = formatPv('not a fen', ['e2e4']);
    expect(r.sans).toEqual([]);
    expect(r.invalid).toBe(1);
  });

  it('truncates at the first illegal UCI', () => {
    // First ply legal, second ply illegal (Black plays a White move).
    const r = formatPv(START_FEN, ['e2e4', 'd2d4']);
    expect(r.sans).toEqual(['e4']);
    expect(r.invalid).toBe(1);
  });

  it('treats too-short UCIs as invalid without throwing', () => {
    const r = formatPv(START_FEN, ['e2', 'g1f3']);
    expect(r.sans).toEqual([]);
    expect(r.invalid).toBe(1);
  });
});

describe('formatPvLine', () => {
  it('numbers a White-to-move PV from move 1', () => {
    expect(formatPvLine(START_FEN, ['e2e4', 'e7e5', 'g1f3'])).toBe(
      '1. e4 e5 2. Nf3',
    );
  });

  it('uses ellipsis numbering for a Black-to-move PV', () => {
    // After 1. e4 — Black to move, fullmove 1.
    const fen = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
    expect(formatPvLine(fen, ['e7e5', 'g1f3', 'b8c6'])).toBe(
      '1... e5 2. Nf3 Nc6',
    );
  });

  it('honors the FEN fullmove counter for mid-game positions', () => {
    // Random middlegame after 12 full moves, White to move, FEN says
    // fullmove=13 (next move is White's 13th).
    const fen = 'r1bqk2r/pp2bppp/2n1pn2/3p4/3P4/2N1PN2/PPQ1BPPP/R1B1K2R w KQkq - 0 13';
    expect(formatPvLine(fen, ['e1g1'])).toBe('13. O-O');
  });

  it('returns an empty string when nothing parses', () => {
    expect(formatPvLine('not a fen', ['e2e4'])).toBe('');
  });
});
