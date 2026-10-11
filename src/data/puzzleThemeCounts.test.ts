import { describe, expect, it } from 'vitest';
import { PUZZLE_BUILD_ID, PUZZLE_SHARDS, PUZZLE_THEMES } from './puzzles.meta.generated';
import {
  PUZZLE_THEME_BAND_COUNTS,
  THEME_COUNTS_BUILD_ID,
} from './puzzleThemeCounts.generated';

/**
 * Coherence guard for the per-band theme index. It is derived from the
 * puzzle shards, so a corpus rebuild that forgets to regenerate it would
 * leave `windowForTheme` sizing windows from the old corpus.
 */
const REBUILD = 'run `node scripts/build-puzzle-theme-index.mjs` and commit the result';

describe('puzzle theme counts', () => {
  it('was built from the shipped corpus', () => {
    expect(THEME_COUNTS_BUILD_ID, `theme index is stale — ${REBUILD}`).toBe(PUZZLE_BUILD_ID);
  });

  it('has a full band array for every theme', () => {
    const bands = Math.max(...PUZZLE_SHARDS.map((s) => s.band)) + 1;
    for (const theme of PUZZLE_THEMES) {
      const counts = PUZZLE_THEME_BAND_COUNTS[theme];
      expect(counts, `no counts for theme "${theme}" — ${REBUILD}`).toBeDefined();
      expect(counts.length, `wrong band count for "${theme}" — ${REBUILD}`).toBe(bands);
    }
  });
});
