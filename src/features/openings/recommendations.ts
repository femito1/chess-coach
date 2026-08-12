import { Chess } from 'chess.js';
import type { Color, Game, GameResult } from '@/db/schema';
import type { OpeningLine } from './library';

/** Win/draw/loss tally from the user's own games, always from the user's
 *  perspective (`Game.result` is already stored that way — see
 *  `db/schema.ts` and `import/importer.ts`). */
export interface WinDrawLoss {
  wins: number;
  draws: number;
  losses: number;
}

export interface PersonalOpeningStats {
  relevantGames: number;
  prefixCounts: ReadonlyMap<string, number>;
  /** Per-prefix W/D/L, same keys as `prefixCounts`. A prefix's count is
   *  `wins + draws + losses` plus any games with an `'unknown'` result, so
   *  `prefixCounts` can exceed the W/D/L sum when results are missing. */
  prefixRecords: ReadonlyMap<string, WinDrawLoss>;
}

/** The user's record on a line, resolved by walking up to the deepest
 *  prefix they have actually reached often enough to be informative. */
export interface PersonalLineRecord extends WinDrawLoss {
  /** Games contributing (`wins + draws + losses`). */
  games: number;
  /** Ply depth of the prefix this record was measured at. Equals the
   *  line's own length when the exact line was played; shorter when the
   *  record was inherited from an ancestor variation. */
  depth: number;
  /** True when `depth < line.uci.length`, i.e. the record describes a
   *  broader variation the line belongs to rather than the line itself. */
  inherited: boolean;
}

/** Minimum games at a prefix before its record is trusted to inform a
 *  difficulty tier. Below this the sample is too noisy to move a line up
 *  or down a tier. One knob, named, so it is cheap to retune. */
export const MIN_GAMES_FOR_RECORD = 4;

export interface RankedOpeningLine {
  line: OpeningLine;
  score: number;
  globalScore: number;
  personalCount: number;
  personalShare: number;
}

export function openingLineKey(uci: readonly string[]): string {
  return uci.join(' ');
}

export function buildPersonalOpeningStats(
  // `result` is optional so callers with partial game shapes (and games
  // whose result was never recorded) still work; a missing result simply
  // contributes to prefixCounts but not to W/D/L.
  games: ReadonlyArray<Pick<Game, 'pgn' | 'userColor'> & { result?: GameResult }>,
  color: Color,
): PersonalOpeningStats {
  const prefixCounts = new Map<string, number>();
  const prefixRecords = new Map<string, WinDrawLoss>();
  let relevantGames = 0;

  for (const game of games) {
    if (game.userColor !== color) continue;
    try {
      const chess = new Chess();
      chess.loadPgn(game.pgn);
      const uci = chess.history({ verbose: true }).map(
        (move) => move.from + move.to + (move.promotion ?? ''),
      );
      if (uci.length === 0) continue;
      relevantGames++;
      // `result` is already stored from the user's perspective, so we can
      // fold it straight in without re-checking colour. `'unknown'`
      // contributes to prefixCounts (via the loop) but not to W/D/L.
      const outcome =
        game.result === 'win'
          ? 'wins'
          : game.result === 'loss'
            ? 'losses'
            : game.result === 'draw'
              ? 'draws'
              : null;
      for (let length = 1; length <= uci.length; length++) {
        const key = openingLineKey(uci.slice(0, length));
        prefixCounts.set(key, (prefixCounts.get(key) ?? 0) + 1);
        if (outcome) {
          const rec = prefixRecords.get(key);
          if (rec) rec[outcome]++;
          else {
            const fresh: WinDrawLoss = { wins: 0, draws: 0, losses: 0 };
            fresh[outcome] = 1;
            prefixRecords.set(key, fresh);
          }
        }
      }
    } catch {
      // A malformed historical PGN should not break opening suggestions.
    }
  }

  return { relevantGames, prefixCounts, prefixRecords };
}

/**
 * The user's record on a line, resolved by walking up its UCI prefixes
 * from the exact line toward the root and returning the FIRST (deepest)
 * prefix with at least `minGames` games. Returns null when no prefix
 * clears the bar — the common case for a library line the user has never
 * played, and the signal difficulty scoring uses to skip the familiarity
 * input rather than invent a record.
 *
 * Why deepest-first: a 16-ply sideline the user has never reached still
 * belongs to a variation they may know well; inheriting the Advance
 * Variation's record is a truer familiarity signal than "no data", while
 * still preferring the most specific evidence available.
 */
