import type { Motif } from '@/db/schema';
import { MOTIF_THEMES } from './motifThemes';
import type { MistakeRow } from './mistakes';
import type { GameLight } from '@/db/queries';

/**
 * Turns "which tactics do I actually keep botching, lately" into a puzzle
 * queue specification.
 *
 * Pure and time-injected (`now` is always a parameter, never `Date.now()`)
 * so the decay maths is directly testable.
 *
 * ── Why decay at all ───────────────────────────────────────────────────
 * A plain count of mistakes-per-motif is a lifetime average, and a lifetime
 * average is exactly wrong for training. If you spent March hanging pieces
 * and then fixed it, a lifetime count still ranks `hangingPiece` at the top
 * for months afterwards, and you get served drills for a hole you already
 * closed. So each mistake's contribution decays exponentially with age:
 *
 *      w(r) = 0.5 ^ (ageDays(r) / HALF_LIFE_DAYS)
 *
 * With a 30-day half-life, a mistake from ~4 months ago carries 2⁻⁴ ≈ 6% of
 * the weight of one from this week. Old holes fade out on their own, without
 * any explicit cutoff to tune, and a motif that's still live keeps being
 * refreshed by new evidence.
 *
 * ── Why severity too ───────────────────────────────────────────────────
 * Not all mistakes are equal evidence. A blunder that threw the game says
 * more about a blind spot than a 3-centipawn inaccuracy. `winrateDrop`
 * (0..1) is already computed per mistake, so it scales the weight:
 *
 *      sev(r) = SEV_FLOOR + clamp(winrateDrop, 0, 1)
 *
 * The floor keeps small errors contributing something (they're still
 * evidence, just weaker) rather than letting them vanish entirely.
 */

/** Mistakes lose half their weight every 30 days. Chosen so that "a month
 *  ago" is meaningfully discounted (50%) while "this week" dominates, and
 *  the 3-4 month horizon the decay implies matches how long a genuinely
 *  fixed weakness takes to stop showing up in fresh games. */
export const HALF_LIFE_DAYS = 30;

/** Minimum severity multiplier, for a mistake that cost ~nothing. */
export const SEV_FLOOR = 0.5;

/** Motifs below this share of total weight are dropped. Prevents a single
 *  stale mistake from a long-quiet motif claiming a slot in the queue. */
export const MIN_SHARE = 0.05;

/** How many motifs the Recommended queue draws from. Beyond ~5 the per-
 *  motif allocation gets so thin that the queue stops feeling targeted. */
export const MAX_MOTIFS = 5;

const DAY_MS = 86_400_000;

export interface MotifScore {
  motif: Motif;
  /** Recency- and severity-weighted evidence. Arbitrary units; only the
   *  ratios between motifs are meaningful. */
  score: number;
  /** `score` as a fraction of all scored motifs. Sums to ~1 across the
   *  returned list before filtering, and is what drives queue allocation. */
  share: number;
  /** Raw count of contributing mistakes, undecayed. For UI copy like
   *  "12 mistakes in the last 3 months" — never for ranking. */
  mistakeCount: number;
  /** Most recent contributing mistake, epoch ms. Lets the UI say "last
   *  seen 4 days ago", which is the honest justification for the ranking. */
  lastSeenAt: number;
}

/**
 * Score every motif present in the user's mistakes.
 *
 * Returns all motifs with any weight, descending by score — filtering to
 * the top-N and the share floor happens in `recommendationPlan`, so callers
 * that want the full picture (e.g. a weaknesses summary) can have it.
 *
 * `other` is excluded: it's the catch-all our detector assigns when it
 * can't name the pattern, so there's no theme to match it to and no drill
 * that would address it. Including it would let an unnameable blob outrank
 * real, actionable motifs.
 */
export function scoreMotifs(rows: readonly MistakeRow[], now: number): MotifScore[] {
  const acc = new Map<Motif, { score: number; count: number; lastSeenAt: number }>();

  for (const r of rows) {
    const ageDays = Math.max(0, (now - r.gameDate) / DAY_MS);
    const w = Math.pow(0.5, ageDays / HALF_LIFE_DAYS);
    const sev = SEV_FLOOR + Math.min(1, Math.max(0, r.winrateDrop));
    const contribution = w * sev;

    for (const motif of r.motifs) {
      if (motif === 'other') continue;
      // A motif with no themes can't be turned into puzzles, so scoring it
      // would produce a recommendation we can't fulfil.
      if ((MOTIF_THEMES[motif] ?? []).length === 0) continue;

      const e = acc.get(motif) ?? { score: 0, count: 0, lastSeenAt: 0 };
      e.score += contribution;
      e.count += 1;
      if (r.gameDate > e.lastSeenAt) e.lastSeenAt = r.gameDate;
      acc.set(motif, e);
    }
  }

  const total = [...acc.values()].reduce((a, e) => a + e.score, 0);
  return [...acc.entries()]
    .map(([motif, e]) => ({
      motif,
      score: e.score,
      share: total > 0 ? e.score / total : 0,
      mistakeCount: e.count,
      lastSeenAt: e.lastSeenAt,
    }))
    .sort((a, b) => b.score - a.score || (a.motif < b.motif ? -1 : 1));
}

