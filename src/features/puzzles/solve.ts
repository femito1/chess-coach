import { Chess } from 'chess.js';

/** Result of attempting one user move against a puzzle's expected line. */
export type PuzzleMoveResult =
  | { kind: 'rejected'; reason: 'no-expected' | 'wrong-move' | 'illegal' }
  | {
      kind: 'accepted';
      /** New FEN after the user's move (and the auto-played opponent reply
       *  if the line had one). */
      fen: string;
      /** UCI of the most recently played move on the board — the user's
       *  move when no auto-reply was played, or the opponent reply
       *  otherwise. Drives the chessground last-move highlight. */
      lastUci: string;
      /** New value for `solvedIdx`: the index of the next move the user
       *  needs to play, or `solutionUci.length` when the puzzle is done. */
      nextSolvedIdx: number;
      /** True iff every solution move (including any final auto-played
       *  opponent reply) has now been played out. */
      solved: boolean;
    };

/**
 * Pure state-machine for the puzzle solver. Given the current FEN, the
 * full solution, the index of the next expected move, and the user's
 * candidate move, returns whether the move was accepted plus the new
 * board state. Auto-plays the opponent reply when the solution still has
 * one queued — this is what lets the user solve a "Qxh8+ Kxh8" line in
 * one click and what makes even-length lines terminate cleanly.
 *
 * Critically, the puzzle is `solved` once `nextSolvedIdx` reaches
 * `solutionUci.length`, regardless of whether the line ended on the
 * user's move (odd length) or the auto-played opponent reply (even
 * length). The previous in-component code only handled the odd case,
 * which left even-length puzzles stuck after the last user move (no
 * pieces would respond, hint button rendered nothing because
 * `solutionUci[solvedIdx]` was undefined). See PuzzlesPage.tsx for the
 * UI hook-up; this module is plain and unit-tested.
 */
export function applyPuzzleMove(args: {
  fen: string;
  solutionUci: string[];
  solvedIdx: number;
  move: { from: string; to: string; promotion?: string };
}): PuzzleMoveResult {
  const { fen, solutionUci, solvedIdx, move } = args;
  const expected = solutionUci[solvedIdx];
  if (!expected) return { kind: 'rejected', reason: 'no-expected' };
  const uci = move.from + move.to + (move.promotion ?? '');
  if (uci.slice(0, 4) !== expected.slice(0, 4)) {
    return { kind: 'rejected', reason: 'wrong-move' };
  }
  const c = new Chess();
  try {
    c.load(fen);
    c.move({ from: move.from, to: move.to, promotion: move.promotion });
  } catch {
    return { kind: 'rejected', reason: 'illegal' };
  }
  const nextIdx = solvedIdx + 1;
  let lastUci = uci;
  let finalIdx = nextIdx;
  if (nextIdx < solutionUci.length) {
    const reply = solutionUci[nextIdx];
    try {
      c.move({
        from: reply.slice(0, 2),
        to: reply.slice(2, 4),
        promotion: reply.slice(4, 5) || undefined,
      });
      lastUci = reply;
      finalIdx = nextIdx + 1;
    } catch {
      // Defensive: if the stored auto-reply is somehow illegal in this
      // position, we accept the user's move and stop the line short.
      // The user has already played their move so we can't roll back.
    }
  }
  return {
    kind: 'accepted',
    fen: c.fen(),
    lastUci,
    nextSolvedIdx: finalIdx,
    solved: finalIdx >= solutionUci.length,
  };
}
