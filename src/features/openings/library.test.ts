import { describe, expect, it } from 'vitest';
import { OPENING_LINES } from '@/data/openings.generated';
import { openingFamily } from '@/features/dashboard/progress';
import { parseOpeningFromEcoUrl } from '@/import/importer';
import {
  familyDescription,
  getFamilies,
  getVariations,
  isFamilySort,
  isKnownOpeningFamily,
  resolveOpeningFamily,
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

  /**
   * Regression: the dashboard's win-rate list derives its family from
   * `Game.opening`, which for Chess.com imports comes out of an ECO-URL
   * slug (`Caro-Kann-Defense-Advance-Variation`) with every hyphen
   * turned into a space. The library's names come from Lichess and keep
   * the real punctuation + diacritics. An exact-equality check hid the
   * "Open" link for Caro-Kann, Réti, King's Gambit, and ~20 others.
   */
  it('tolerates chess.com ECO-URL spellings of library families', () => {
    for (const name of [
      'Caro Kann Defense',
      'Reti Opening',
      'Kings Gambit',
      "Queen's Gambit",
      'Grunfeld Defense',
      'Nimzo Indian Defense',
      'Semi Slav Defense',
      'Bishops Opening',
      'Kadas Opening',
      // Apostrophe arrives as a hyphen → "Van t Kruijs", so the fold
      // has to match across a word boundary the original lacks.
      'Van t Kruijs Opening',
    ]) {
      expect(isKnownOpeningFamily(name)).toBe(true);
    }
  });
});

