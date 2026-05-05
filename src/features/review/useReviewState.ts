import { useMemo, useState } from 'react';
import { Chess, type Move } from 'chess.js';
import type { Game } from '@/db/schema';

export interface MainlineStep {
  fen: string;
  san?: string;
  uci?: string;
}

export interface ReviewState {
  /** FENs for the mainline game: index 0 is the starting pos, index `ply` is after move `ply`. */
  mainlineFens: string[];
  /** Verbose SAN history from the original PGN. */
  mainlineHistory: Move[];
  /** Current mainline ply (0 = start). 0..mainlineFens.length-1 */
  mainlinePly: number;
  /** If the user has branched off, this is an array of moves appended after mainlinePly. */
  explorationMoves: { san: string; uci: string; fen: string }[];
  /** Current FEN displayed on the board. */
  currentFen: string;
  /** UCI of last move applied (either mainline or exploration). */
  lastUci?: string;
  /** True while exploring an off-mainline position. */
  isExploring: boolean;
}

/**
 * Unified review-state hook. Supports two modes:
 *   1) Mainline navigation (prev/next/jump to any mainline ply).
 *   2) Exploration: appends off-mainline moves; one click to return to mainline.
 */
export function useReviewState(game: Game | undefined) {
  const [mainlinePly, setMainlinePly] = useState(0);
  const [explorationMoves, setExplorationMoves] = useState<
    { san: string; uci: string; fen: string }[]
  >([]);

  const { mainlineFens, mainlineHistory } = useMemo(() => {
    if (!game) return { mainlineFens: [], mainlineHistory: [] as Move[] };
    const c = new Chess();
    try {
      c.loadPgn(game.pgn);
    } catch {
      return { mainlineFens: [], mainlineHistory: [] as Move[] };
    }
    const history = c.history({ verbose: true }) as Move[];
    const fens: string[] = [];
    const replay = new Chess();
    fens.push(replay.fen());
    for (const m of history) {
      replay.move(m.san);
      fens.push(replay.fen());
    }
    return { mainlineFens: fens, mainlineHistory: history };
  }, [game]);

  const isExploring = explorationMoves.length > 0;
  const currentFen = isExploring
    ? explorationMoves[explorationMoves.length - 1].fen
    : mainlineFens[mainlinePly] ?? mainlineFens[0] ?? new Chess().fen();

  const lastUci = isExploring
    ? explorationMoves[explorationMoves.length - 1].uci
    : mainlinePly > 0
      ? uciOf(mainlineHistory[mainlinePly - 1])
      : undefined;

  function goToMainlinePly(ply: number) {
    setExplorationMoves([]);
    setMainlinePly(Math.max(0, Math.min(ply, mainlineFens.length - 1)));
  }

  function step(delta: number) {
    if (isExploring) {
      if (delta < 0) {
        setExplorationMoves((prev) => prev.slice(0, -1));
      }
    } else {
      goToMainlinePly(mainlinePly + delta);
    }
  }

  function tryPlay(move: { from: string; to: string; promotion?: string }): boolean {
    const fen = currentFen;
    const c = new Chess();
    try {
      c.load(fen);
    } catch {
      return false;
    }
    const result = c.move({ from: move.from, to: move.to, promotion: move.promotion });
    if (!result) return false;
    const uci = result.from + result.to + (result.promotion ?? '');

    // If we're on mainline and played the mainline move, just advance.
    if (!isExploring) {
      const expected = mainlineHistory[mainlinePly];
      if (
        expected &&
        expected.from === result.from &&
        expected.to === result.to &&
        (expected.promotion ?? '') === (result.promotion ?? '')
      ) {
        setMainlinePly(mainlinePly + 1);
        return true;
      }
    }

    setExplorationMoves((prev) => [
      ...prev,
      { san: result.san, uci, fen: c.fen() },
    ]);
    return true;
  }

  function resetExploration() {
    setExplorationMoves([]);
  }

  return {
    mainlineFens,
    mainlineHistory,
    mainlinePly,
    explorationMoves,
    currentFen,
    lastUci,
    isExploring,
    goToMainlinePly,
    step,
    tryPlay,
    resetExploration,
  } satisfies ReviewState & {
    goToMainlinePly: (ply: number) => void;
    step: (delta: number) => void;
    tryPlay: (move: { from: string; to: string; promotion?: string }) => boolean;
    resetExploration: () => void;
  };
}

function uciOf(m: Move | undefined): string | undefined {
  if (!m) return undefined;
  return m.from + m.to + (m.promotion ?? '');
}
