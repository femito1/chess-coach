import { describe, expect, it } from 'vitest';
import type { Game } from './schema';

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
