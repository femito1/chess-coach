import { describe, expect, it } from 'vitest';
import { selectCandidates, selectUnsettled } from './selectCandidates';

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

describe('selectUnsettled', () => {
  const NNUE18 = { depth: 18, engine: NNUE };

  it('settles a game whose analysis landed but whose row is still pending', () => {
    // The kill-between-two-writes case: without this the game is skipped
    // forever, because an adequate analysis exists.
    const games = [{ game_id: 'a', analysis_status: 'pending' }];
    const existing = new Map([['a', NNUE18]]);
    expect(selectUnsettled({ games, existing, candidates: [] })).toEqual(['a']);
  });

  it('leaves done games, and games about to be re-analyzed, alone', () => {
    const games = [
      { game_id: 'done', analysis_status: 'done' },
      { game_id: 'none', analysis_status: 'pending' },
      { game_id: 'queued', analysis_status: 'pending' },
      { game_id: 'err', analysis_status: 'error' },
    ];
    const existing = new Map([
      ['done', NNUE18],
      ['queued', { depth: 12, engine: NNUE }],
      ['err', NNUE18],
    ]);
    const candidates = selectCandidates({
      gameIds: games.map((g) => g.game_id),
      existing,
      depth: 18,
      wantNnue: true,
      force: false,
    });
    // `none` is a candidate (missing) and `queued` one (shallower): the
    // re-analysis settles both. Only `err` needs settling on its own.
    expect(selectUnsettled({ games, existing, candidates })).toEqual(['err']);
  });
});
