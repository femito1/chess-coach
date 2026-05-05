import { Chess } from 'chess.js';
import { analysisPool } from './pool';
import { cachedAnalyze, cacheStats, isBookFen } from './cache';
import { classifyMove, cpToWinrate, mateToCp, moveAccuracy } from './classify';
import { detectMotifs } from './motifs';
import {
  baseSecondsFromTimeControl,
  deriveTimeSpent,
  detectPhase,
  extractClocks,
} from './phase';
import type { Analysis, MoveEval } from '@/db/schema';

export interface AnalyzeProgress {
  ply: number;
  totalPlies: number;
}

/**
 * Analyze every move of a PGN and return per-move evaluations.
 * Evaluations are stored from White's perspective (positive = White better).
 */
export async function analyzeGamePgn(
  gameId: string,
  pgn: string,
  depth: number,
  onProgress?: (p: AnalyzeProgress) => void,
  signal?: { aborted: boolean },
  opts?: { hasOpening?: boolean; timeControl?: string },
): Promise<Analysis> {
  const hasOpening = opts?.hasOpening ?? false;
  const chess = new Chess();
  chess.loadPgn(pgn);
  const history = chess.history({ verbose: true });

  // Re-play to get the list of FENs before each move.
  const replay = new Chess();
  const fensBefore: string[] = [];
  for (let i = 0; i < history.length; i++) {
    fensBefore.push(replay.fen());
    replay.move(history[i].san);
  }
  const finalFen = replay.fen();

  // Clock extraction (per-ply remaining seconds + derived time-spent).
  const clocksAfter = extractClocks(pgn);
  const base = baseSecondsFromTimeControl(opts?.timeControl);
  const timeSpentPerPly = deriveTimeSpent(clocksAfter, base);

  const pool = analysisPool();
  await pool.newGame();

  // -- Book detection --
  // A move is "fully in book" iff both its before and after positions
  // appear in the openings library. Such moves are classified `book`
  // regardless of engine eval, so we skip the Stockfish call entirely.
  // We still enqueue engine work for the boundary positions (in-book
  // FEN that immediately precedes an out-of-book move) because we need
  // those evals to score the move that leaves prep.
  //
  // Concretely we mark `bookMoveIdx[i] = true` iff move i is fully in
  // book, then a FEN needs an engine eval iff any move that uses it
  // (either as fenBefore or as fenAfter) is *not* fully in book.
  const fenBookFlag: boolean[] = fensBefore.map((f) => isBookFen(f));
  const finalBook = isBookFen(finalFen);
  const bookMoveIdx: boolean[] = new Array(history.length);
  for (let i = 0; i < history.length; i++) {
    const beforeBook = fenBookFlag[i];
    const afterBook = i + 1 < history.length ? fenBookFlag[i + 1] : finalBook;
    bookMoveIdx[i] = beforeBook && afterBook;
  }

  // Set of FENs that genuinely need an engine eval. We start by
  // assuming none, then mark any FEN used by a non-book move.
  const needEval = new Set<string>();
  for (let i = 0; i < history.length; i++) {
    if (bookMoveIdx[i]) continue;
    needEval.add(fensBefore[i]);
    const after = i + 1 < history.length ? fensBefore[i + 1] : finalFen;
    needEval.add(after);
  }
  // The very final position contributes only to the last move's eval —
  // it's already covered by the loop above when the last move is
  // non-book; we leave it out otherwise.

  // Progress: count tasks that actually run engine work. Book-only
  // games would otherwise look stuck at 0% even though they're
  // finishing instantly.
  const totalTasks = needEval.size;
  let tasksDone = 0;
  const evalByFen = new Map<string, Promise<import('./engine').AnalysisResult>>();
  const enqueue = (fen: string) => {
    if (evalByFen.has(fen)) return;
    const p = cachedAnalyze(fen, depth);
    p.then(() => {
      tasksDone++;
      if (totalTasks > 0) {
        onProgress?.({
          ply: Math.min(
            history.length,
            Math.round((tasksDone / totalTasks) * history.length),
          ),
          totalPlies: history.length,
        });
      }
    }).catch(() => {});
    evalByFen.set(fen, p);
  };
  for (const f of needEval) enqueue(f);
  // Edge case: 100% book game. Report progress so the queue UI doesn't
  // sit at 0% forever before we synthesize moves below.
  if (totalTasks === 0 && history.length > 0) {
    onProgress?.({ ply: history.length, totalPlies: history.length });
  }
  // Reference `pool` so that the var is recognized as used even when
  // every call goes through `cachedAnalyze` (which dispatches via the
  // pool internally). Keeps the explicit `await pool.newGame()` above
  // visible without a lint complaint.
  void pool;

  const moves: MoveEval[] = [];
  for (let i = 0; i < history.length; i++) {
    if (signal?.aborted) throw new Error('aborted');

    const move = history[i];
    const fenBefore = fensBefore[i];
    const fenAfter = i + 1 < history.length ? fensBefore[i + 1] : finalFen;
    const sideToMove: 'w' | 'b' = fenBefore.split(' ')[1] as 'w' | 'b';
    const playedUci = move.from + move.to + (move.promotion ?? '');
    const phase = detectPhase(fenBefore);

    // -- Fully-in-book fast path --
    // Both endpoints are in the openings library, so the move is
    // canonical theory. Synthesize a minimal MoveEval with eval = 0
    // and skip the engine call. The classifier never overrides `book`
    // for in-book plies, and the eval graph treats opening flat-zero
    // as expected (matches chess.com's review behaviour).
    if (bookMoveIdx[i]) {
      cacheStats.bookSkips++;
      moves.push({
        ply: i + 1,
        san: move.san,
        uci: playedUci,
        fenBefore,
        fenAfter,
        evalCpBefore: 0,
        evalCpAfter: 0,
        winrateBefore: 0.5,
        winrateAfter: 0.5,
        classification: 'book',
        depth,
        phase,
        clockAfter: clocksAfter[i],
        timeSpent: timeSpentPerPly[i],
      });
      continue;
    }

    const [beforeRes, afterRes] = await Promise.all([
      evalByFen.get(fenBefore)!,
      evalByFen.get(fenAfter)!,
    ]);

    // Convert engine scores (always from side-to-move) into White-POV centipawns.
    const beforeCpStm =
      beforeRes.scoreMate != null
        ? mateToCp(beforeRes.scoreMate)
        : (beforeRes.scoreCp ?? 0);
    const afterCpStm =
      afterRes.scoreMate != null
        ? mateToCp(afterRes.scoreMate)
        : (afterRes.scoreCp ?? 0);
    const beforeCpWhite = sideToMove === 'w' ? beforeCpStm : -beforeCpStm;
    // After the move, side-to-move flips; afterCpStm is for the *opponent*, so negate twice -> same formula.
    const afterCpWhite = sideToMove === 'w' ? -afterCpStm : afterCpStm;

    // Winrate from the mover's perspective.
    const moverBeforeWinrate = cpToWinrate(sideToMove === 'w' ? beforeCpWhite : -beforeCpWhite);
    const moverAfterWinrate = cpToWinrate(sideToMove === 'w' ? afterCpWhite : -afterCpWhite);

    const bestUci = beforeRes.bestMoveUci ?? '';
    const isBest = bestUci === playedUci;

    const prevMoveToSquare = i > 0 ? history[i - 1].to : undefined;

    const classification = classifyMove({
      moverWinrateBefore: moverBeforeWinrate,
      moverWinrateAfter: moverAfterWinrate,
      isBest,
      ply: i + 1,
      inBookPhase: hasOpening,
      fenBefore,
      fenAfter,
      playedUci,
      prevMoveToSquare,
    });

    // Compute SAN of best move by playing it on a throwaway board.
    let bestMoveSan: string | undefined;
    if (beforeRes.bestMoveUci) {
      try {
        const scratch = new Chess(fenBefore);
        const bm = scratch.move({
          from: beforeRes.bestMoveUci.slice(0, 2),
          to: beforeRes.bestMoveUci.slice(2, 4),
          promotion: beforeRes.bestMoveUci.slice(4, 5) || undefined,
        });
        bestMoveSan = bm.san;
      } catch {
        bestMoveSan = undefined;
      }
    }

    // Motifs: only tag if the move is noticeably below best, otherwise it's
    // expensive busy-work and pollutes the aggregate stats.
    const shouldTagMotifs =
      classification === 'blunder' ||
      classification === 'mistake' ||
      classification === 'miss' ||
      classification === 'inaccuracy';
    const motifs = shouldTagMotifs
      ? detectMotifs({
          fenBefore,
          fenAfter,
          playedUci,
          bestUci: beforeRes.bestMoveUci ?? undefined,
          bestPvUci: beforeRes.pv,
          winrateBefore: moverBeforeWinrate,
          winrateAfter: moverAfterWinrate,
          mateInBefore: beforeRes.scoreMate ?? undefined,
          mateInAfter: afterRes.scoreMate ?? undefined,
        })
      : undefined;

    moves.push({
      ply: i + 1,
      san: move.san,
      uci: playedUci,
      fenBefore,
      fenAfter,
      evalCpBefore: beforeCpWhite,
      evalCpAfter: afterCpWhite,
      winrateBefore: moverBeforeWinrate,
      winrateAfter: moverAfterWinrate,
      bestMoveUci: beforeRes.bestMoveUci ?? undefined,
      bestMoveSan,
      bestPvUci: beforeRes.pv && beforeRes.pv.length > 0 ? beforeRes.pv.slice(0, 10) : undefined,
      bestEvalCp: beforeCpWhite,
      mateInBefore: beforeRes.scoreMate ?? undefined,
      mateInAfter: afterRes.scoreMate ?? undefined,
      classification,
      depth: beforeRes.depth,
      phase,
      clockAfter: clocksAfter[i],
      timeSpent: timeSpentPerPly[i],
      motifs,
    });
  }

  return {
    gameId,
    depth,
    analyzedAt: Date.now(),
    engine: 'stockfish-16',
    moves,
  };
}

