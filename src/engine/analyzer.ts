import { Chess } from 'chess.js';
import { isBookFen } from './book';
import type { AnalysisResult } from './engine';
import {
  classifyMove,
  cpToWinrate,
  mateToCp,
  moveAccuracy,
  terminalCpStm,
  terminalOutcome,
} from './classify';
import { detectMotifs } from './motifs';
import {
  baseSecondsFromTimeControl,
  deriveTimeSpent,
  detectPhase,
  extractClocks,
} from './phase';
import type { Analysis, Color, MoveEval } from '@/db/schema';
import { RECOMPUTE_VERSION } from '@/db/analysisVintage';

/**
 * The engine surface `analyzeGamePgn` needs, injectable so the analysis logic
 * can run outside a browser.
 *
 * This exists so a server-side worker can reuse this file verbatim. Everything
 * that decides what an analysis *means* — classification, motifs, phase,
 * winrate, book detection — lives here and in its pure siblings, and none of it
 * cares where the centipawns came from. Only the transport did: `./pool` needs
 * `new Worker` and `./cache` imports Dexie, so a static import of either made
 * this module unloadable under Node.
 *
 * The default backend is resolved by dynamic import, so those two modules are
 * only pulled in when nobody supplies an alternative — which keeps the browser
 * path byte-for-byte unchanged while leaving Node a way in.
 */
export interface EngineBackend {
  /**
   * Value stamped into `Analysis.engine`, identifying the evaluator — e.g.
   * `stockfish-16-nnue` vs `stockfish-16-classical`.
   *
   * This used to be the hard-coded constant `'stockfish-16'`, which was
   * inaccurate: the bundled WASM build runs with `Use NNUE` off, so every
   * analysis was classical. Recording it honestly is what lets a stronger
   * NNUE analysis be recognised as better than a classical one for the same
   * game at the same depth.
   */
  id(): string;
  /** Same shape as `EnginePool.analyze` and `cachedAnalyze`. */
  analyze(fen: string, depth: number): Promise<AnalysisResult>;
  /** UCI `ucinewgame`, to clear the transposition table between games. */
  newGame(): Promise<void>;
  /** Optional bookkeeping hook for a position skipped as opening book. */
  noteBookSkip?(): void;
}

/** Browser backend: the worker pool behind the Dexie-backed eval cache. */
async function defaultBackend(): Promise<EngineBackend> {
  const [cache, pool] = await Promise.all([import('./cache'), import('./pool')]);
  return {
    id: () => pool.analysisPool().evaluatorId(),
    analyze: (fen, depth) => cache.cachedAnalyze(fen, depth),
    newGame: () => pool.analysisPool().newGame(),
    noteBookSkip: () => {
      cache.cacheStats.bookSkips++;
    },
  };
}

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
  opts?: { hasOpening?: boolean; timeControl?: string; backend?: EngineBackend },
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

  const backend = opts?.backend ?? (await defaultBackend());
  await backend.newGame();

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
    const isLastMove = i === history.length - 1;
    const after = isLastMove ? finalFen : fensBefore[i + 1];
    // A position with no legal move is one the engine cannot score — see
    // `terminalOutcome`. Asking anyway spends a search and gets 0.00 back,
    // so the final position of a game that ended on the board is settled
    // by chess.js instead. Only that position can be terminal, and the check
    // is not cheap, so it is asked once per game rather than once per ply.
    if (!isLastMove || !terminalOutcome(after)) needEval.add(after);
  }
  // The very final position contributes only to the last move's eval —
  // it's already covered by the loop above when the last move is
  // non-book; we leave it out otherwise.

  // Progress: count tasks that actually run engine work. Book-only
  // games would otherwise look stuck at 0% even though they're
  // finishing instantly.
  const totalTasks = needEval.size;
  let tasksDone = 0;
  const evalByFen = new Map<string, Promise<AnalysisResult>>();
  const enqueue = (fen: string) => {
    if (evalByFen.has(fen)) return;
    const p = backend.analyze(fen, depth);
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
      backend.noteBookSkip?.();
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

    // Checkmate and stalemate are read off the board, not off the engine — and
    // only the game's last position can be either.
    const afterTerminal =
      i === history.length - 1 ? terminalOutcome(fenAfter) : null;

    const [beforeRes, afterRes] = await Promise.all([
      evalByFen.get(fenBefore)!,
      afterTerminal ? Promise.resolve(null) : evalByFen.get(fenAfter)!,
    ]);

    // Convert engine scores (always from side-to-move) into White-POV centipawns.
    const beforeCpStm =
      beforeRes.scoreMate != null
        ? mateToCp(beforeRes.scoreMate)
        : (beforeRes.scoreCp ?? 0);
    const afterCpStm = afterTerminal
      ? terminalCpStm(afterTerminal)
      : afterRes!.scoreMate != null
        ? mateToCp(afterRes!.scoreMate)
        : (afterRes!.scoreCp ?? 0);
    // Mate delivered: the side to move in `fenAfter` is mated *now*.
    const mateInAfter =
      afterTerminal === 'checkmate' ? 0 : (afterRes?.scoreMate ?? undefined);
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
          mateInAfter,
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
      mateInAfter,
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
    engine: backend.id(),
    moves,
    // Stamped by the producer, not only by `saveAnalysis`: the derived fields
    // above came from the current `classifyMove` / `detectMotifs` /
    // `detectPhase`, so the row is current by construction wherever it is
    // stored. The Node worker writes straight to `cloud_analyses` and never
    // calls `saveAnalysis`, and its unstamped rows read as vintage 0 — every
    // restore then reclassified and re-pushed the whole server-analyzed library.
    recomputeVersion: RECOMPUTE_VERSION,
  };
}

