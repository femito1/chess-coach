import { describe, expect, it } from 'vitest';
import type { RepertoireLineStats } from '@/db/schema';
import type { RankedOpeningLine } from '@/features/openings/recommendations';
import type { RepertoireLine } from './store';
import {
  appendActiveLineKeys,
  drillableGuidedIndices,
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

  it('falls back to the repertoire\'s own lines when no active key matches', () => {
    // The regression this pins: active keys are LIBRARY lines and only
    // match a repertoire line that equals or extends them. A repertoire
    // holding just a shallow mainline is a PREFIX of every deeper
    // recommendation, so the strict match returns nothing and the drill
    // page renders no board at all. Which lines rank top-5 changes with
    // every opening-data refresh, so this must not depend on luck.
    const mainline = practiceLine(['e2e4', 'e7e5', 'g1f3']);
    const deeperRecommendations = [
      'e2e4 e7e5 g1f3 b8c6',
      'e2e4 e7e5 g1f3 g8f6',
    ];
    expect(guidedLineIndices([mainline], deeperRecommendations)).toEqual([]);
    expect(drillableGuidedIndices([mainline], deeperRecommendations)).toEqual([0]);
  });

  it('still prefers a real match over the fallback, and caps the fallback', () => {
    const a = practiceLine(['a']);
    const b = practiceLine(['b']);
    expect(drillableGuidedIndices([a, b], ['b'])).toEqual([1]);
    const many = Array.from({ length: 9 }, (_, i) => practiceLine([`m${i}`]));
    expect(drillableGuidedIndices(many, ['nope'], 3)).toEqual([0, 1, 2]);
    expect(drillableGuidedIndices([], ['nope'])).toEqual([]);
  });
});
