import { describe, expect, it } from 'vitest';
import { shallowEqual } from './useThrottledLiveQuery';

describe('shallowEqual (dedup helper)', () => {
  it('returns true for identical references', () => {
    const arr = [1, 2, 3];
    expect(shallowEqual(arr, arr)).toBe(true);
  });

  it('returns true for primitives that are Object.is-equal', () => {
    expect(shallowEqual(1, 1)).toBe(true);
    expect(shallowEqual('a', 'a')).toBe(true);
    expect(shallowEqual(undefined, undefined)).toBe(true);
    expect(shallowEqual(NaN, NaN)).toBe(true); // Object.is special case
  });

  it('returns false for different primitives', () => {
    expect(shallowEqual(1, 2)).toBe(false);
    expect(shallowEqual('a', 'b')).toBe(false);
    expect(shallowEqual(0, -0)).toBe(false); // Object.is(0, -0) = false
  });

  it('returns false when one side is null', () => {
    expect(shallowEqual(null, {})).toBe(false);
    expect(shallowEqual({}, null)).toBe(false);
    expect(shallowEqual(null, null)).toBe(true);
  });

  it('returns true for arrays whose elements are all reference-equal', () => {
    const a = { id: '1' };
    const b = { id: '2' };
    expect(shallowEqual([a, b], [a, b])).toBe(true);
  });

  it('returns true for arrays of objects whose top-level fields are all Object.is-equal', () => {
    // This is the common Dexie return shape — `bulkGet` allocates new
    // row objects, but if the analyzer's write didn't change any
    // top-level field, we want to dedup. The dashboard's projected
    // GameLight rows have only flat fields plus a nested `accuracy`
    // object; here we test the all-flat-fields case.
    const aRows = [{ id: '1', x: 10 }, { id: '2', x: 20 }];
    const bRows = [{ id: '1', x: 10 }, { id: '2', x: 20 }];
    expect(shallowEqual(aRows, bRows)).toBe(true);
  });

  it('returns false when top-level fields differ', () => {
    const aRows = [{ id: '1', x: 10 }];
    const bRows = [{ id: '1', x: 11 }];
    expect(shallowEqual(aRows, bRows)).toBe(false);
  });

  it('returns false when a nested object reference changes (we are intentionally shallow)', () => {
    // Important: if the analyzer writes a fresh `accuracy` object onto
    // a Game row, the cache should bust. This test pins that
    // behaviour — we don't want a "Hours played" tile that lags after
    // accuracy actually changed.
    const a = [{ id: '1', accuracy: { white: 80, black: 75 } }];
    const b = [{ id: '1', accuracy: { white: 80, black: 75 } }];
    expect(shallowEqual(a, b)).toBe(false);
  });

  it('returns false when array lengths differ', () => {
    expect(shallowEqual([1, 2, 3], [1, 2])).toBe(false);
  });

  it('returns true for plain objects with identical own keys + values (e.g. countByStatus)', () => {
    // The throttled `countByStatus` query returns this shape; without
    // dedup, the dashboard's AnalysisStatus banner re-renders on every
    // analyzer write even when the totals haven't moved.
    const a = { pending: 0, running: 1, done: 5, error: 0 };
    const b = { pending: 0, running: 1, done: 5, error: 0 };
    expect(shallowEqual(a, b)).toBe(true);
  });

  it('returns false when an object key is added or removed', () => {
    const a = { pending: 0, running: 1, done: 5 };
    const b = { pending: 0, running: 1, done: 5, error: 0 };
    expect(shallowEqual(a, b)).toBe(false);
  });

  it('refuses to dedup non-plain objects (Map, Set, Date) to avoid silent staleness', () => {
    // We don't try to peek inside container types — better to refire
    // than to lie about equality. Pin the conservative behaviour.
    const a = new Map([['k', 1]]);
    const b = new Map([['k', 1]]);
    expect(shallowEqual(a, b)).toBe(false);

    const aSet = new Set([1, 2, 3]);
    const bSet = new Set([1, 2, 3]);
    expect(shallowEqual(aSet, bSet)).toBe(false);

    const aDate = new Date(0);
    const bDate = new Date(0);
    expect(shallowEqual(aDate, bDate)).toBe(false);
  });

  it('returns false when one side is array and the other is plain object', () => {
    expect(shallowEqual([1, 2, 3], { 0: 1, 1: 2, 2: 3, length: 3 })).toBe(false);
  });

  it('treats empty arrays as equal', () => {
    expect(shallowEqual([], [])).toBe(true);
  });
});
