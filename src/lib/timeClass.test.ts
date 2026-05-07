import { describe, expect, it } from 'vitest';
import {
  availableTimeClasses,
  gameMatchesFilter,
  gameMatchesSelection,
  isAllTimeClasses,
  labelFor,
  labelForSelection,
  toggleTimeClass,
} from './timeClass';
import { normalizeTimeClassSelection } from '@/db/schema';

describe('gameMatchesFilter', () => {
  it("'all' matches every game including ones without a class", () => {
    expect(gameMatchesFilter({ timeClass: 'rapid' }, 'all')).toBe(true);
    expect(gameMatchesFilter({ timeClass: undefined }, 'all')).toBe(true);
  });
  it("'rapid' only matches rapid games", () => {
    expect(gameMatchesFilter({ timeClass: 'rapid' }, 'rapid')).toBe(true);
    expect(gameMatchesFilter({ timeClass: 'blitz' }, 'rapid')).toBe(false);
    expect(gameMatchesFilter({ timeClass: undefined }, 'rapid')).toBe(false);
  });
});

describe('availableTimeClasses', () => {
  it('returns the canonical-order subset present in the library', () => {
    const games = [
      { timeClass: 'blitz' },
      { timeClass: 'rapid' },
      { timeClass: 'bullet' },
      { timeClass: 'rapid' },
    ];
    // Canonical order is rapid, blitz, bullet, daily, classical.
    expect(availableTimeClasses(games)).toEqual(['rapid', 'blitz', 'bullet']);
  });
  it('skips classes with zero games', () => {
    expect(availableTimeClasses([{ timeClass: 'rapid' }])).toEqual(['rapid']);
  });
  it('returns [] for an empty library', () => {
    expect(availableTimeClasses([])).toEqual([]);
  });
});

describe('labelFor', () => {
  it('formats canonical time classes', () => {
    expect(labelFor('rapid')).toBe('Rapid');
    expect(labelFor('blitz')).toBe('Blitz');
    expect(labelFor('bullet')).toBe('Bullet');
    expect(labelFor('all')).toBe('All time controls');
  });
});

describe('gameMatchesSelection (multi-select)', () => {
  it('empty selection means "no filter" — every game matches', () => {
    expect(gameMatchesSelection({ timeClass: 'rapid' }, [])).toBe(true);
    expect(gameMatchesSelection({ timeClass: 'blitz' }, [])).toBe(true);
    expect(gameMatchesSelection({ timeClass: undefined }, [])).toBe(true);
  });
  it('single-value selection behaves like the legacy filter', () => {
    expect(gameMatchesSelection({ timeClass: 'rapid' }, ['rapid'])).toBe(true);
    expect(gameMatchesSelection({ timeClass: 'blitz' }, ['rapid'])).toBe(false);
    expect(gameMatchesSelection({ timeClass: undefined }, ['rapid'])).toBe(false);
  });
  it('multi-value selection matches any of the chosen classes', () => {
    expect(gameMatchesSelection({ timeClass: 'rapid' }, ['rapid', 'blitz'])).toBe(true);
    expect(gameMatchesSelection({ timeClass: 'blitz' }, ['rapid', 'blitz'])).toBe(true);
    expect(gameMatchesSelection({ timeClass: 'bullet' }, ['rapid', 'blitz'])).toBe(false);
    expect(gameMatchesSelection({ timeClass: undefined }, ['rapid', 'blitz'])).toBe(false);
  });
  it('explicit-none sentinel matches no game (chip bar "deselect all" state)', () => {
    // Used by `<TimeClassChips>` to represent "user clicked All while
    // every chip was lit, intending to deselect everything". Persists
    // as a `TimeClass[]` (no schema change) and short-circuits to
    // false here so pages render an empty list.
    const NONE = ['__none__'] as unknown as Parameters<typeof gameMatchesSelection>[1];
    expect(gameMatchesSelection({ timeClass: 'rapid' }, NONE)).toBe(false);
    expect(gameMatchesSelection({ timeClass: 'blitz' }, NONE)).toBe(false);
    expect(gameMatchesSelection({ timeClass: undefined }, NONE)).toBe(false);
  });
});

describe('labelForSelection', () => {
  it('renders empty as the global "all" label', () => {
    expect(labelForSelection([])).toBe('All time controls');
  });
  it('renders a single bucket as the bucket label', () => {
    expect(labelForSelection(['rapid'])).toBe('Rapid');
  });
  it('joins multiple buckets with " + " in canonical order', () => {
    expect(labelForSelection(['blitz', 'rapid'])).toBe('Rapid + Blitz');
    expect(labelForSelection(['bullet', 'rapid', 'blitz'])).toBe('Rapid + Blitz + Bullet');
  });
});

describe('isAllTimeClasses', () => {
  it('treats empty array as "all"', () => {
    expect(isAllTimeClasses([])).toBe(true);
  });
  it('any non-empty selection is NOT "all"', () => {
    expect(isAllTimeClasses(['rapid'])).toBe(false);
    expect(isAllTimeClasses(['rapid', 'blitz'])).toBe(false);
  });
});

describe('toggleTimeClass', () => {
  it('adds an absent class (canonical order preserved)', () => {
    expect(toggleTimeClass([], 'rapid')).toEqual(['rapid']);
    // Adding blitz to a selection that already has bullet places them
    // in canonical order (rapid → blitz → bullet → daily → classical).
    expect(toggleTimeClass(['bullet'], 'blitz')).toEqual(['blitz', 'bullet']);
    expect(toggleTimeClass(['rapid'], 'blitz')).toEqual(['rapid', 'blitz']);
  });
  it('removes an existing class, preserving the rest in their order', () => {
    expect(toggleTimeClass(['rapid', 'blitz'], 'rapid')).toEqual(['blitz']);
    expect(toggleTimeClass(['rapid', 'blitz', 'bullet'], 'blitz')).toEqual(['rapid', 'bullet']);
  });
  it('returns a fresh array every call (no shared reference)', () => {
    const initial: ReturnType<typeof toggleTimeClass> = ['rapid'];
    const next = toggleTimeClass(initial, 'blitz');
    expect(next).not.toBe(initial);
  });
});

describe('normalizeTimeClassSelection (Settings legacy migration)', () => {
  it('null/undefined → default ["rapid"]', () => {
    expect(normalizeTimeClassSelection(undefined)).toEqual(['rapid']);
    expect(normalizeTimeClassSelection(null)).toEqual(['rapid']);
  });
  it("legacy 'all' → empty array (which our matcher reads as 'all')", () => {
    expect(normalizeTimeClassSelection('all')).toEqual([]);
  });
  it('legacy single value → one-element array', () => {
    expect(normalizeTimeClassSelection('rapid')).toEqual(['rapid']);
    expect(normalizeTimeClassSelection('bullet')).toEqual(['bullet']);
  });
  it('already-array shape passes through, deduped + filtered', () => {
    expect(normalizeTimeClassSelection(['rapid', 'blitz'])).toEqual(['rapid', 'blitz']);
    expect(normalizeTimeClassSelection(['rapid', 'rapid'])).toEqual(['rapid']);
    expect(normalizeTimeClassSelection(['rapid', 'bogus'])).toEqual(['rapid']);
  });
  it('garbage shapes fall back to default', () => {
    expect(normalizeTimeClassSelection(42)).toEqual(['rapid']);
    expect(normalizeTimeClassSelection({ ok: true })).toEqual(['rapid']);
  });
});
