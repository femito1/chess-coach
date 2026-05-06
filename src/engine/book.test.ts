import { describe, expect, it } from 'vitest';
import { Chess } from 'chess.js';
import { bookFenKey, isBookFen, buildBookSet } from './book';

describe('bookFenKey', () => {
  it('keeps the first four FEN fields and strips counters', () => {
    const fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    expect(bookFenKey(fen)).toBe('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -');
  });
  it('returns empty string on null/undefined/empty input', () => {
    expect(bookFenKey(null)).toBe('');
    expect(bookFenKey(undefined)).toBe('');
    expect(bookFenKey('')).toBe('');
  });
});

describe('isBookFen', () => {
  it('returns true for the start position', () => {
    expect(isBookFen(new Chess().fen())).toBe(true);
  });

  it('returns true after 1.e4 (canonical opening move)', () => {
    const c = new Chess();
    c.move('e4');
    expect(isBookFen(c.fen())).toBe(true);
  });

  it('returns false for an obscure deep position with no book line', () => {
    // Construct a clearly-not-book position by playing a long sequence
    // of bizarre legal moves.
    const c = new Chess();
    const moves = ['a3', 'h6', 'h3', 'a6', 'g3', 'b6', 'f3', 'g6'];
    for (const m of moves) c.move(m);
    expect(isBookFen(c.fen())).toBe(false);
  });

  it('returns false for null/undefined/empty input', () => {
    expect(isBookFen(null)).toBe(false);
    expect(isBookFen(undefined)).toBe(false);
    expect(isBookFen('')).toBe(false);
  });
});

describe('buildBookSet', () => {
  it('contains the start position and is non-trivial in size', () => {
    const set = buildBookSet();
    expect(set.size).toBeGreaterThan(1000);
    expect(set.has(bookFenKey(new Chess().fen()))).toBe(true);
  });

  it('returns the same set instance on repeated calls (cached)', () => {
    expect(buildBookSet()).toBe(buildBookSet());
  });
});