export function personalRecordForLine(
  stats: PersonalOpeningStats,
  uci: readonly string[],
  minGames = MIN_GAMES_FOR_RECORD,
): PersonalLineRecord | null {
  for (let depth = uci.length; depth >= 1; depth--) {
    const rec = stats.prefixRecords.get(openingLineKey(uci.slice(0, depth)));
    if (!rec) continue;
    const games = rec.wins + rec.draws + rec.losses;
    if (games < minGames) continue;
    return {
      ...rec,
      games,
      depth,
      inherited: depth < uci.length,
    };
  }
  return null;
}

function commonPrefixLength(a: readonly string[], b: readonly string[]): number {
  const max = Math.min(a.length, b.length);
  let common = 0;
  while (common < max && a[common] === b[common]) common++;
  return common;
}

function fallbackGlobalScore(line: OpeningLine, minPly: number, maxPly: number): number {
  if (maxPly <= minPly) return 1;
  return 1 - (line.uci.length - minPly) / (maxPly - minPly);
}

/**
 * Hybrid ranking:
 * - bundled Lichess reach is the prior;
 * - the player's own matching games gain up to 65% weight after 20 games;
 * - a greedy diversity penalty prevents a starter set of near-duplicates.
 */
export function rankOpeningLines(
  lines: readonly OpeningLine[],
  personal: PersonalOpeningStats,
): RankedOpeningLine[] {
  if (lines.length === 0) return [];
  const uniqueByMoves = new Map<string, OpeningLine>();
  for (const line of lines) {
    const key = openingLineKey(line.uci);
    const current = uniqueByMoves.get(key);
    if (!current || line.globalGames > current.globalGames) {
      uniqueByMoves.set(key, line);
    }
  }
  const uniqueLines = [...uniqueByMoves.values()];

  const logs = uniqueLines.map((line) => Math.log1p(line.globalGames));
  const maxLog = Math.max(...logs);
  const minPly = Math.min(...uniqueLines.map((line) => line.uci.length));
  const maxPly = Math.max(...uniqueLines.map((line) => line.uci.length));
  const personalWeight = Math.min(0.65, (personal.relevantGames / 20) * 0.65);

  const candidates = uniqueLines.map((line, index): RankedOpeningLine => {
    const reach = maxLog > 0
      ? logs[index] / maxLog
      : fallbackGlobalScore(line, minPly, maxPly);
    const globalScore = reach * 0.85 + Math.max(0, Math.min(1, line.globalShare)) * 0.15;
    const personalCount = personal.prefixCounts.get(openingLineKey(line.uci)) ?? 0;
    const personalShare = personal.relevantGames > 0
      ? personalCount / personal.relevantGames
      : 0;
    const score = globalScore * (1 - personalWeight) + personalShare * personalWeight;
    return { line, score, globalScore, personalCount, personalShare };
  });

  const remaining = [...candidates];
  const ranked: RankedOpeningLine[] = [];
  while (remaining.length > 0) {
    remaining.sort((a, b) => {
      const diversityPenalty = (candidate: RankedOpeningLine) => {
        if (ranked.length === 0) return 0;
        const closest = Math.max(
          ...ranked.map((chosen) => {
            const common = commonPrefixLength(candidate.line.uci, chosen.line.uci);
            return common / Math.max(1, Math.min(candidate.line.uci.length, chosen.line.uci.length));
          }),
        );
        return closest * 0.12;
      };
      const adjustedA = a.score - diversityPenalty(a);
      const adjustedB = b.score - diversityPenalty(b);
      return (
        adjustedB - adjustedA ||
        b.personalCount - a.personalCount ||
        b.line.globalGames - a.line.globalGames ||
        a.line.uci.length - b.line.uci.length ||
        a.line.name.localeCompare(b.line.name)
      );
    });
    ranked.push(remaining.shift()!);
  }

  return ranked;
}

export function recommendedStarterLines(
  lines: readonly OpeningLine[],
  personal: PersonalOpeningStats,
  limit = 5,
): RankedOpeningLine[] {
  return rankOpeningLines(lines, personal).slice(0, Math.max(0, limit));
}
