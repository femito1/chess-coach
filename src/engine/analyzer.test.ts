import { describe, expect, it } from 'vitest';
import { Chess } from 'chess.js';
import type { Classification, MoveEval } from '@/db/schema';
import type { AnalysisResult } from './engine';
import {
  CURRENT_ACCURACY_MODEL,
  type EngineBackend,
  analyzeGamePgn,
  computeAccuracy,
  computeAccuracyWithModel,
  countUserBrilliancies,
  harmonicMean,
  repairTerminalMoveEval,
} from './analyzer';
import { cpToWinrate, moveAccuracy } from './classify';

function move(
  ply: number,
  loss: number,
  classification: Classification = 'good',
): MoveEval {
  return {
    ply,
    san: 'e4',
    uci: 'e2e4',
    fenBefore: 'before',
    fenAfter: 'after',
    evalCpBefore: 0,
    evalCpAfter: 0,
    winrateBefore: 0.5,
    winrateAfter: 0.5 - loss,
    classification,
    depth: 16,
  };
}

describe('countUserBrilliancies', () => {
  // Ply is 1-indexed with White on odd plies — same convention
  // `computeAccuracyWithModel` uses to split per-colour scores.
  it('counts only the requested colour', () => {
    const moves = [
      move(1, 0, 'brilliant'), // white
      move(2, 0, 'brilliant'), // black
      move(3, 0, 'brilliant'), // white
    ];
    expect(countUserBrilliancies(moves, 'white')).toBe(2);
    expect(countUserBrilliancies(moves, 'black')).toBe(1);
  });

  it('ignores every other classification', () => {
    const moves = [
      move(1, 0, 'best'),
      move(3, 0, 'excellent'),
      move(5, 0, 'book'),
      move(7, 0, 'blunder'),
    ];
    expect(countUserBrilliancies(moves, 'white')).toBe(0);
  });

  /** `0` (analyzed, none found) must be distinguishable from a missing
   *  field, which is what makes the boot backfill idempotent. */
  it('returns 0 rather than a falsy sentinel for a clean game', () => {
    expect(countUserBrilliancies([], 'white')).toBe(0);
    expect(countUserBrilliancies([move(1, 0, 'best')], 'black')).toBe(0);
  });
});

describe('harmonicMean', () => {
  it('returns 100 for an empty side', () => {
    expect(harmonicMean([])).toBe(100);
  });

  it('applies the configured outlier floor', () => {
    expect(harmonicMean([100, 0], 20)).toBeCloseTo(33.333, 3);
    expect(harmonicMean([100, 0], 0)).toBe(0);
  });
});

describe('computeAccuracy', () => {
  it('uses the calibrated no-book production model', () => {
    expect(CURRENT_ACCURACY_MODEL).toEqual({
      includeBook: false,
      floor: 20,
      gapMultiplier: 1.5,
    });
  });

  it('does not let synthetic book plies inflate the score', () => {
    const scoredMove = move(21, 0.1, 'mistake');
    const withoutBook = computeAccuracy([scoredMove]);
    const withBook = computeAccuracy([
      move(1, 0, 'book'),
      move(3, 0, 'book'),
      move(5, 0, 'book'),
      scoredMove,
    ]);

    expect(withBook.white).toBe(withoutBook.white);
  });

  it('keeps a genuinely lossless game at 100', () => {
    expect(computeAccuracy([move(1, 0, 'best'), move(2, 0, 'excellent')])).toEqual({
      white: 100,
      black: 100,
    });
  });

  it('returns 100 for a color with no engine-scored moves', () => {
    const result = computeAccuracy([move(1, 0, 'book'), move(2, 0.08, 'inaccuracy')]);
    expect(result.white).toBe(100);
    expect(result.black).toBeLessThan(100);
  });

  it('is monotonic as winrate loss grows', () => {
    const smallLoss = computeAccuracy([move(1, 0.03, 'good')]).white;
    const mediumLoss = computeAccuracy([move(1, 0.1, 'mistake')]).white;
    const mateSwing = computeAccuracy([move(1, 0.98, 'blunder')]).white;

    expect(smallLoss).toBeGreaterThan(mediumLoss);
    expect(mediumLoss).toBeGreaterThan(mateSwing);
    expect(mateSwing).toBe(0);
  });

  it('penalizes an isolated blunder without flattening an otherwise clean game', () => {
    const game = [
      move(1, 0, 'best'),
      move(3, 0, 'excellent'),
      move(5, 0.4, 'blunder'),
      move(7, 0, 'best'),
    ];
    const score = computeAccuracy(game).white;

    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(70);
  });

  it('supports the legacy model for benchmark comparisons', () => {
    const game = [move(1, 0, 'book'), move(3, 0.1, 'mistake')];
    const legacy = computeAccuracyWithModel(game, {
      includeBook: true,
      floor: 20,
      gapMultiplier: 1,
    });
    const calibrated = computeAccuracy(game);

    expect(legacy.white).toBeGreaterThan(calibrated.white);
  });
});

