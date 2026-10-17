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
  /**
   * Same shape as `EnginePool.analyze` and `cachedAnalyze`. `signal` is the
   * game's abort flag: a backend that queues work may drop positions that have
   * not started once it trips (the browser pool does — see
   * `EnginePool.analyze`), rejecting them. A backend that never aborts can
   * ignore it.
   */
  analyze(
    fen: string,
    depth: number,
    signal?: { aborted: boolean },
  ): Promise<AnalysisResult>;
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
    analyze: (fen, depth, signal) => cache.cachedAnalyze(fen, depth, signal),
    newGame: () => pool.analysisPool().newGame(),
    noteBookSkip: () => {
      cache.cacheStats.bookSkips++;
    },
  };
}

/**
 * Why a game cannot be analysed from where it starts, or null if it can.
 *
 * A thrown reason lands in `Game.analysisError`, which the review page shows
 * verbatim — so these are sentences for the user, and deterministic: retrying
 * cannot change the answer, which is why they must not match any of
 * `requeueStaleErrors`' transient patterns.
 *
 * Two cases are refused rather than analysed wrongly:
 *
 *  - **A variant** (`[Variant "Chess960"]`, …). chess.js and the engine both
 *    play standard rules here — Stockfish is never put in `UCI_Chess960` — so
 *    castling would be judged by the wrong rules. The importer now skips
 *    Chess.com's non-standard `rules`; this catches the ones imported before it
 *    did, and any other source.
 *  - **Black to move first.** Every consumer of a stored analysis splits moves
 *    by colour on ply parity — `ply % 2 === 1` is White in
 *    `computeAccuracyWithModel`, `countUserBrilliancies`, the move list, the
 *    mistake-puzzle extractor and the per-colour clock stats. A game whose
 *    first move is Black's would have every one of them swap the colours:
 *    the user's accuracy reported as the opponent's, their blunders turned into
 *    the opponent's puzzles. Renumbering plies to keep parity would touch the
 *    stored `MoveEval.ply` contract everywhere for what is a vanishingly rare
 *    game, so it is refused with a clear reason instead.
 *
 * A standard game set up with WHITE to move is analysed normally: its moves
 * keep White on odd plies, so all of the above stays correct.
 */
