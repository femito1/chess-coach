import { Chess } from 'chess.js';
import type { Color, Game } from '@/db/schema';
import type { OpeningLine } from './library';

export interface PersonalOpeningStats {
  relevantGames: number;
  prefixCounts: ReadonlyMap<string, number>;
}

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
  games: ReadonlyArray<Pick<Game, 'pgn' | 'userColor'>>,
  color: Color,
): PersonalOpeningStats {
  const prefixCounts = new Map<string, number>();
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
      for (let length = 1; length <= uci.length; length++) {
        const key = openingLineKey(uci.slice(0, length));
        prefixCounts.set(key, (prefixCounts.get(key) ?? 0) + 1);
      }
    } catch {
      // A malformed historical PGN should not break opening suggestions.
    }
  }

  return { relevantGames, prefixCounts };
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