/**
 * Scholar's mate. Short, ends on the board, and the mating move is nobody's
 * book line — everything the terminal-position path needs.
 */
const SCHOLARS_MATE = '1. e4 e5 2. Bc4 Nc6 3. Qh5 Nf6 4. Qxf7#';

/**
 * What Stockfish actually answers for a position with no legal move:
 * `info depth 0 score mate 0` carries no `pv`, and `engine.ts` only folds
 * pv-bearing infos into its result — so both score fields arrive null and a
 * naive reader sees 0 cp, dead equal. Pinned here so the analyzer is tested
 * against the engine's real behaviour rather than a friendlier stand-in.
 */
const UNSCOREABLE: AnalysisResult = {
  depth: 0,
  bestMoveUci: null,
  scoreCp: null,
  scoreMate: null,
  pv: [],
};

function stubBackend(): { backend: EngineBackend; asked: string[] } {
  const asked: string[] = [];
  const backend: EngineBackend = {
    id: () => 'stub',
    newGame: async () => {},
    analyze: async (fen) => {
      asked.push(fen);
      const legal = new Chess(fen).moves({ verbose: true });
      if (legal.length === 0) return UNSCOREABLE;
      return {
        depth: 16,
        bestMoveUci: legal[0].from + legal[0].to,
        scoreCp: 0,
        scoreMate: null,
        pv: [],
      };
    },
  };
  return { backend, asked };
}

function finalFenOf(pgn: string): string {
  const c = new Chess();
  c.loadPgn(pgn);
  return c.fen();
}

describe('analyzeGamePgn on a game that ends in checkmate', () => {
  it('never asks the engine about the mated position', async () => {
    const { backend, asked } = stubBackend();
    await analyzeGamePgn('g1', SCHOLARS_MATE, 16, undefined, undefined, { backend });
    expect(asked).not.toContain(finalFenOf(SCHOLARS_MATE));
  });

  /**
   * The bug this pins: the mated position came back unscoreable, was read as
   * 0 cp, and the mating move therefore recorded a ~48-point winrate drop —
   * a `blunder`-sized loss scored at ~10% accuracy, for delivering mate.
   */
  it('charges the mating move no winrate loss', async () => {
    const { backend } = stubBackend();
    const a = await analyzeGamePgn('g2', SCHOLARS_MATE, 16, undefined, undefined, {
      backend,
    });
    const mate = a.moves[a.moves.length - 1];
    expect(mate.san).toBe('Qxf7#');
    expect(mate.winrateAfter).toBeGreaterThanOrEqual(mate.winrateBefore);
    const loss = Math.max(0, (mate.winrateBefore - mate.winrateAfter) * 100);
    // `moveAccuracy(0)` is the formula's ceiling (99.9999, not a round 100),
    // so compare against it rather than a literal.
    expect(moveAccuracy(loss)).toBe(moveAccuracy(0));
    expect(mate.classification).not.toBe('blunder');
  });

  it('records the mate on the move that delivered it', async () => {
    const { backend } = stubBackend();
    const a = await analyzeGamePgn('g3', SCHOLARS_MATE, 16, undefined, undefined, {
      backend,
    });
    const mate = a.moves[a.moves.length - 1];
    // White mated, so White-POV centipawns are decisively positive.
    expect(mate.evalCpAfter).toBeGreaterThan(0);
    expect(mate.mateInAfter).toBe(0);
  });

  it('leaves the winner\'s game accuracy high', async () => {
    const { backend } = stubBackend();
    const a = await analyzeGamePgn('g4', SCHOLARS_MATE, 16, undefined, undefined, {
      backend,
    });
    expect(computeAccuracy(a.moves).white).toBeGreaterThan(90);
  });
});

