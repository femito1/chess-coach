import { describe, expect, it } from 'vitest';
import {
  CLASSIFICATION_LABEL,
  CLASSIFICATION_ORDER,
  CLASSIFICATION_SYMBOL,
  classifyMove,
  cpToWinrate,
  mateToCp,
  moveAccuracy,
} from './classify';

describe('cpToWinrate', () => {
  it('returns 0.5 at 0cp', () => {
    expect(cpToWinrate(0)).toBeCloseTo(0.5, 3);
  });
  it('saturates near 1 for huge positive cp', () => {
    expect(cpToWinrate(2000)).toBeGreaterThan(0.95);
    expect(cpToWinrate(2000)).toBeLessThanOrEqual(1);
  });
  it('saturates near 0 for huge negative cp', () => {
    expect(cpToWinrate(-2000)).toBeLessThan(0.05);
    expect(cpToWinrate(-2000)).toBeGreaterThanOrEqual(0);
  });
  it('is monotonically increasing', () => {
    const samples = [-500, -100, -50, 0, 50, 100, 500];
    let prev = -Infinity;
    for (const cp of samples) {
      const w = cpToWinrate(cp);
      expect(w).toBeGreaterThan(prev);
      prev = w;
    }
  });
});

describe('moveAccuracy', () => {
  it('returns 100 for zero winrate loss', () => {
    expect(moveAccuracy(0)).toBeCloseTo(100, 1);
  });
  it('decreases as loss grows', () => {
    expect(moveAccuracy(10)).toBeGreaterThan(moveAccuracy(50));
  });
  it('treats negative loss as zero', () => {
    expect(moveAccuracy(-5)).toBeCloseTo(100, 1);
  });
});

describe('mateToCp', () => {
  it('encodes mate-in-1 as just under +10000', () => {
    expect(mateToCp(1)).toBe(9999);
  });
  it('encodes mate-against in N as just over -10000', () => {
    expect(mateToCp(-1)).toBe(-9999);
  });
  it('returns 0 for mate=0', () => {
    expect(mateToCp(0)).toBe(0);
  });
});

describe('classifyMove', () => {
  // Standard starting FEN — useful as a stand-in when the test isn't
  // exercising the brilliancy SEE codepath.
  const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

  it('flags a very early engine #1 in a recognized opening as book', () => {
    const c = classifyMove({
      moverWinrateBefore: 0.5,
      moverWinrateAfter: 0.52,
      isBest: true,
      ply: 2,
      inBookPhase: true,
      fenBefore: START,
      playedUci: 'e2e4',
    });
    expect(c).toBe('book');
  });

  it('classifies an engine #1 outside book as best', () => {
    const c = classifyMove({
      moverWinrateBefore: 0.5,
      moverWinrateAfter: 0.5,
      isBest: true,
      ply: 25,
      inBookPhase: false,
      fenBefore: START,
      playedUci: 'a2a3',
    });
    expect(c).toBe('best');
  });

  it('classifies a small drop on a non-best move as good', () => {
    const c = classifyMove({
      moverWinrateBefore: 0.55,
      moverWinrateAfter: 0.53,
      isBest: false,
      ply: 30,
      inBookPhase: false,
      fenBefore: START,
      playedUci: 'a2a3',
    });
    expect(c).toBe('good');
  });

  it('classifies an inaccuracy at ~7pp drop', () => {
    const c = classifyMove({
      moverWinrateBefore: 0.55,
      moverWinrateAfter: 0.48,
      isBest: false,
      ply: 30,
      inBookPhase: false,
      fenBefore: START,
      playedUci: 'a2a3',
    });
    expect(c).toBe('inaccuracy');
  });

  it('classifies a mistake at ~15pp drop in roughly equal position', () => {
    const c = classifyMove({
      moverWinrateBefore: 0.55,
      moverWinrateAfter: 0.4,
      isBest: false,
      ply: 30,
      inBookPhase: false,
      fenBefore: START,
      playedUci: 'a2a3',
    });
    expect(c).toBe('mistake');
  });

  it('classifies a "miss" when a clearly winning side gives up the win', () => {
    const c = classifyMove({
      moverWinrateBefore: 0.9,
      moverWinrateAfter: 0.5,
      isBest: false,
      ply: 30,
      inBookPhase: false,
      fenBefore: START,
      playedUci: 'a2a3',
    });
    expect(c).toBe('miss');
  });

  it('classifies a blunder when the mover ends up clearly losing', () => {
    const c = classifyMove({
      moverWinrateBefore: 0.6,
      moverWinrateAfter: 0.1,
      isBest: false,
      ply: 30,
      inBookPhase: false,
      fenBefore: START,
      playedUci: 'a2a3',
    });
    expect(c).toBe('blunder');
  });

  it('does NOT label a forced only-move as brilliant', () => {
    // White king on g1, black queen delivering check on g3 — only legal
    // reply is Kh2 (or similar). It can't be "brilliant".
    const fen = '6k1/8/8/8/8/6q1/8/6K1 w - - 0 1';
    const c = classifyMove({
      moverWinrateBefore: 0.5,
      moverWinrateAfter: 0.5,
      isBest: true,
      ply: 30,
      inBookPhase: false,
      fenBefore: fen,
      playedUci: 'g1h2',
    });
    expect(c).toBe('best');
  });
});

describe('classification metadata tables', () => {
  it('has labels and symbols for every ordered classification', () => {
    for (const c of CLASSIFICATION_ORDER) {
      expect(CLASSIFICATION_LABEL[c]).toBeTruthy();
      expect(CLASSIFICATION_SYMBOL[c]).toBeTruthy();
    }
  });
});
