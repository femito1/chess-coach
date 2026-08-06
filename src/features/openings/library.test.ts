import { describe, expect, it } from 'vitest';
import {
  familyDescription,
  getVariations,
  isFamilySort,
  isKnownOpeningFamily,
  sortFamilies,
  type FamilyGroup,
  type FamilySort,
} from './library';

/** Synthetic groups used to pin sort behaviour without depending on
 *  the (large + frequently-regenerated) opening dataset. The shape
 *  matches `FamilyGroup` exactly. */
function group(
  family: string,
  count: number,
  popularity: number,
): FamilyGroup {
  return {
    family,
    count,
    ecos: [],
    color: 'white',
    popularity,
    description: '',
  };
}

describe('isFamilySort', () => {
  it('accepts every supported value', () => {
    const valid: FamilySort[] = ['popular', 'most-lines', 'fewest-lines', 'alpha'];
    for (const v of valid) expect(isFamilySort(v)).toBe(true);
  });

  it('rejects unknown / typo / non-string values', () => {
    expect(isFamilySort('most_lines')).toBe(false); // underscore ≠ hyphen
    expect(isFamilySort('alphabetical')).toBe(false);
    expect(isFamilySort('')).toBe(false);
    expect(isFamilySort(undefined)).toBe(false);
    expect(isFamilySort(null)).toBe(false);
    expect(isFamilySort(42)).toBe(false);
    expect(isFamilySort({})).toBe(false);
  });
});

describe('sortFamilies', () => {
  // Hand-picked input where every mode produces a different order — the
  // tests assert the exact order each mode emits so a future tweak that
  // accidentally inverts a comparator fails fast.
  const groups: FamilyGroup[] = [
    group('Sicilian Defense', 380, 5),
    group('Italian Game', 181, 7),
    group('Bongcloud Attack', 1, 999),
    group('English Opening', 166, 13),
    // Tied lineCount + tied popularity to pin the alphabetical tiebreaker.
    group('Aardvark Gambit', 50, 100),
    group('Zigzag System', 50, 100),
  ];

  it("popular: lower popularity rank wins; alphabetical tiebreak inside a tier", () => {
    const out = sortFamilies(groups, 'popular').map((g) => g.family);
    expect(out).toEqual([
      'Sicilian Defense', // popularity 5
      'Italian Game', // 7
      'English Opening', // 13
      'Aardvark Gambit', // 100, alphabetic tiebreaker
      'Zigzag System', // 100
      'Bongcloud Attack', // 999 (obscure → bottom)
    ]);
  });

  it("most-lines: descending count, alphabetical tiebreak", () => {
    const out = sortFamilies(groups, 'most-lines').map((g) => g.family);
    expect(out).toEqual([
      'Sicilian Defense', // 380
      'Italian Game', // 181
      'English Opening', // 166
      'Aardvark Gambit', // 50, alphabetic tiebreaker
      'Zigzag System', // 50
      'Bongcloud Attack', // 1
    ]);
  });

  it("fewest-lines: ascending count, alphabetical tiebreak", () => {
    const out = sortFamilies(groups, 'fewest-lines').map((g) => g.family);
    expect(out).toEqual([
      'Bongcloud Attack',
      'Aardvark Gambit',
      'Zigzag System',
      'English Opening',
      'Italian Game',
      'Sicilian Defense',
    ]);
  });

  it('alpha: pure A→Z regardless of count or popularity', () => {
    const out = sortFamilies(groups, 'alpha').map((g) => g.family);
    expect(out).toEqual([
      'Aardvark Gambit',
      'Bongcloud Attack',
      'English Opening',
      'Italian Game',
      'Sicilian Defense',
      'Zigzag System',
    ]);
  });

  it('does not mutate the input array', () => {
    const original = groups.slice();
    sortFamilies(groups, 'popular');
    expect(groups).toEqual(original);
  });

  it('handles an empty input', () => {
    expect(sortFamilies([], 'popular')).toEqual([]);
    expect(sortFamilies([], 'most-lines')).toEqual([]);
  });
});

describe('familyDescription', () => {
  // Smoke-tests against the live dataset so a future regression in
  // build-openings.mjs (e.g. forgetting to merge popularity.tsv) fails
  // here without us having to mock OPENING_FAMILIES.
  it('returns a non-empty blurb for the Sicilian Defense (chess.com top-5 family)', () => {
    const desc = familyDescription('Sicilian Defense');
    expect(desc.length).toBeGreaterThan(50);
    // Cheap content check: the blurb should mention what move signals
    // the opening (`c5`). If a future TSV rewrite accidentally drops
    // the move references the test still passes lengthwise but loses
    // its actual point — pin that with a substring.
    expect(desc).toContain('c5');
  });

  it('returns a non-empty blurb for the Italian Game', () => {
    const desc = familyDescription('Italian Game');
    expect(desc.length).toBeGreaterThan(50);
    expect(desc).toContain('Bc4');
  });

  it('returns the empty string for a family that does not exist', () => {
    expect(familyDescription('No Such Family')).toBe('');
  });
});

describe('isKnownOpeningFamily', () => {
  it('recognises families from the openings library', () => {
    expect(isKnownOpeningFamily('Italian Game')).toBe(true);
    expect(isKnownOpeningFamily('Sicilian Defense')).toBe(true);
  });

  it('rejects unknown / dashboard-only labels', () => {
    expect(isKnownOpeningFamily('Unknown')).toBe(false);
    expect(isKnownOpeningFamily('Not A Real Opening')).toBe(false);
  });
});

describe('line popularity snapshot', () => {
  it('emits finite offline popularity metadata for every generated line', () => {
    const lines = getVariations('Italian Game');
    expect(lines.length).toBeGreaterThan(5);
    expect(
      lines.every(
        (line) =>
          Number.isFinite(line.globalGames) &&
          line.globalGames >= 0 &&
          Number.isFinite(line.globalShare) &&
          line.globalShare >= 0 &&
          line.globalShare <= 1,
      ),
    ).toBe(true);
    expect(lines.some((line) => line.globalGames > 0)).toBe(true);
  });
});
