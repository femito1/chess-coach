import { Chess } from 'chess.js';
import { db, type Color } from '@/db/schema';
import {
  getVariations,
  identifyOpeningLine,
  replayLine,
  type OpeningLine,
} from '@/features/openings/library';
import { findNodeByFen } from '@/features/repertoire/store';
import type { GameForCharts } from './progress';

/**
 * Prep-gap detection: openings you lose in and have not prepped.
 *
 * Deliberately two stages, because the dashboard is PGN-free by design
 * (`DashboardPage` reads `listGamesLight()` so a live-query refire costs
 * ~50 KB rather than ~2 MB):
 *
 *   1. `rankGapCandidates` groups and ranks from the light projection
 *      alone — pure, no PGN, no database.
 *   2. `resolvePrepGaps` then reads PGNs for a few representative games
 *      per surviving candidate to decide whether it is really unprepped,
 *      and to name it.
 *
 * The division of labour between the two is the important part. A game's
 * `opening` string is unreliable for anything but grouping (see
 * `openingGroupKey`), so it is used for grouping *only*: every name and
 * link the UI shows comes from stage 2, which identifies the opening from
 * the moves actually played.
 */

/** The fields stage 1 needs. Satisfied by `GameLight` (no PGN). */
export type GameForGaps = Pick<
  GameForCharts,
  'id' | 'opening' | 'userColor' | 'result'
>;

export interface GapCandidate {
  /** Stable identity for React keys and dedup. */
  key: string;
  /** Which side you were. Repertoires are per-colour, so a gap is too. */
  color: Color;
  /** Normalised name the group was formed on — the games' own vocabulary,
   *  not the library's. Kept for the tooltip and for deciding how coarsely
   *  to check prep; never the display label. */
  groupName: string;
  /** Decided games only (`wins + draws + losses`). Games with an
   *  `'unknown'` result are excluded entirely rather than counted in the
   *  denominator — "lost 8 of 11" has to mean 11 finished games. */
  games: number;
  wins: number;
  draws: number;
  losses: number;
  /** Draws score half, matching `winRateByOpening`. */
  winRate: number;
  /** `losses + 0.5 * draws` — the points this opening costs you, which is
   *  also `games * (1 - winRate)`. Ranks by damage rather than by rate, so
   *  8-of-11 outranks 2-of-3. */
  pointsDropped: number;
  /** Representative games for stage 2 to resolve the line from. */
  sampleGameIds: string[];
}

export interface PrepGap extends GapCandidate {
  /** The library's canonical family, for the `/openings` link. */
  canonicalFamily: string;
  /** Display name, from the library rather than from the games. */
  label: string;
}

/**
 * Minimum decided games before an opening can be called a gap. Same value
 * and same reasoning as `MIN_GAMES_FOR_RECORD` in
 * `features/openings/recommendations.ts`: below this the sample is too
 * noisy to act on.
 */
export const MIN_GAMES_FOR_GAP = 4;

/**
 * Win-rate ceiling for a gap. 0.45 is the amber/red boundary the dashboard
 * already uses to colour opening rows, so "the bar was red" and "it is a
 * gap" agree.
 */
export const MAX_WIN_RATE_FOR_GAP = 0.45;

/** Candidates handed to stage 2. Small, because stage 2 reads PGNs. */
export const MAX_CANDIDATES = 8;

/** PGNs read per candidate. More than one because a single malformed or
 *  unusual game shouldn't decide a claim about your prep. */
export const SAMPLES_PER_CANDIDATE = 3;

/**
 * Group key for an opening name, and the reason this module never splits
 * one into family + variation.
 *
 * `Game.opening` comes from `parseOpeningFromEcoUrl`
 * (`src/import/importer.ts`), which inserts a colon at the first marker
 * word it recognises. Where that lands depends on whether Chess.com's slug
 * carried a trailing move sequence, so *the same opening* arrives spelled
 * two ways:
 *
 *   Caro-Kann-Defense-Advance-Variation-4.Nf3
 *     -> "Caro Kann Defense Advance Variation: 4.Nf3"
 *   Caro-Kann-Defense-Advance-Variation
 *     -> "Caro Kann Defense: Advance Variation"
 *
 * Splitting on the colon files those under two different families and
 * fragments the record that makes a gap visible at all. So drop the move
 * tail, neutralise the punctuation, and group on the whole remaining name:
 * both spellings above collapse onto "Caro Kann Defense Advance Variation".
 *
 * The result is variation-grained (Chess.com's names carry the variation)
 * but is *not* a library name — note the lost hyphen in "Caro Kann". It is
 * a grouping key, never a label.
 */
