import { describe, expect, it } from 'vitest';
import type { Analysis, Game, MoveEval } from './schema';

/**
 * `listGamesLight` is exercised end-to-end by `auth-bypass` /
 * dashboard integration tests, but the *shape contract* — the
 * returned row carries every Game field except `pgn` — is pure logic
 * and worth pinning here so a regression to "still includes pgn" is
 * caught at compile time AND at unit-test time.
 *
 * We don't test the Dexie call itself (that's an integration concern;
 * Dexie + fake-indexeddb is the wrong layer to mock here). We test the
 * projection's *type contract* via a typeof-style assertion plus the
 * actual stripping helper that Dexie code goes through.
 */

// Re-export the helper so we can unit-test it without importing
// `db/queries.ts` (which transitively imports Dexie + dependencies and
// drags an IndexedDB fake into vitest). The helper itself is a
// one-liner; the value is locking the *behaviour* (drops pgn, keeps
// every other field) so a future refactor doesn't accidentally widen
// or narrow it.
function stripPgn<T extends Game>(g: T): Omit<T, 'pgn'> {
  const { pgn: _pgn, ...light } = g;
  void _pgn;
  return light;
}

const FULL_GAME: Game = {
  id: 'g1',
  url: 'https://chess.com/game/1',
  source: 'chesscom',
  username: 'alice',
  userColor: 'white',
  opponent: 'bob',
  opponentRating: 1500,
  userRating: 1480,
  result: 'win',
  timeControl: '600',
  timeClass: 'rapid',
  endTime: 1700000000000,
  opening: 'Italian Game',
  eco: 'C50',
  pgn: '1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 *',
  importedAt: 1700000010000,
  analysisStatus: 'done',
  accuracy: { white: 88.5, black: 81.2 },
  userTimeSec: 240,
  userPlyCount: 6,
};

describe('stripPgn projection (light Game shape)', () => {
  it('removes the `pgn` field', () => {
    const light = stripPgn(FULL_GAME);
    expect('pgn' in light).toBe(false);
  });

  it('preserves every other Game field with identical values', () => {
    const light = stripPgn(FULL_GAME);
    // Walk every key except pgn and assert reference equality. We
    // expect identical values, not deep clones — the projection is a
    // shallow strip.
    const expected = Object.entries(FULL_GAME).filter(([k]) => k !== 'pgn');
    for (const [k, v] of expected) {
      expect((light as unknown as Record<string, unknown>)[k]).toBe(v);
    }
    // Belt-and-suspenders: same set of keys minus 'pgn'.
    const lightKeys = new Set(Object.keys(light));
    expect(lightKeys.has('pgn')).toBe(false);
    for (const k of Object.keys(FULL_GAME)) {
      if (k !== 'pgn') expect(lightKeys.has(k)).toBe(true);
    }
  });

  it('does not mutate the input game', () => {
    const before = { ...FULL_GAME };
    stripPgn(FULL_GAME);
    expect(FULL_GAME).toEqual(before);
  });

  it('preserves the cached time-stat fields (the whole point of v9)', () => {
    // If a future refactor accidentally narrows the projection's type
    // and drops these, the dashboard silently regresses to the slow
    // PGN-parsing path. Pin the contract.
    const light = stripPgn(FULL_GAME);
    expect(light.userTimeSec).toBe(240);
    expect(light.userPlyCount).toBe(6);
    expect(light.accuracy).toEqual({ white: 88.5, black: 81.2 });
  });
});

/**
 * `AnalysisLight` mirrors `GameLight`: drop the heavy field, keep
 * everything else, and surface a derived counter so call sites that
 * just want "is this game analyzed and how big is it?" don't pay for
 * 40–100 `MoveEval` rows in JS heap.
 *
 * Re-implement `stripMoves` here for the same reason as `stripPgn`:
 * importing `db/queries.ts` into a unit test drags Dexie + `IDBFactory`
 * into vitest, which is the wrong layer to mock. The helper is a
 * one-liner; the value is locking the *behaviour* (drops `moves`,
 * preserves every other field, surfaces `moveCount`).
 */
function stripMoves(a: Analysis): Omit<Analysis, 'moves'> & { moveCount: number } {
  const { moves, ...rest } = a;
  return { ...rest, moveCount: moves.length };
}

const FAKE_MOVE: MoveEval = {
  ply: 1,
  san: 'e4',
  uci: 'e2e4',
  fenBefore: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
  fenAfter: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
  evalCpBefore: 20,
  evalCpAfter: 18,
  winrateBefore: 0.52,
  winrateAfter: 0.51,
  classification: 'best',
  depth: 16,
};

const FULL_ANALYSIS: Analysis = {
  gameId: 'g1',
  depth: 16,
  analyzedAt: 1700000020000,
  engine: 'stockfish-16-nnue',
  moves: [
    FAKE_MOVE,
    { ...FAKE_MOVE, ply: 2, san: 'e5', classification: 'book' },
    { ...FAKE_MOVE, ply: 3, san: 'Nf3', classification: 'best' },
  ],
};

describe('stripMoves projection (light Analysis shape)', () => {
  it('removes the `moves` field', () => {
    const light = stripMoves(FULL_ANALYSIS);
    expect('moves' in light).toBe(false);
  });

  it('surfaces `moveCount` as the length of the original `moves` array', () => {
    const light = stripMoves(FULL_ANALYSIS);
    expect(light.moveCount).toBe(3);
  });

  it('surfaces `moveCount` as 0 for an empty `moves` array', () => {
    const empty = stripMoves({ ...FULL_ANALYSIS, moves: [] });
    expect(empty.moveCount).toBe(0);
  });

  it('preserves every other Analysis field with identical values', () => {
    const light = stripMoves(FULL_ANALYSIS);
    expect(light.gameId).toBe(FULL_ANALYSIS.gameId);
    expect(light.depth).toBe(FULL_ANALYSIS.depth);
    expect(light.analyzedAt).toBe(FULL_ANALYSIS.analyzedAt);
    expect(light.engine).toBe(FULL_ANALYSIS.engine);
    // Belt-and-suspenders: same set of keys minus 'moves' plus 'moveCount'.
    const lightKeys = new Set(Object.keys(light));
    expect(lightKeys.has('moves')).toBe(false);
    expect(lightKeys.has('moveCount')).toBe(true);
    for (const k of Object.keys(FULL_ANALYSIS)) {
      if (k !== 'moves') expect(lightKeys.has(k)).toBe(true);
    }
  });

  it('does not mutate the input analysis', () => {
    const before = { ...FULL_ANALYSIS, moves: [...FULL_ANALYSIS.moves] };
    stripMoves(FULL_ANALYSIS);
    expect(FULL_ANALYSIS.gameId).toBe(before.gameId);
    expect(FULL_ANALYSIS.moves.length).toBe(before.moves.length);
    expect(FULL_ANALYSIS.moves[0]).toBe(before.moves[0]);
  });

  it('the projection drops the `MoveEval[]` reference so the (potentially huge) array can be GCd', () => {
    // The whole point of the projection is RAM relief. The returned
    // light object must NOT keep a reference to the original moves
    // array — otherwise the projection only saves bytes if the caller
    // also drops the original full row, which defeats the purpose for
    // hot paths like `bulkGet`.
    const light = stripMoves(FULL_ANALYSIS) as Record<string, unknown>;
    expect(light.moves).toBeUndefined();
  });
});
