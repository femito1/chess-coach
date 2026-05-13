import { describe, it, expect } from 'vitest';
import {
  persistedStorageKey,
  readPersistedValue,
  resolveNext,
  writePersistedValue,
} from './usePersistedState';

/** Tiny in-memory `Storage` stub. Vitest runs unit tests in the `node`
 *  environment (per `vitest.config.ts`), so `localStorage` doesn't
 *  exist. The pure helpers accept an injected `storage` arg so the
 *  test can drive them without any DOM. */
function makeStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
    setItem: (k: string, v: string) => void store.set(k, v),
    _peek: (k: string) => store.get(k),
    _all: () => Array.from(store.entries()),
  };
}

describe('persistedStorageKey', () => {
  it('namespaces under chess-coach: with a version suffix', () => {
    expect(persistedStorageKey('chart-range', 1)).toBe('chess-coach:chart-range:v1');
    expect(persistedStorageKey('chart-range', 7)).toBe('chess-coach:chart-range:v7');
  });

  it('keeps user-supplied separators in the key intact', () => {
    // Persisted-state keys are owned by callers; we don't sanitize.
    // Keeping `:` in the user portion is an explicit non-policy so that
    // a future "namespaced subkey" pattern (e.g. `dashboard:rating`)
    // is unambiguously retrievable.
    expect(persistedStorageKey('dashboard:rating', 1)).toBe(
      'chess-coach:dashboard:rating:v1',
    );
  });
});

describe('resolveNext', () => {
  it('returns a literal value as-is', () => {
    expect(resolveNext(42, 0)).toBe(42);
  });

  it('calls a function with the previous value', () => {
    expect(resolveNext((n: number) => n + 1, 41)).toBe(42);
  });

  it("doesn't treat a literal object as a function", () => {
    const v = { count: 5 };
    expect(resolveNext(v, { count: 0 })).toBe(v);
  });
});

describe('readPersistedValue', () => {
  it('returns the default when the key is missing', () => {
    const storage = makeStorage();
    expect(readPersistedValue('chess-coach:k:v1', 'default', undefined, storage)).toBe(
      'default',
    );
  });

  it('parses + returns the stored JSON value', () => {
    const storage = makeStorage({ 'chess-coach:k:v1': JSON.stringify({ x: 1 }) });
    expect(
      readPersistedValue('chess-coach:k:v1', { x: 0 }, undefined, storage),
    ).toEqual({ x: 1 });
  });

  it('returns the default for malformed JSON', () => {
    const storage = makeStorage({ 'chess-coach:k:v1': '{not json' });
    expect(readPersistedValue('chess-coach:k:v1', 'fallback', undefined, storage)).toBe(
      'fallback',
    );
  });

  it('rejects values that fail the validator', () => {
    type Range = '7d' | '30d' | 'all';
    const isRange = (v: unknown): v is Range =>
      v === '7d' || v === '30d' || v === 'all';

    const storage = makeStorage({ 'chess-coach:k:v1': JSON.stringify('garbage') });
    expect(
      readPersistedValue<Range>('chess-coach:k:v1', '30d', isRange, storage),
    ).toBe('30d');
  });

  it('accepts values that pass the validator', () => {
    type Range = '7d' | '30d' | 'all';
    const isRange = (v: unknown): v is Range =>
      v === '7d' || v === '30d' || v === 'all';

    const storage = makeStorage({ 'chess-coach:k:v1': JSON.stringify('7d') });
    expect(
      readPersistedValue<Range>('chess-coach:k:v1', '30d', isRange, storage),
    ).toBe('7d');
  });

  it('returns the default when storage is null (SSR / disabled)', () => {
    expect(readPersistedValue('any', 'default', undefined, null)).toBe('default');
  });
});

describe('writePersistedValue', () => {
  it('serializes + writes JSON to the given storage', () => {
    const storage = makeStorage();
    const ok = writePersistedValue('chess-coach:k:v1', { x: 1 }, storage);
    expect(ok).toBe(true);
    expect(storage._peek('chess-coach:k:v1')).toBe(JSON.stringify({ x: 1 }));
  });

  it('returns false (without throwing) when setItem throws', () => {
    // Models QuotaExceededError and the various private-mode storage
    // failures we can't preempt. The hook treats this as "persistence
    // unavailable, keep working in-memory".
    const throwingStorage = {
      setItem: () => {
        throw new Error('QuotaExceeded');
      },
    };
    expect(() =>
      writePersistedValue('chess-coach:k:v1', 'value', throwingStorage),
    ).not.toThrow();
    expect(writePersistedValue('chess-coach:k:v1', 'value', throwingStorage)).toBe(
      false,
    );
  });

  it('returns false when storage is null', () => {
    expect(writePersistedValue('any', 'value', null)).toBe(false);
  });
});

describe('round-trip', () => {
  it('persists a value, then reads it back unchanged', () => {
    const storage = makeStorage();
    const key = persistedStorageKey('round-trip', 1);
    const original = { selection: ['7d', 'rapid'], collapsed: true };

    writePersistedValue(key, original, storage);
    const read = readPersistedValue(key, { selection: [], collapsed: false }, undefined, storage);

    expect(read).toEqual(original);
    // Pinned to JSON-equality, not reference-equality. Persistence
    // crosses a serialization boundary and the read returns a fresh
    // object every time.
    expect(read).not.toBe(original);
  });

  it('a v1 → v2 shape change isolates stale data behind the namespace', () => {
    const storage = makeStorage();
    // Old v1 row with the old shape (a string).
    writePersistedValue(persistedStorageKey('shape', 1), 'old-string', storage);
    // New v2 reader expecting an object — under a different key, sees
    // nothing, falls back to the default. Old row is harmlessly
    // ignored (and can be cleaned up later by a migration if we care).
    expect(
      readPersistedValue(persistedStorageKey('shape', 2), { count: 0 }, undefined, storage),
    ).toEqual({ count: 0 });
    // Old row is still present — explicitly NOT auto-deleted; that's
    // a separate migration concern. If we do clean up later, it's a
    // single sweep across the chess-coach: prefix.
    expect(storage._peek(persistedStorageKey('shape', 1))).toBeDefined();
  });
});
