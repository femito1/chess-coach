import { describe, expect, it } from 'vitest';
import type { Motif } from '@/db/schema';
import { MOTIF_ORDER } from '@/engine/motifs';
import { PUZZLE_THEMES } from '@/data/puzzles.meta.generated';
import { MOTIF_THEMES, themesForMotifs } from './motifThemes';
import { formatThemeName } from './themeLabels';

describe('MOTIF_THEMES coverage', () => {
  it('maps every motif our detector can emit', () => {
    // Guards the other direction from the type system: `Record<Motif, ...>`
    // already forces a key per motif, but this catches a motif added to the
    // union and mapped to `[]` as a placeholder.
    for (const m of MOTIF_ORDER) {
      expect(MOTIF_THEMES[m], `motif ${m} missing from MOTIF_THEMES`).toBeDefined();
    }
  });

  it('gives every motif except `other` at least one theme', () => {
    const unmapped = MOTIF_ORDER.filter(
      (m) => m !== 'other' && MOTIF_THEMES[m].length === 0,
    );
    expect(
      unmapped,
      `these motifs would be silently un-drillable: ${unmapped.join(', ')}`,
    ).toEqual([]);
  });

  it('leaves `other` deliberately empty', () => {
    // Not an oversight — `other` is the catch-all for patterns the detector
    // can't name, so there is no honest theme to match. Matching it to
    // something would fill Recommended with noise. See motifThemes.ts.
    expect(MOTIF_THEMES.other).toEqual([]);
  });
});

describe('MOTIF_THEMES ↔ corpus vocabulary', () => {
  const vocabulary = new Set(PUZZLE_THEMES);

  it('references only themes that exist in the shipped corpus', () => {
    // This is the test that catches a Lichess vocabulary change on a corpus
    // refresh: a renamed or dropped theme would otherwise silently match
    // zero puzzles, and Recommended would quietly return an empty queue
    // instead of failing loudly.
    const missing: string[] = [];
    for (const [motif, themes] of Object.entries(MOTIF_THEMES)) {
      for (const th of themes) {
        if (!vocabulary.has(th)) missing.push(`${motif} → ${th}`);
      }
    }
    expect(
      missing,
      'themes absent from PUZZLE_THEMES (Lichess vocabulary changed? ' +
        'run `npm run puzzles:build` and re-check the mapping):\n' +
        missing.join('\n'),
    ).toEqual([]);
  });

  it('never maps to a descriptor theme', () => {
    // Descriptors describe a puzzle's shape or provenance, not its tactic.
    // Matching on them would serve near-random puzzles while claiming to
    // target a weakness.
    const descriptors = [
      'short',
      'long',
      'veryLong',
      'oneMove',
      'opening',
      'middlegame',
      'endgame',
      'master',
      'masterVsMaster',
      'superGM',
      'crushing',
      'advantage',
      'equality',
    ];
    const offenders: string[] = [];
    for (const [motif, themes] of Object.entries(MOTIF_THEMES)) {
      for (const th of themes) {
        if (descriptors.includes(th)) offenders.push(`${motif} → ${th}`);
      }
    }
    expect(offenders, `descriptor themes used for matching: ${offenders.join(', ')}`).toEqual(
      [],
    );
  });
});

describe('themesForMotifs', () => {
  it('unions and de-duplicates', () => {
    // fork and missedFork both map to `fork` — the union must collapse them.
    const themes = themesForMotifs(['fork', 'missedFork'] as Motif[]);
    expect(themes).toEqual(['fork']);
  });

  it('ignores motifs with no mapping', () => {
    expect(themesForMotifs(['other'] as Motif[])).toEqual([]);
    expect(themesForMotifs(['other', 'pin'] as Motif[])).toEqual(['pin']);
  });

  it('is empty for an empty input', () => {
    expect(themesForMotifs([])).toEqual([]);
  });
});

describe('formatThemeName', () => {
  it('de-camel-cases unknown themes rather than rendering blank', () => {
    expect(formatThemeName('backRankMate')).toBe('Back rank mate');
    expect(formatThemeName('discoveredAttack')).toBe('Discovered attack');
    // A theme Lichess might add tomorrow still reads sensibly.
    expect(formatThemeName('someBrandNewTheme')).toBe('Some brand new theme');
  });

  it('applies hand-corrections where de-camel-casing reads badly', () => {
    expect(formatThemeName('mateIn2')).toBe('Mate in 2');
    expect(formatThemeName('attackingF2F7')).toBe('Attacking f2/f7');
    expect(formatThemeName('xRayAttack')).toBe('X-ray attack');
    expect(formatThemeName('morphysMate')).toBe("Morphy's mate");
  });

  it('produces a non-empty label for every theme in the corpus', () => {
    for (const th of PUZZLE_THEMES) {
      const label = formatThemeName(th);
      expect(label.length, `empty label for ${th}`).toBeGreaterThan(0);
      expect(label[0], `label for ${th} not capitalised`).toBe(label[0].toUpperCase());
    }
  });
});