describe('resolveOpeningFamily', () => {
  it('returns the canonical library spelling, not the input', () => {
    expect(resolveOpeningFamily('Caro Kann Defense')).toBe('Caro-Kann Defense');
    expect(resolveOpeningFamily('Reti Opening')).toBe('Réti Opening');
    expect(resolveOpeningFamily('Kings Gambit')).toBe("King's Gambit");
    expect(resolveOpeningFamily('Grunfeld Defense')).toBe('Grünfeld Defense');
  });

  it('is idempotent on already-canonical names', () => {
    for (const f of getFamilies('alpha')) {
      expect(resolveOpeningFamily(f.family)).toBe(f.family);
    }
  });

  it('returns null for names the library has no family for', () => {
    expect(resolveOpeningFamily('Unknown')).toBeNull();
    expect(resolveOpeningFamily('Not A Real Opening')).toBeNull();
    expect(resolveOpeningFamily('')).toBeNull();
    expect(resolveOpeningFamily('   ')).toBeNull();
  });

  /**
   * `openingFamily()` splits the stored name on the first colon, but the
   * importer only inserts one at the first `Variation|Defense|Attack|
   * Gambit|System|Opening` token — so slugs whose tail *is* one of those
   * words arrive un-split as a single blob. "Vienna Game Falkbeer
   * Variation", "Italian Game Giuoco Piano" and "Ruy Lopez Berlin
   * Defense" all rendered no link before the prefix fallback landed.
   */
  it('falls back to the longest library family prefixing the input', () => {
    expect(resolveOpeningFamily('Vienna Game Falkbeer Variation')).toBe(
      'Vienna Game',
    );
    expect(resolveOpeningFamily('Italian Game Giuoco Piano')).toBe(
      'Italian Game',
    );
    expect(resolveOpeningFamily('Ruy Lopez Berlin Defense')).toBe('Ruy Lopez');
    expect(resolveOpeningFamily('Caro Kann Defense Classical Variation')).toBe(
      'Caro-Kann Defense',
    );
  });

  /**
   * Whole-dataset safety net for the prefix fallback. Simulating the
   * chess.com round trip for all ~3700 library lines, a resolved family
   * must be either the line's own family or an *ancestor* of it (the
   * "Caro-Kann Defense: Advance Variation" → "Caro-Kann Defense"
   * collapse). What must never happen is landing on an unrelated
   * opening — that's the failure mode a pure string-prefix match could
   * plausibly introduce, so pin it here rather than trusting a handful
   * of hand-picked examples.
   */
  it('never resolves a line onto an unrelated family', () => {
    const fold = (s: string) =>
      s
        .normalize('NFD')
        .replace(/\p{Diacritic}/gu, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/gu, '');
    const unrelated: string[] = [];
    for (const line of OPENING_LINES) {
      // Rebuild the chess.com slug for this line, then push it through
      // the real import → dashboard → resolve path.
      const slug = line.name
        .normalize('NFD')
        .replace(/\p{Diacritic}/gu, '')
        .replace(/['’]/g, '')
        .replace(/[:,]/g, ' ')
        .trim()
        .replace(/\s+/g, '-');
      const chartFamily = openingFamily(
        parseOpeningFromEcoUrl(`https://www.chess.com/openings/${slug}`),
      );
      const got = resolveOpeningFamily(chartFamily);
      if (got === null) continue;
      if (got === line.family) continue;
      if (fold(line.family).startsWith(fold(got))) continue; // ancestor
      unrelated.push(`${line.name}: got ${got}, true ${line.family}`);
    }
    expect(unrelated).toEqual([]);
  });

  /**
   * The prefix fallback must prefer the most specific family. Several
   * library families are prefixes of others ("Queen's Gambit" ⊂
   * "Queen's Gambit Declined"), and picking the short one would file a
   * QGD game under plain QG.
   */
  it('prefers the most specific family when several match', () => {
    expect(
      resolveOpeningFamily('Queens Gambit Declined Exchange Variation'),
    ).toBe("Queen's Gambit Declined");
    expect(resolveOpeningFamily('Queens Gambit Accepted Classical')).toBe(
      "Queen's Gambit Accepted",
    );
    expect(resolveOpeningFamily('Kings Gambit Accepted Kieseritzky')).toBe(
      "King's Gambit Accepted",
    );
    // Bare name still resolves to the bare family, not a longer child.
    expect(resolveOpeningFamily('Queens Gambit')).toBe("Queen's Gambit");
  });

  /**
   * The reverse direction: chess.com names an opening plainly but the
   * library has no bare family for it, only a qualified one. "Vienna
   * Gambit" is the live case — 15 real library lines, all filed under
   * "Vienna Gambit, with Max Lange Defense" — so an input-extends-library
   * match is needed or the row gets no link despite the lines existing.
   */
  it('adopts a qualified family when the library has no bare one', () => {
    expect(resolveOpeningFamily('Vienna Gambit')).toBe(
      'Vienna Gambit, with Max Lange Defense',
    );
    // Must not hijack an opening that *does* have a bare family: Vienna
    // Game is its own family and stays put.
    expect(resolveOpeningFamily('Vienna Game')).toBe('Vienna Game');
  });

  /**
   * Every real family must resolve to itself. The prefix stages make it
   * possible for a family to get pulled onto a sibling, which would
   * silently rewrite correct data — so assert the identity across the
   * whole dataset rather than spot-checking.
   */
  it('resolves every library family to itself', () => {
    const broken = getFamilies('alpha')
      .map((f) => ({ family: f.family, got: resolveOpeningFamily(f.family) }))
      .filter((r) => r.got !== r.family);
    expect(broken).toEqual([]);
  });

  /**
   * The fuzzy fold is only safe while it stays injective over the real
   * dataset. If a future `build-openings.mjs` refresh adds a family that
   * folds onto an existing one (say a bare "Kings Gambit" alongside
   * "King's Gambit"), deep links would silently route to the wrong
   * opening — so fail the build here instead.
   */
  it('folds every library family to a distinct key', () => {
    const families = getFamilies('alpha');
    const canonical = families.map((f) => resolveOpeningFamily(f.family));
    expect(new Set(canonical).size).toBe(families.length);
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