function unsupportedStart(
  headers: Record<string, string | null | undefined>,
  startFen: string,
): string | null {
  const variant = headers.Variant;
  if (variant && !/^(standard|chess)$/i.test(variant.trim())) {
    return `Can't analyze ${variant} games. Only standard chess is supported.`;
  }
  if (startFen.split(' ')[1] === 'b') {
    return (
      "Can't analyze this game: it starts from a set-up position with Black to " +
      'move, which analysis does not support yet.'
    );
  }
  return null;
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

  // Re-play to get the list of FENs before each move — from the game's OWN
  // starting position. `loadPgn` honours a `[SetUp "1"] [FEN …]` header, but
  // this replay used to start from `new Chess()`, so every game that began
  // from a set-up position failed on its first move ("Invalid move: Rh8+") and
  // was recorded as an analysis error. `history[0].before` is that start, as
  // chess.js itself loaded it. The replay is kept (rather than reading
  // `before`/`after` off `history`) so the FEN strings, which key `evalCache`,
  // stay exactly what they always were for standard games.
  const startFen = history[0]?.before ?? chess.fen();
  const unsupported = unsupportedStart(chess.getHeaders(), startFen);
  if (unsupported) throw new Error(unsupported);
  const replay = new Chess(startFen);
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
    // The signal goes down with every position so a preempted game's queued
    // backlog is dropped, not run ahead of the game that preempted it.
    const p = backend.analyze(fen, depth, signal);
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
          // The refutation is the engine's best in `fenAfter`. Passed only
          // where the next stored ply carries that same move as its
          // `bestMoveUci`, because that is all the boot recompute pass can
          // read back — tagging differently here would make a game's motifs
          // depend on whether it was ever recomputed.
          replyUci:
            i + 1 < history.length && !bookMoveIdx[i + 1]
              ? (afterRes?.bestMoveUci ?? undefined)
              : undefined,
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
 * the whole game accuracy down with it. The truth follows from `fenAfter`
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

/** Geometric mean, each value floored at `floor` first, like `harmonicMean`.
 *  Less dominated by the worst moves than the harmonic mean, which is what
 *  fits Chess.com's numbers. */
export function geometricMean(xs: number[], floor = 20): number {
  if (xs.length === 0) return 100;
  let logSum = 0;
  for (const x of xs) {
    const v = Math.max(floor, x);
    if (v <= 0) return 0;
    logSum += Math.log(v);
  }
  return Math.exp(logSum / xs.length);
}

/** The bottom of `cpToWinrate`'s curve: the mover is at or past the -1000 cp
 *  clamp. Every stored winrate there is exactly this value. */
const CLAMPED_LOST_WINRATE = cpToWinrate(-Infinity);

export interface AccuracyAggregationOptions {
  /** Count book plies, as perfect moves. Never with their stored winrates:
   *  no engine search produced those, so they are not evidence of loss. */
  includeBook: boolean;
  /** Lower bound applied to each move before the mean. */
  floor: number;
  /** Decay of the per-move curve (`moveAccuracy`). Default: Lichess's. */
  moveDecay?: number;
  /** Calibrates distance from 100 while preserving endpoints/order. */
  gapMultiplier?: number;
  /** How per-move accuracies combine. Default `harmonic`. */
  mean?: 'harmonic' | 'geometric';
  /** Leave out engine-scored plies played from a position already at the
   *  bottom of the winrate curve. No move there can lose winrate, so every one
   *  scores 100, good or bad. Default false. */
  skipClampedLost?: boolean;
}

export const CURRENT_ACCURACY_MODEL: AccuracyAggregationOptions = {
  includeBook: true,
  floor: 9.6,
  moveDecay: 0.085,
  mean: 'geometric',
  skipClampedLost: true,
};

export function computeAccuracyWithModel(
  moves: MoveEval[],
  model: AccuracyAggregationOptions,
): { white: number; black: number } {
  const scoresFor = (white: boolean): number[] => {
    const own = moves
      .filter((move) => (move.ply % 2 === 1) === white)
      .filter((move) => model.includeBook || move.classification !== 'book');
    const informative = model.skipClampedLost
      ? own.filter(
          (move) => move.classification === 'book' || move.winrateBefore > CLAMPED_LOST_WINRATE,
        )
      : own;
    // A side that spent the whole game clamped lost still gets a score.
    return (informative.length > 0 ? informative : own).map((move) => {
      if (move.classification === 'book') return moveAccuracy(0, model.moveDecay);
      const lossPct = Math.max(0, (move.winrateBefore - move.winrateAfter) * 100);
      return moveAccuracy(lossPct, model.moveDecay);
    });
  };

  const mean = model.mean === 'geometric' ? geometricMean : harmonicMean;
  const rounded = (scores: number[]) => {
    const raw = mean(scores, model.floor);
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
 *     winrate loss, with a steeper decay (0.085 vs Lichess's 0.04354).
 *  2) Book plies count as perfect moves, as they do on Chess.com.
 *  3) Plies played from a position already clamped lost (-1000 cp or worse
 *     for the mover) are left out: no move there can lose winrate, so each
 *     would score 100 whatever was played.
 *  4) The game accuracy is the geometric mean, each move floored at 9.6
 *     first so one disaster can't zero an otherwise sound game.
 *
 * Calibrated against Chess.com's own `accuracies` on this user's games: 938
 * colour-scores from 469 rapid/blitz/bullet games (~700-1000 rated, Jan-Oct
 * 2026), all analysed with Stockfish 16 NNUE at depth 18. Refitted 2026-10-17:
 * 5-fold cross-validated MAE 3.81 (4.28 for the 2026-10-14 harmonic model,
 * 9.18 before that), bias +0.9, 95% within ±10. Fitted on Jan-Jul only, it
 * scored 3.95 on Aug-Oct (4.50 for the harmonic model). Better in every time
 * control. Fitted values were stable across folds (decay 0.085-0.086, floor
 * 9.3-10.0), and the clamp cut-off, when left free, landed on the clamp in
 * every fold.
 *
 * What the fits settled:
 *  - The geometric mean beats the harmonic one (CV 4.14 vs 4.28 on its own),
 *    and a free power mean fits to the geometric. An arithmetic blend, a soft
 *    floor and convex or piecewise stretches of the gap from 100 did not help.
 *  - The ×1.5 gap stretch of an older model was fitted on Carlsen/Nakamura
 *    archives and read club games ~7 points low. Refitted, it goes to ×1.0.
 *  - Counting book plies helps.
 *
 * Known residual: in games Chess.com scores below 60 this reads ~3.5 high.
 * Most of that is regression to the mean, not the model: grouped by
 * Chess.com's own score, a perfectly calibrated model with this much noise
 * would read ~2.7 high there. Grouped by this model's score, the low-end bias
 * is ~1. It is still worst on sides with many skipped plies (a long lost
 * ending), where it reads a few points low.
 *
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