/**
 * Harmonic mean — naturally pulled toward low values, so single bad moves
 * count more than single good ones. We floor each value at `floor` (default
 * 20) so a "move-acc = 0" outlier doesn't crater an otherwise decent game.
 */
function harmonicMean(xs: number[], floor = 20): number {
  if (xs.length === 0) return 100;
  let recip = 0;
  for (const x of xs) {
    const v = Math.max(floor, x);
    recip += 1 / v;
  }
  return xs.length / recip;
}

/**
 * Compute per-color accuracy from the move list.
 *
 * Approach:
 *  1) Per-move accuracy comes from the Lichess logistic formula applied to
 *     the player's winrate loss.
 *  2) The game accuracy for each color is the **harmonic mean** of their
 *     per-move accuracies (flooring each at 20 to avoid one disaster
 *     completely flattening the aggregate).
 *
 * Rationale: the earlier version blended a std-dev-weighted mean with the
 * harmonic mean, which in quiet games (lots of ~0% winrate-loss moves) pulled
 * every number up toward 95+. The harmonic mean alone tracks real move
 * quality much more faithfully: good games still score high, but a game with
 * two or three real mistakes drops meaningfully (-5 to -15 pts), which is
 * the signal you actually want for improvement.
 *
 * We no longer try to mimic Chess.com's unpublished formula. The aim is an
 * *informative* accuracy, not a match against a paid product.
 */
export function computeAccuracy(moves: MoveEval[]): { white: number; black: number } {
  if (moves.length === 0) return { white: 100, black: 100 };

  const whiteAccs: number[] = [];
  const blackAccs: number[] = [];
  for (const m of moves) {
    const isWhite = m.ply % 2 === 1;
    const lossPct = Math.max(0, (m.winrateBefore - m.winrateAfter) * 100);
    const acc = moveAccuracy(lossPct);
    if (isWhite) whiteAccs.push(acc);
    else blackAccs.push(acc);
  }

  const whiteAcc = harmonicMean(whiteAccs);
  const blackAcc = harmonicMean(blackAccs);

  return {
    white: Math.round(Math.max(0, Math.min(100, whiteAcc)) * 10) / 10,
    black: Math.round(Math.max(0, Math.min(100, blackAcc)) * 10) / 10,
  };
}