/**
 * Repair the after-move fields of a stored `MoveEval` whose `fenAfter` has no
 * legal move.
 *
 * Analyses produced before terminal positions were read off the board recorded
 * the engine's unscoreable answer as 0 cp, so the move that *ended* the game —
 * usually the winner's mate — reads as a ~48-point winrate collapse and drags
 * the whole harmonic mean down with it. The truth follows from `fenAfter`
 * alone, which is what lets the boot recompute pass fix an existing library
 * without re-running Stockfish over it.
 *
 * Returns the same object when there is nothing to repair, so the pass's
 * changed-detection stays honest.
 */
export function repairTerminalMoveEval(m: MoveEval): MoveEval {
  const outcome = terminalOutcome(m.fenAfter);
  if (!outcome) return m;

  // The mover is whoever is *not* to move in `fenAfter` — same conversion
  // `analyzeGamePgn` does, kept in step with it deliberately.
  const moverIsWhite = m.fenAfter.split(' ')[1] === 'b';
  const cpStm = terminalCpStm(outcome);
  const evalCpAfter = moverIsWhite ? -cpStm : cpStm;
  const winrateAfter = cpToWinrate(moverIsWhite ? evalCpAfter : -evalCpAfter);
  const mateInAfter = outcome === 'checkmate' ? 0 : undefined;

  if (
    m.evalCpAfter === evalCpAfter &&
    m.winrateAfter === winrateAfter &&
    m.mateInAfter === mateInAfter
  ) {
    return m;
  }
  return { ...m, evalCpAfter, winrateAfter, mateInAfter };
}

/**
 * Harmonic mean — naturally pulled toward low values, so single bad moves
 * count more than single good ones. We floor each value at `floor` (default
 * 20) so a "move-acc = 0" outlier doesn't crater an otherwise decent game.
 */
export function harmonicMean(xs: number[], floor = 20): number {
  if (xs.length === 0) return 100;
  let recip = 0;
  for (const x of xs) {
    const v = Math.max(floor, x);
    if (v <= 0) return 0;
    recip += 1 / v;
  }
  return xs.length / recip;
}

export interface AccuracyAggregationOptions {
  /** Count book plies, as perfect moves. Never with their stored winrates:
   *  no engine search produced those, so they are not evidence of loss. */
  includeBook: boolean;
  /** Lower bound applied before the harmonic mean. */
  floor: number;
  /** Decay of the per-move curve (`moveAccuracy`). Default: Lichess's. */
  moveDecay?: number;
  /** Calibrates distance from 100 while preserving endpoints/order. */
  gapMultiplier?: number;
}

