import { describe, expect, it } from 'vitest';
import {
  BAND_WIDTH,
  PUZZLE_THEMES,
  PUZZLE_TOTAL,
  RATING_MAX,
  RATING_MIN,
} from '@/data/puzzles.meta.generated';
import { PUZZLE_THEME_BAND_COUNTS } from '@/data/puzzleThemeCounts.generated';
import {
  THEME_GROUPS,
  THEME_GROUP_ORDER,
  isSkillTheme,
  themeCountInWindow,
  themeGroup,
} from './themeCatalog';

describe('theme groups', () => {
  const listed = THEME_GROUP_ORDER.flatMap((g) => THEME_GROUPS[g]);

  it('places every corpus theme in exactly one group', () => {
    // An unlisted theme silently lands in `other` — still pickable, but
    // never ranked as a skill. Fail here so a corpus refresh that adds a
    // Lichess theme gets it placed on purpose.
    for (const theme of PUZZLE_THEMES) {
      const groups = THEME_GROUP_ORDER.filter((g) => THEME_GROUPS[g].includes(theme));
      expect(
        groups,
        `theme "${theme}" must be listed in exactly one THEME_GROUPS group`,
      ).toHaveLength(1);
    }
  });

  it('lists no theme the corpus lacks', () => {
    const known = new Set(PUZZLE_THEMES);
    for (const theme of listed) {
      expect(known.has(theme), `THEME_GROUPS lists unknown theme "${theme}"`).toBe(true);
    }
  });

  it('treats only `other` as non-skill', () => {
    expect(themeGroup('fork')).toBe('tactics');
    expect(isSkillTheme('fork')).toBe(true);
    expect(isSkillTheme('crushing')).toBe(false);
    expect(themeGroup('notATheme')).toBe('other');
    expect(isSkillTheme('notATheme')).toBe(false);
  });
});

describe('themeCountInWindow', () => {
  it('counts the whole corpus for mixed over the full range', () => {
    expect(themeCountInWindow(null, RATING_MIN, RATING_MAX)).toBe(PUZZLE_TOTAL);
  });

  it('counts a theme over the full range as the sum of its bands', () => {
    for (const theme of ['fork', 'smotheredMate', 'endgame']) {
      const sum = PUZZLE_THEME_BAND_COUNTS[theme].reduce((a, n) => a + n, 0);
      expect(themeCountInWindow(theme, RATING_MIN, RATING_MAX), theme).toBe(sum);
    }
  });

  it('pro-rates a window that covers half a band', () => {
    const band = 11;
    const lo = RATING_MIN + band * BAND_WIDTH;
    const full = PUZZLE_THEME_BAND_COUNTS.fork[band];
    // [lo, lo+49] is 50 ratings of a 100-wide band.
    expect(themeCountInWindow('fork', lo, lo + BAND_WIDTH / 2 - 1)).toBe(Math.round(full / 2));
    // And the full band, inclusive bounds, is exactly the band.
    expect(themeCountInWindow('fork', lo, lo + BAND_WIDTH - 1)).toBe(full);
  });

  it('is 0 for an unknown theme or a window outside the corpus', () => {
    expect(themeCountInWindow('notATheme', RATING_MIN, RATING_MAX)).toBe(0);
    expect(themeCountInWindow(null, RATING_MAX + 100, RATING_MAX + 500)).toBe(0);
  });
});
