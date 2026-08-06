import { describe, expect, it } from 'vitest';
import type { RepertoireLineStats } from '@/db/schema';
import type { RankedOpeningLine } from '@/features/openings/recommendations';
import type { RepertoireLine } from './store';
import {
  appendActiveLineKeys,
  areGuidedLinesMastered,
  guidedLineIndices,
  initialActiveLineKeys,
  isLineMastered,
  nextRecommendedLines,
} from './curriculum';

function practiceLine(uci: string[]): RepertoireLine {
  return { uci, san: uci, fens: [], name: uci.join(' ') };
}

function ranked(name: string, uci: string[]): RankedOpeningLine {
  return {
    line: {
      eco: 'C00',
      name,
      family: 'Test',
      variation: name,
      uci,
      pgn: '',
      globalGames: 1,
      globalShare: 1,
    },
    score: 1,
    globalScore: 1,
    personalCount: 0,
    personalShare: 0,
  };
}

function stats(
  uciKey: string,
  completions: number,
  perfectCompletions: number,
): RepertoireLineStats {
  return {
    id: `rep:${uciKey}`,
    repertoireId: 'rep',
    uciKey,
    sanPreview: '',
    attempts: completions,
    completions,
    movesPlayed: 0,
    correctMoves: 0,
    wrongMoves: 0,
    perfectCompletions,
    createdAt: 0,
  };
}

describe('guided repertoire curriculum', () => {
  it('caps a new starter set at five lines', () => {
    const lines = Array.from({ length: 8 }, (_, index) =>
      ranked(`Line ${index}`, [`move-${index}`]),
    );
    expect(initialActiveLineKeys(lines)).toHaveLength(5);
  });

  it('treats one perfect or two normal completions as mastery', () => {
    expect(isLineMastered(stats('a', 1, 1))).toBe(true);
    expect(isLineMastered(stats('a', 2, 0))).toBe(true);
    expect(isLineMastered(stats('a', 1, 0))).toBe(false);
    expect(isLineMastered(undefined)).toBe(false);
  });

  it('maps a shorter active key to the shortest matching imported leaf', () => {
    const lines = [
      practiceLine(['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4']),
      practiceLine(['e2e4', 'e7e5', 'g1f3', 'b8c6', 'd2d4', 'e5d4']),
      practiceLine(['d2d4', 'd7d5']),
    ];
    expect(guidedLineIndices(lines, ['e2e4 e7e5 g1f3'])).toEqual([0]);
  });

  it('requires every selected line to be mastered before expansion', () => {
    const lines = [practiceLine(['a']), practiceLine(['b'])];
    const partial = new Map([['a', stats('a', 1, 1)]]);
    const complete = new Map([
      ['a', stats('a', 1, 1)],
      ['b', stats('b', 2, 0)],
    ]);
    expect(areGuidedLinesMastered(lines, [0, 1], partial)).toBe(false);
    expect(areGuidedLinesMastered(lines, [0, 1], complete)).toBe(true);
  });

  it('offers two inactive recommendations and appends them idempotently', () => {
    const rankedLines = [
      ranked('A', ['a']),
      ranked('B', ['b']),
      ranked('C', ['c']),
      ranked('D', ['d']),
    ];
    const next = nextRecommendedLines(rankedLines, ['a', 'b']);
    expect(next.map((entry) => entry.line.name)).toEqual(['C', 'D']);
    expect(appendActiveLineKeys(['a', 'b'], ['b', 'c'])).toEqual(['a', 'b', 'c']);
  });
});
