import { BAND_WIDTH, PUZZLE_SHARDS, RATING_MIN } from '@/data/puzzles.meta.generated';
import { PUZZLE_THEME_BAND_COUNTS } from '@/data/puzzleThemeCounts.generated';

/**
 * Lichess's 72 themes, grouped for the theme picker and the per-theme stats.
 *
 * The groups are product decisions, not Lichess's: Lichess files `short` and
 * `fork` side by side, but "short" describes a puzzle's length and "fork"
 * names a tactic, and only the second is something you can be weak at in
 * the sense the stats table means. Order within a group is roughly how often
 * the pattern decides real games, which is also roughly corpus frequency.
 *
 * Any theme not listed falls into `other`, so a Lichess vocabulary change
 * degrades to an extra chip at the bottom rather than a theme that can't be
 * picked. `themeCatalog.test.ts` fails if that happens, so it gets placed.
 */

export type ThemeGroup = 'tactics' | 'mates' | 'phases' | 'length' | 'other';

export const THEME_GROUP_ORDER: readonly ThemeGroup[] = [
  'tactics',
  'mates',
  'phases',
  'length',
  'other',
];

export const THEME_GROUPS: Readonly<Record<ThemeGroup, readonly string[]>> = {
  tactics: [
    'fork',
    'pin',
    'skewer',
    'discoveredAttack',
    'hangingPiece',
    'sacrifice',
    'deflection',
    'attraction',
    'trappedPiece',
    'capturingDefender',
    'doubleCheck',
    'discoveredCheck',
    'clearance',
    'interference',
    'intermezzo',
    'xRayAttack',
    'quietMove',
    'defensiveMove',
    'zugzwang',
    'exposedKing',
    'kingsideAttack',
    'queensideAttack',
    'attackingF2F7',
    'advancedPawn',
    'promotion',
    'underPromotion',
    'enPassant',
    'castling',
    'collinearMove',
  ],
  mates: [
    'mate',
    'mateIn1',
    'mateIn2',
    'mateIn3',
    'mateIn4',
    'mateIn5',
    'backRankMate',
    'smotheredMate',
    'hookMate',
    'arabianMate',
    'anastasiaMate',
    'bodenMate',
    'doubleBishopMate',
    'dovetailMate',
    'epauletteMate',
    'operaMate',
    'pillsburysMate',
    'morphysMate',
    'cornerMate',
    'killBoxMate',
    'triangleMate',
    'swallowstailMate',
    'vukovicMate',
    'blindSwineMate',
    'balestraMate',
  ],
  phases: [
    'opening',
    'middlegame',
    'endgame',
    'rookEndgame',
    'pawnEndgame',
    'bishopEndgame',
    'knightEndgame',
    'queenEndgame',
    'queenRookEndgame',
  ],
  length: ['oneMove', 'short', 'long', 'veryLong'],
  other: ['advantage', 'crushing', 'master', 'masterVsMaster', 'superGM'],
};

const GROUP_OF = new Map<string, ThemeGroup>(
  THEME_GROUP_ORDER.flatMap((g) => THEME_GROUPS[g].map((t) => [t, g] as const)),
);

export function themeGroup(theme: string): ThemeGroup {
  return GROUP_OF.get(theme) ?? 'other';
}

/** Groups whose themes are skills — the ones the stats table ranks. `other`
 *  holds descriptors ("crushing", "superGM") that say nothing about what
 *  you're good at. */
export function isSkillTheme(theme: string): boolean {
  return themeGroup(theme) !== 'other';
}

/** Puzzles per band across all themes, for the mixed case. From the shard
 *  manifest — summing the theme counts would over-count, since a puzzle
 *  carries several themes. */
const TOTAL_PER_BAND: number[] = (() => {
  const out: number[] = [];
  for (const s of PUZZLE_SHARDS) out[s.band] = (out[s.band] ?? 0) + s.rows;
  return Array.from(out, (n) => n ?? 0);
})();

/**
 * Puzzles of `theme` (or of any theme, for null) whose rating falls in
 * [lo, hi], estimated from the per-band index. Bands the window only
 * partly covers contribute pro rata — an estimate, which is all the picker
 * and `windowForTheme` need.
 */
export function themeCountInWindow(theme: string | null, lo: number, hi: number): number {
  const counts = theme ? PUZZLE_THEME_BAND_COUNTS[theme] : null;
  if (theme && !counts) return 0;
  let total = 0;
  const bands = counts?.length ?? TOTAL_PER_BAND.length;
  for (let b = 0; b < bands; b++) {
    const bLo = RATING_MIN + b * BAND_WIDTH;
    const bHi = bLo + BAND_WIDTH;
    const overlap = Math.min(hi + 1, bHi) - Math.max(lo, bLo);
    if (overlap <= 0) continue;
    total += ((counts ?? TOTAL_PER_BAND)[b] * overlap) / BAND_WIDTH;
  }
  return Math.round(total);
}