export const CURRENT_ACCURACY_MODEL: AccuracyAggregationOptions = {
  includeBook: true,
  floor: 24,
  moveDecay: 0.074,
};

export function computeAccuracyWithModel(
  moves: MoveEval[],
  model: AccuracyAggregationOptions,
): { white: number; black: number } {
  const scoresFor = (white: boolean): number[] =>
    moves
      .filter((move) => (move.ply % 2 === 1) === white)
      .filter((move) => model.includeBook || move.classification !== 'book')
      .map((move) => {
        if (move.classification === 'book') return moveAccuracy(0, model.moveDecay);
        const lossPct = Math.max(0, (move.winrateBefore - move.winrateAfter) * 100);
        return moveAccuracy(lossPct, model.moveDecay);
      });

  const rounded = (scores: number[]) => {
    const raw = harmonicMean(scores, model.floor);
    const calibrated = 100 - (100 - raw) * (model.gapMultiplier ?? 1);
    return Math.round(Math.max(0, Math.min(100, calibrated)) * 10) / 10;
  };

  return {
    white: rounded(scoresFor(true)),
    black: rounded(scoresFor(false)),
  };
}

/**
 * Compute per-color accuracy from the move list.
 *
 * Approach:
 *  1) Per-move accuracy is Lichess's exponential curve over the mover's
 *     winrate loss, with a steeper decay (0.074 vs Lichess's 0.04354).
 *  2) Book plies count as perfect moves, as they do on Chess.com.
 *  3) The game accuracy is the harmonic mean, each move floored at 24 first
 *     so one disaster can't zero an otherwise sound game.
 *
 * Calibrated 2026-10-14 against Chess.com's own `accuracies` on this user's
 * games: 938 colour-scores from 469 rapid/blitz/bullet games (~700-1000
 * rated), all analysed with Stockfish 16 NNUE at depth 18. 5-fold
 * cross-validated MAE 4.24 (was 9.18; bias −6.8 → +0.9); 95% of scores within
 * ±10 (was 62%). Fitted on Jan-Jul only, it scored 4.4 on Aug-Oct, where the
 * previous model scored 10.4. The fitted values were stable across folds
 * (decay 0.072-0.074, floor 23.3-23.8).
 *
 * What the fit settled:
 *  - The previous model's ×1.5 stretch of the distance from 100 was fitted on
 *    Carlsen/Nakamura archives and read club games ~7 points low. Refitted
 *    here, the stretch goes to ×1.0 once the per-move decay is free: the
 *    shape of the curve was wrong, not its scale.
 *  - Mixing in an arithmetic mean never helped (its weight fitted to 0).
 *  - Counting book plies cut MAE from 4.74 to 4.24.
 *
 * Known residual: in games Chess.com scores below 60 this reads ~5 high.
 * Changing the model needs an `ACCURACY_BACKFILL_VERSION` bump
 * (`db/queries.ts`) to reach stored games. Synced games need nothing more:
 * cloud sync re-derives accuracy from every analysis it pulls.
 */
export function computeAccuracy(moves: MoveEval[]): { white: number; black: number } {
  if (moves.length === 0) return { white: 100, black: 100 };
  return computeAccuracyWithModel(moves, CURRENT_ACCURACY_MODEL);
}

/**
 * Count `brilliant` moves played by `userColor` in an analyzed move list.
 *
 * Cached onto `Game.brilliantCount` so the Games table can badge
 * brilliancies without loading the `analyses` rows. Shared by all three
 * writers (queue on analysis, boot recompute, one-shot backfill) so the
 * ply-parity convention lives in exactly one place.
 *
 * Ply is 1-indexed with White on odd plies — the same rule
 * `computeAccuracyWithModel` uses to split its per-color scores.
 */
export function countUserBrilliancies(
  moves: readonly MoveEval[],
  userColor: Color,
): number {
  const userIsWhite = userColor === 'white';
  let n = 0;
  for (const m of moves) {
    if (m.classification !== 'brilliant') continue;
    if ((m.ply % 2 === 1) !== userIsWhite) continue;
    n++;
  }
  return n;
}
