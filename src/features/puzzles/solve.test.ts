import { describe, expect, test } from 'vitest';
import { applyPuzzleMove } from './solve';

describe('applyPuzzleMove', () => {
  test('odd-length line: solver plays the final move and the puzzle is solved', () => {
    // Mate-in-1: white queen takes h7, line is just 'd1h5#' style. We use
    // a one-move line: Qa1-a8 mating scenario isn't necessary; just any
    // legal one-move solution.
    const fen = '7k/8/8/8/8/8/8/Q6K w - - 0 1';
    const result = applyPuzzleMove({
      fen,
      solutionUci: ['a1a8'],
      solvedIdx: 0,
      move: { from: 'a1', to: 'a8' },
    });
    expect(result.kind).toBe('accepted');
    if (result.kind !== 'accepted') return;
    expect(result.solved).toBe(true);
    expect(result.nextSolvedIdx).toBe(1);
    expect(result.lastUci).toBe('a1a8');
  });

  test('even-length line: solver plays last move, opp auto-replies, puzzle is solved', () => {
    // Regression for the bug reported on the puzzle page where
    // even-length lines (user-move, opp-reply) never transitioned to
    // 'solved' — the user got stuck after the auto-reply because
    // `solutionUci[solvedIdx]` became undefined.
    const fen = '7r/6k1/8/8/8/8/8/K6Q w - - 0 1';
    const result = applyPuzzleMove({
      fen,
      solutionUci: ['h1h8', 'g7h8'],
      solvedIdx: 0,
      move: { from: 'h1', to: 'h8' },
    });
    expect(result.kind).toBe('accepted');
    if (result.kind !== 'accepted') return;
    expect(result.solved).toBe(true);
    expect(result.nextSolvedIdx).toBe(2);
    expect(result.lastUci).toBe('g7h8');
    // After Qxh8+ Kxh8: black king on h8, white queen captured.
    expect(result.fen.startsWith('7k/')).toBe(true);
  });

  test('multi-move line: intermediate user move keeps the puzzle going', () => {
    // 4 plies: user, opp, user, opp. After the first user move the
    // opponent replies and we expect solved=false, nextSolvedIdx=2.
    // Setup: white plays Ra1-a8+, black king must escape check (here
    // Ke7), white still has further moves queued. After this single user
    // move + the auto-reply, two moves of the line are done.
    const fen = '4k3/8/8/8/8/8/8/R3K2R w - - 0 1';
    const result = applyPuzzleMove({
      fen,
      solutionUci: ['a1a8', 'e8e7', 'h1h8', 'e7e6'],
      solvedIdx: 0,
      move: { from: 'a1', to: 'a8' },
    });
    expect(result.kind).toBe('accepted');
    if (result.kind !== 'accepted') return;
    expect(result.solved).toBe(false);
    expect(result.nextSolvedIdx).toBe(2);
    expect(result.lastUci).toBe('e8e7');
  });

  test('wrong move is rejected without advancing state', () => {
    const fen = '7r/6k1/8/8/8/8/8/K6Q w - - 0 1';
    const result = applyPuzzleMove({
      fen,
      solutionUci: ['h1h8', 'g7h8'],
      solvedIdx: 0,
      move: { from: 'h1', to: 'h7' },
    });
    expect(result.kind).toBe('rejected');
    if (result.kind !== 'rejected') return;
    expect(result.reason).toBe('wrong-move');
  });

  test('attempting a move when no expected move remains is rejected', () => {
    const fen = '8/8/8/8/8/8/8/7K w - - 0 1';
    const result = applyPuzzleMove({
      fen,
      solutionUci: ['h1h8'],
      solvedIdx: 1,
      move: { from: 'h1', to: 'h2' },
    });
    expect(result.kind).toBe('rejected');
    if (result.kind !== 'rejected') return;
    expect(result.reason).toBe('no-expected');
  });

  test('expected move with explicit promotion still matches when user promotes to queen', () => {
    // Solution stores 'a7a8q'; user move is 'a7a8' with promotion: 'q'.
    // The state machine compares only the first 4 chars, then chess.js
    // applies the user's promotion, which lines up.
    const fen = '7k/P7/8/8/8/8/8/7K w - - 0 1';
    const result = applyPuzzleMove({
      fen,
      solutionUci: ['a7a8q'],
      solvedIdx: 0,
      move: { from: 'a7', to: 'a8', promotion: 'q' },
    });
    expect(result.kind).toBe('accepted');
    if (result.kind !== 'accepted') return;
    expect(result.solved).toBe(true);
  });
});
