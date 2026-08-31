import { describe, expect, it } from 'vitest';
import { selectCandidates } from './selectCandidates';

const NNUE = 'stockfish-16-nnue';
const CLASSICAL = 'stockfish-16-classical';

const args = (over: Partial<Parameters<typeof selectCandidates>[0]> = {}) => ({
  gameIds: ['a'],
  existing: new Map<string, { depth: number; engine: string | null }>(),
  depth: 18,
  wantNnue: true,
  force: false,
  ...over,
});

describe('selectCandidates', () => {
  it('picks games with no analysis at all', () => {
    expect(selectCandidates(args())).toEqual([{ gameId: 'a', reason: 'missing' }]);
  });

  it('picks classical analyses for re-analysis when NNUE is wanted', () => {
    // This is what turns the classical→NNUE upgrade into a whole-library pass
    // rather than a special case: an existing analysis from a weaker evaluator
    // is not good enough, however deep it went.
    const existing = new Map([['a', { depth: 24, engine: CLASSICAL }]]);
    expect(selectCandidates(args({ existing }))).toEqual([
      { gameId: 'a', reason: 'weaker-evaluator' },
    ]);
  });

  it('treats a missing engine value as classical', () => {
    const existing = new Map([['a', { depth: 18, engine: null }]]);
    expect(selectCandidates(args({ existing }))[0].reason).toBe('weaker-evaluator');
  });

  it('skips an NNUE analysis that is already deep enough', () => {
    const existing = new Map([['a', { depth: 18, engine: NNUE }]]);
    expect(selectCandidates(args({ existing }))).toEqual([]);
  });

  it('picks an NNUE analysis that is too shallow', () => {
    const existing = new Map([['a', { depth: 16, engine: NNUE }]]);
    expect(selectCandidates(args({ existing }))).toEqual([
      { gameId: 'a', reason: 'shallower' },
    ]);
  });

  it('never downgrades NNUE to classical', () => {
    // Running the worker with EVALUATOR=classical must not overwrite better
    // work that already exists.
    const existing = new Map([['a', { depth: 12, engine: NNUE }]]);
    expect(selectCandidates(args({ existing, wantNnue: false }))).toEqual([]);
  });

  it('re-analyzes a shallow classical row when classical is wanted', () => {
    const existing = new Map([['a', { depth: 12, engine: CLASSICAL }]]);
    expect(selectCandidates(args({ existing, wantNnue: false }))).toEqual([
      { gameId: 'a', reason: 'shallower' },
    ]);
  });

  it('force re-analyzes everything, whatever the existing state', () => {
    const existing = new Map([['a', { depth: 30, engine: NNUE }]]);
    expect(selectCandidates(args({ existing, force: true }))).toEqual([
      { gameId: 'a', reason: 'forced' },
    ]);
  });

  it('handles a mixed library in one pass', () => {
    const existing = new Map([
      ['fresh', { depth: 18, engine: NNUE }],
      ['old', { depth: 16, engine: CLASSICAL }],
      ['shallow', { depth: 14, engine: NNUE }],
    ]);
    const out = selectCandidates(
      args({ gameIds: ['fresh', 'old', 'shallow', 'new'], existing }),
    );
    expect(out).toEqual([
      { gameId: 'old', reason: 'weaker-evaluator' },
      { gameId: 'shallow', reason: 'shallower' },
      { gameId: 'new', reason: 'missing' },
    ]);
  });

  it('returns nothing for an empty library', () => {
    expect(selectCandidates(args({ gameIds: [] }))).toEqual([]);
  });
});
