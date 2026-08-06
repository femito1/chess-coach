import { describe, expect, it } from 'vitest';
import type { Classification, MoveEval } from '@/db/schema';
import {
  CURRENT_ACCURACY_MODEL,
  computeAccuracy,
  computeAccuracyWithModel,
  harmonicMean,
} from './analyzer';

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
