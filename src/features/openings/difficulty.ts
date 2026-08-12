import { isMeasuredLine } from '@/data/openings.generated';
import type { OpeningLine } from './library';
import {
  openingLineKey,
  personalRecordForLine,
  type PersonalLineRecord,
  type PersonalOpeningStats,
} from './recommendations';

/**
 * Easy / Medium / Hard tiers for opening lines, built to answer one
 * question for the drill page: *which lines can I just review, and which
 * do I actually need to sit down and learn?*
 *
 * Three measured inputs, combined into an absolute hardness score in
 * [0, 1], then cut into tiers **relative to each family's own
 * distribution** so "Hard" means hard *for this opening*, not hard in the
 * abstract (a 14-ply Caro-Kann mainline you've played 40 times should not
 * outrank an 8-ply sideline you've never seen).
 *
 *   - **depth**   — ply count. Deeper lines are more to remember.
 *   - **rarity**  — `globalShare`, the fraction of players who pick this
 *                   move at its branch point. A low share is a genuine
 *                   choice you must memorise; a high share is a near-forced
 *                   move that plays itself. This is only trustworthy
 *                   because the snapshot now measures every line at full
 *                   depth — the old 6-ply-plus-decay estimate made share a
 *                   function of depth, which would have double-counted it.
 *   - **familiarity** — your own record in this line (or the deepest
 *                   variation of it you've actually played). Modelled as a
 *                   *discount* on the depth+rarity base, not a blended
 *                   third input: having seen a line always makes it easier
 *                   to drill (you know the moves), and your win rate sets
 *                   how big the discount is. A never-played line pays the
 *                   full base; nothing can make an unplayed line *harder*
 *                   than the measured signals say.
 *
 * Weights are a judgement call — no measurement tells us the "right" mix —
 * so they live in one exported object and the tests pin *behaviour*
 * (exposure lowers a tier, rarity raises one, tiers are family-relative)
 * rather than the exact numbers.
 */
export type Tier = 'easy' | 'medium' | 'hard';

export const DIFFICULTY_WEIGHTS = {
  /** Blend weight for depth within the base score. */
  depth: 0.4,
  /** Blend weight for rarity within the base score. */
  rarity: 0.35,
  /** Maximum fractional discount a fully-comfortable record applies to
   *  the base score (i.e. a line seen ≥ EXPOSURE_REF_GAMES times and won
   *  every time is scored 25% easier than its measured base). */
  familiarity: 0.25,
} as const;

/** A line this many plies long (or longer) scores maximal on depth. */
export const DEPTH_REF_PLIES = 18;
/** Games at a prefix beyond which we treat you as fully familiar. */
export const EXPOSURE_REF_GAMES = 12;
/** `globalShare` at/above this reads as a near-forced move. */
export const FORCED_SHARE = 0.85;
/** `globalShare` at/below this reads as an offbeat, must-memorise choice. */
export const RARE_SHARE = 0.1;
/** Absolute score cuts, used only for families too small to form terciles. */
export const ABSOLUTE_TIER_THRESHOLDS = { easyMax: 0.4, hardMin: 0.67 } as const;
/** Below this many lines a family has no meaningful distribution, so we
 *  tier on absolute score rather than family terciles. */
export const MIN_LINES_FOR_TERCILES = 3;