export function openingGroupKey(name: string | undefined): string {
  if (!name) return '';
  return name
    .trim()
    // A trailing move sequence, whichever punctuation introduced it. The
    // ECO-URL parser emits ": 4.Nf3"; a PGN `Opening` header can carry
    // ", 6.Be2".
    .replace(/\s*[:,]\s*\d.*$/, '')
    .replace(/[:,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Punctuation- and case-insensitive form, for comparing a games-derived
 *  name against a library one without fuzzy matching. Collapses the
 *  "Caro Kann" / "Caro-Kann" discrepancy. */
function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Keep the first `depth` comma-delimited segments of a variation label. */
export function truncateVariation(variation: string, depth: number): string {
  if (depth <= 0) return '';
  return variation.split(',').slice(0, depth).join(',').trim();
}

interface MutableCandidate {
  key: string;
  color: Color;
  groupName: string;
  wins: number;
  draws: number;
  losses: number;
  sampleGameIds: string[];
}

/**
 * Group decided games by (colour, opening name), keep the ones with a
 * losing record over a big enough sample, and rank by points dropped.
 *
 * Pure and synchronous so it can be memoised on the dashboard and tested
 * without a database.
 */
export function rankGapCandidates(
  games: ReadonlyArray<GameForGaps>,
  opts: {
    minGames?: number;
    maxWinRate?: number;
    limit?: number;
  } = {},
): GapCandidate[] {
  const minGames = opts.minGames ?? MIN_GAMES_FOR_GAP;
  const maxWinRate = opts.maxWinRate ?? MAX_WIN_RATE_FOR_GAP;
  const limit = opts.limit ?? MAX_CANDIDATES;

  const groups = new Map<string, MutableCandidate>();

  for (const game of games) {
    if (
      game.result !== 'win' &&
      game.result !== 'loss' &&
      game.result !== 'draw'
    ) {
      continue;
    }
    const groupName = openingGroupKey(game.opening);
    // No name to group on, and no way to resolve or link one. Nothing
    // actionable to say about it.
    if (groupName === '') continue;
    const key = `${game.userColor}|${groupName}`;

    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        color: game.userColor,
        groupName,
        wins: 0,
        draws: 0,
        losses: 0,
        sampleGameIds: [],
      };
      groups.set(key, group);
    }
    if (game.result === 'win') group.wins++;
    else if (game.result === 'draw') group.draws++;
    else group.losses++;
    // Sample lost games: one you lost certainly reached the opening, and
    // it is the game the claim is about.
    if (
      game.result === 'loss' &&
      group.sampleGameIds.length < SAMPLES_PER_CANDIDATE
    ) {
      group.sampleGameIds.push(game.id);
    }
  }

  const out: GapCandidate[] = [];
  for (const group of groups.values()) {
    const total = group.wins + group.draws + group.losses;
    if (total < minGames) continue;
    const winRate = (group.wins + 0.5 * group.draws) / total;
    if (winRate >= maxWinRate) continue;
    if (group.sampleGameIds.length === 0) continue;
    out.push({
      key: group.key,
      color: group.color,
      groupName: group.groupName,
      games: total,
      wins: group.wins,
      draws: group.draws,
      losses: group.losses,
      winRate,
      pointsDropped: group.losses + 0.5 * group.draws,
      sampleGameIds: group.sampleGameIds,
    });
  }

  out.sort(
    (a, b) =>
      b.pointsDropped - a.pointsDropped ||
      b.losses - a.losses ||
      b.games - a.games ||
      a.key.localeCompare(b.key),
  );

  return out.slice(0, Math.max(0, limit));
}

function uciFromPgn(pgn: string): string[] | null {
  try {
    const chess = new Chess();
    chess.loadPgn(pgn);
    const uci = chess
      .history({ verbose: true })
      .map((move) => move.from + move.to + (move.promotion ?? ''));
    return uci.length > 0 ? uci : null;
  } catch {
    // A malformed historical PGN shouldn't break the dashboard.
    return null;
  }
}

/**
 * The position whose presence in your prep decides the claim, plus the
 * label to make the claim under.
 *
 * The check is deliberately coarse, because the count beside it is coarse.
 * The library distinguishes "Advance Variation, Short Variation" from
 * "Advance Variation, Tal Variation", while the group counted every game
 * the site called an Advance. Checking one 7-ply sub-line would put "lost
 * 8 of 11" next to a label describing one of the eight, so the matched
 * variation is truncated to its first segment first — the row then asks
 * "do you have any Advance prep at all", which is what its number is
 * about.
 *
 * When the group's own name is just the family (Chess.com classified the
 * games no further), the question drops to the family itself. That
 * comparison is exact equality between punctuation-stripped names, not
 * fuzzy matching.
 *
 * Within the chosen level the *shallowest* line is the defining one: if
 * your prep covers the Advance four plies deep and the library's deepest
 * Advance line runs to twelve, checking the deep position would call
 * prepped prep a gap.
 */
function definingPosition(
  matched: OpeningLine,
  groupName: string,
): { fen: string; variation: string } | null {
  const siblings = getVariations(matched.family);
  const familyOnly = normalizeName(groupName) === normalizeName(matched.family);
  const wanted = familyOnly ? '' : truncateVariation(matched.variation, 1);
  const atLevel = siblings.filter((v) => v.variation === wanted);
  // Fall back to the matched line's own level when truncation lands on a
  // label the library doesn't carry as a row of its own (e.g. the library's
  // "Advance, Short Variation" truncated to "Advance").
  const candidates =
    atLevel.length > 0
      ? atLevel
      : siblings.filter((v) => v.variation === matched.variation);
  const defining: OpeningLine = candidates[0] ?? matched;
  const { fens } = replayLine(defining);
  if (fens.length <= 1) return null;
  return { fen: fens[fens.length - 1], variation: defining.variation };
}

async function resolveCandidate(
  candidate: GapCandidate,
  prepped: Map<string, boolean>,
): Promise<PrepGap | null> {
  let identity: { family: string; variation: string } | null = null;

  for (const id of candidate.sampleGameIds) {
    const game = await db.games.get(id);
    if (!game?.pgn) continue;
    const uci = uciFromPgn(game.pgn);
    if (!uci) continue;
    const matched = identifyOpeningLine(uci);
    if (!matched) continue;
    const defining = definingPosition(matched, candidate.groupName);
    if (!defining) continue;
    // A candidate's samples almost always resolve to the *same* defining
    // position — they were grouped by opening — and `findNodeByFen` scans
    // the repertoires for a colour on every call. Cache per pass so three
    // samples cost one lookup instead of three.
    const cacheKey = `${candidate.color}|${defining.fen}`;
    let inPrep = prepped.get(cacheKey);
    if (inPrep === undefined) {
      inPrep = (await findNodeByFen(defining.fen, candidate.color)) !== null;
      prepped.set(cacheKey, inPrep);
    }
    // One sample finding the position in your prep settles it. Claiming a
    // gap you don't have is the worse error of the two.
    if (inPrep) return null;
    identity ??= { family: matched.family, variation: defining.variation };
  }

  // Nothing resolvable — no library coverage, or every sample PGN was
  // unreadable. Stay quiet rather than assert an unverified gap.
  if (!identity) return null;

  return {
    ...candidate,
    canonicalFamily: identity.family,
    label: identity.variation
      ? `${identity.family}: ${identity.variation}`
      : identity.family,
  };
}

/**
 * Keep only the candidates whose defining position is absent from your
 * repertoires for that colour, naming each from the library. Reads at most
 * `MAX_CANDIDATES * SAMPLES_PER_CANDIDATE` PGNs.
 */
export async function resolvePrepGaps(
  candidates: ReadonlyArray<GapCandidate>,
): Promise<PrepGap[]> {
  // Shared across the whole pass, not per candidate: two candidates in the
  // same family often share a defining position.
  const prepped = new Map<string, boolean>();
  const out: PrepGap[] = [];
  for (const candidate of candidates) {
    const gap = await resolveCandidate(candidate, prepped);
    if (gap) out.push(gap);
  }
  return out;
}
