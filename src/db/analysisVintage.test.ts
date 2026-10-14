import { describe, expect, it } from 'vitest';
import { isSameSearch } from './analysisVintage';

/**
 * The recompute pass's write guard. It reads a row, reclassifies it across
 * several yields, and must not write the result over a row that changed in the
 * meantime — a requeue's deletion or a pulled better analysis.
 */
describe('isSameSearch', () => {
  const read = { analyzedAt: 100, engine: 'stockfish-16-classical', depth: 16 };

  it('accepts the row it read', () => {
    expect(isSameSearch(read, { ...read })).toBe(true);
  });

  it('rejects a row a requeue deleted', () => {
    expect(isSameSearch(read, undefined)).toBe(false);
  });

  it('rejects a replacement analysis, whichever identity field differs', () => {
    expect(isSameSearch(read, { ...read, analyzedAt: 200 })).toBe(false);
    expect(isSameSearch(read, { ...read, engine: 'stockfish-16-nnue' })).toBe(false);
    expect(isSameSearch(read, { ...read, depth: 18 })).toBe(false);
  });
});
