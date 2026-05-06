import { describe, expect, it } from 'vitest';
import { availableTimeClasses, gameMatchesFilter, labelFor } from './timeClass';

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