describe('repairTerminalMoveEval', () => {
  /** A stored move whose `fenAfter` is the mated position, recorded the old
   *  way: 0 cp, and a mover winrate that collapsed to parity. */
  function storedMatingMove(overrides: Partial<MoveEval> = {}): MoveEval {
    return {
      ply: 29,
      san: 'Qf7#',
      uci: 'h5f7',
      fenBefore: 'r2q1knr/p2nb1p1/2pp1p1p/1p5Q/4P3/1BN4P/PB3PP1/3RR1K1 w - - 2 15',
      fenAfter: 'r2q1knr/p2nbQp1/2pp1p1p/1p6/4P3/1BN4P/PB3PP1/3RR1K1 b - - 3 15',
      evalCpBefore: 9999,
      evalCpAfter: 0,
      winrateBefore: 0.975,
      winrateAfter: 0.5,
      classification: 'best',
      depth: 16,
      ...overrides,
    };
  }

  it('restores the mover winrate a checkmated fenAfter should have had', () => {
    const fixed = repairTerminalMoveEval(storedMatingMove());
    expect(fixed.winrateAfter).toBeCloseTo(cpToWinrate(1000), 6);
    expect(fixed.evalCpAfter).toBeGreaterThan(0);
    expect(fixed.mateInAfter).toBe(0);
  });

  it('is symmetric — a mating Black move reads as decisive for Black', () => {
    // 1. f3 e5 2. g4 Qh4#
    const pgn = '1. f3 e5 2. g4 Qh4#';
    const c = new Chess();
    c.loadPgn(pgn);
    const fixed = repairTerminalMoveEval(
      storedMatingMove({ ply: 4, san: 'Qh4#', fenAfter: c.fen() }),
    );
    expect(fixed.evalCpAfter).toBeLessThan(0);
    // Still the *mover's* winrate, so still high — Black is the one mating.
    expect(fixed.winrateAfter).toBeCloseTo(cpToWinrate(1000), 6);
  });

  it('treats stalemate as a draw for the mover, not a win', () => {
    const fixed = repairTerminalMoveEval(
      storedMatingMove({ fenAfter: '7k/5Q2/6K1/8/8/8/8/8 b - - 0 1' }),
    );
    expect(fixed.evalCpAfter).toBe(0);
    expect(fixed.winrateAfter).toBeCloseTo(0.5, 6);
    expect(fixed.mateInAfter).toBeUndefined();
  });

  /** Identity matters: the recompute pass uses `!==` to decide whether a row
   *  changed, so a no-op repair must not look like an edit. */
  it('returns the same object when fenAfter has legal moves', () => {
    const m = storedMatingMove({
      fenAfter: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
    });
    expect(repairTerminalMoveEval(m)).toBe(m);
  });

  it('returns the same object when the row is already correct', () => {
    const once = repairTerminalMoveEval(storedMatingMove());
    expect(repairTerminalMoveEval(once)).toBe(once);
  });
});