export interface RecommendationPlan {
  /** Motifs to draw from, strongest first. Empty when there's not enough
   *  history — the caller should fall back to a difficulty tier. */
  motifs: MotifScore[];
  /** Lichess themes to match, unioned across `motifs`. */
  themes: string[];
  /** Inclusive puzzle-rating window to draw from. */
  ratingLo: number;
  ratingHi: number;
  /** Per-motif target counts for a queue of the requested length, summing
   *  to it. Allocation is proportional to `share`. */
  allocation: { motif: Motif; count: number }[];
}

/**
 * Difficulty window for the Recommended queue.
 *
 * ⚠ Lichess *puzzle* Glicko and Chess.com *game* Elo are different scales
 * measuring different things — one is "can you find the tactic in this
 * position", the other "do you win games against this pool". They correlate
 * but are not interchangeable, and no published mapping between them is
 * authoritative. Treating them as equal is a deliberate, calibrated guess:
 * it lands most users somewhere reasonable, and the width of the window
 * (±`RATING_WINDOW`) is doing more work than the centre.
 *
 * This is why the tier tabs exist alongside Recommended — a user who finds
 * the recommendations consistently too easy or too hard has a one-click
 * manual override, which is a better answer than us pretending to a
 * precision we don't have.
 */
export const RATING_WINDOW = 250;
export const DEFAULT_CENTER_RATING = 1400;

export function ratingWindowFor(userRating: number | undefined): {
  lo: number;
  hi: number;
} {
  const center = userRating && Number.isFinite(userRating)
    ? userRating
    : DEFAULT_CENTER_RATING;
  return { lo: center - RATING_WINDOW, hi: center + RATING_WINDOW };
}

/**
 * Estimate the user's playing strength for difficulty targeting: the median
 * `userRating` over their most recent `RATING_SAMPLE_GAMES` analyzed games.
 *
 * Median rather than mean so a single provisional or mis-recorded rating can't
 * drag the window, and recent-N rather than lifetime so it tracks current form
 * rather than where the user was a year ago.
 *
 * Returns undefined when no sampled game carries a rating, which makes
 * `ratingWindowFor` fall back to its documented default rather than centring
 * the window on 0.
 */
export const RATING_SAMPLE_GAMES = 20;

export function estimateUserRating(
  games: readonly Pick<GameLight, 'endTime' | 'userRating'>[],
): number | undefined {
  const ratings = games
    .slice()
    .sort((a, b) => b.endTime - a.endTime)
    .slice(0, RATING_SAMPLE_GAMES)
    .map((g) => g.userRating)
    .filter((r): r is number => typeof r === 'number' && Number.isFinite(r))
    .sort((a, b) => a - b);
  if (ratings.length === 0) return undefined;
  return ratings[Math.floor(ratings.length / 2)];
}

/**
 * Build the full queue specification.
 *
 * Allocation uses largest-remainder rounding so the counts sum to exactly
 * `queueLength`. Naive `Math.round(share * n)` per motif drifts — five
 * motifs at 0.17 each would round to 5 slots short of a 30-puzzle queue —
 * and a queue that quietly comes up short reads as a bug.
 */
export function recommendationPlan(args: {
  rows: readonly MistakeRow[];
  now: number;
  userRating: number | undefined;
  queueLength: number;
}): RecommendationPlan {
  const { rows, now, userRating, queueLength } = args;
  const { lo, hi } = ratingWindowFor(userRating);

  const all = scoreMotifs(rows, now);
  const motifs = all.filter((m) => m.share >= MIN_SHARE).slice(0, MAX_MOTIFS);

  if (motifs.length === 0) {
    return { motifs: [], themes: [], ratingLo: lo, ratingHi: hi, allocation: [] };
  }

  // Re-normalise shares across the surviving motifs so the allocation uses
  // the whole queue rather than leaving the filtered-out remainder empty.
  const kept = motifs.reduce((a, m) => a + m.score, 0);
  const exact = motifs.map((m) => ({
    motif: m.motif,
    want: kept > 0 ? (m.score / kept) * queueLength : 0,
  }));

  const allocation = exact.map((e) => ({ motif: e.motif, count: Math.floor(e.want) }));
  let remaining = queueLength - allocation.reduce((a, e) => a + e.count, 0);
  const byRemainder = exact
    .map((e, i) => ({ i, frac: e.want - Math.floor(e.want) }))
    .sort((a, b) => b.frac - a.frac);
  for (let k = 0; remaining > 0 && k < byRemainder.length; k++, remaining--) {
    allocation[byRemainder[k].i].count += 1;
  }
  // Any leftover (queueLength > motifs.length and every frac was 0) goes to
  // the strongest motif rather than being silently dropped.
  if (remaining > 0) allocation[0].count += remaining;

  const themes = [...new Set(motifs.flatMap((m) => MOTIF_THEMES[m.motif] ?? []))];

  return { motifs, themes, ratingLo: lo, ratingHi: hi, allocation };
}

/** Does a puzzle's theme list satisfy a motif? */
export function puzzleMatchesMotif(themes: readonly string[], motif: Motif): boolean {
  const want = MOTIF_THEMES[motif] ?? [];
  return themes.some((t) => want.includes(t));
}