export interface LineDifficulty {
  tier: Tier;
  /** Absolute hardness in [0, 1] before the tercile cut — exposed for
   *  tie-breaking and debugging, not shown to the user. */
  score: number;
  plies: number;
  /** 'forced' / 'rare' when `globalShare` is extreme, else null. Drives
   *  the explanatory chip beside the tier. */
  forcedness: 'forced' | 'rare' | null;
  /** Your record on this line or its deepest played variation, or null. */
  record: PersonalLineRecord | null;
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Whether a line's frequency is a real measurement vs a depth-decayed
 *  estimate. Injectable so tests don't depend on the bundle's current
 *  `MEASURED_PARENT_DEPTH` (which changes with each data refresh). */
export type IsMeasured = (line: Pick<OpeningLine, 'uci'>) => boolean;

/** Absolute hardness of a single line, family-independent. Higher =
 *  harder. Pure over `(line, stats)`. */
export function scoreLine(
  line: OpeningLine,
  stats: PersonalOpeningStats,
  isMeasured: IsMeasured = isMeasuredLine,
): LineDifficulty {
  const plies = line.uci.length;
  const depthScore = clamp01(plies / DEPTH_REF_PLIES);

  // Rarity: rarer (lower share) is harder — but ONLY when the share is a
  // real measurement. Beyond the snapshot's measured depth, `globalShare`
  // is the nearest measured ancestor decayed by 0.82 per ply, so it falls
  // monotonically with length. Feeding that in as "rarity" would count
  // depth twice and quietly rebuild the ply-sorted ordering this tiering
  // exists to replace. For an estimated line we drop the term and score on
  // what we actually know, rather than inventing a rarity for it.
  const measured = isMeasured(line);
  const share = clamp01(line.globalShare);
  const rarityScore = 1 - share;

  // Base hardness from the signals we trust for this line, weights
  // renormalized so the base spans [0, 1] either way.
  const w = measured
    ? DIFFICULTY_WEIGHTS.depth + DIFFICULTY_WEIGHTS.rarity
    : DIFFICULTY_WEIGHTS.depth;
  const base = measured
    ? (DIFFICULTY_WEIGHTS.depth / w) * depthScore +
      (DIFFICULTY_WEIGHTS.rarity / w) * rarityScore
    : depthScore;

  // Familiarity discount: comfort rewards exposure, scaled by how you
  // actually score in the line (winning is more comforting than losing,
  // but even a losing-but-familiar line is easier to *drill* than one
  // you've never seen). No record → no discount.
  const record = personalRecordForLine(stats, line.uci);
  let score = base;
  if (record) {
    const exposure = clamp01(record.games / EXPOSURE_REF_GAMES);
    const performance = (record.wins + 0.5 * record.draws) / record.games;
    const comfort = exposure * (0.5 + 0.5 * performance); // [0, 1]
    score = base * (1 - DIFFICULTY_WEIGHTS.familiarity * comfort);
  }

  // Only label forcedness from a measured share — an estimated one says
  // nothing about how forced the move is.
  const forcedness: LineDifficulty['forcedness'] = !measured
    ? null
    : share >= FORCED_SHARE
      ? 'forced'
      : share <= RARE_SHARE
        ? 'rare'
        : null;

  return { tier: 'medium', score, plies, forcedness, record };
}

/**
 * Tier every line in a family, keyed by `openingLineKey(line.uci)`.
 *
 * With at least `MIN_LINES_FOR_TERCILES` lines, tiers are cut by terciles
 * of the family's own score distribution (lowest third Easy, top third
 * Hard) — this is what makes a tier mean "hard for this family". Smaller
 * families have no distribution to speak of, so they fall back to fixed
 * absolute-score thresholds rather than emitting a degenerate all-same or
 * all-different split.
 */
export function tiersForFamily(
  lines: readonly OpeningLine[],
  stats: PersonalOpeningStats,
  isMeasured: IsMeasured = isMeasuredLine,
): Map<string, LineDifficulty> {
  const scored = lines.map((line) => ({
    key: openingLineKey(line.uci),
    diff: scoreLine(line, stats, isMeasured),
  }));

  const result = new Map<string, LineDifficulty>();

  if (scored.length < MIN_LINES_FOR_TERCILES) {
    for (const { key, diff } of scored) {
      const tier: Tier =
        diff.score <= ABSOLUTE_TIER_THRESHOLDS.easyMax
          ? 'easy'
          : diff.score >= ABSOLUTE_TIER_THRESHOLDS.hardMin
            ? 'hard'
            : 'medium';
      result.set(key, { ...diff, tier });
    }
    return result;
  }

  // Rank by score (stable on key so equal scores tier consistently), then
  // split by rank position into three equal-count bands.
  const order = [...scored].sort(
    (a, b) => a.diff.score - b.diff.score || (a.key < b.key ? -1 : 1),
  );
  const n = order.length;
  order.forEach((entry, rank) => {
    const tier: Tier =
      rank < n / 3 ? 'easy' : rank < (2 * n) / 3 ? 'medium' : 'hard';
    result.set(entry.key, { ...entry.diff, tier });
  });
  return result;
}
