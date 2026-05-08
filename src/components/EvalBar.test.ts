import { describe, expect, it } from 'vitest';
import { formatEvalLabel, mateForWhite } from './EvalBar';

describe('formatEvalLabel', () => {
  it('renders null when cp is unknown and no mate', () => {
    expect(formatEvalLabel(null)).toBeNull();
  });

  it('renders mate as M<n> with sign', () => {
    expect(formatEvalLabel(null, 5)).toBe('M5');
    expect(formatEvalLabel(null, -3)).toBe('-M3');
  });

  it('treats mate=0 as no mate (just-mated already, fall through to cp)', () => {
    expect(formatEvalLabel(150, 0)).toBe('+1.5');
  });

  it('renders cp as +N.N with sign', () => {
    expect(formatEvalLabel(120)).toBe('+1.2');
    expect(formatEvalLabel(-340)).toBe('-3.4');
  });

  it('rounds towards zero for trivial evals', () => {
    expect(formatEvalLabel(2)).toBe('0.0');
    expect(formatEvalLabel(-4)).toBe('0.0');
  });

  it('mate takes priority over cp', () => {
    expect(formatEvalLabel(800, 7)).toBe('M7');
    expect(formatEvalLabel(-800, -7)).toBe('-M7');
  });
});

/**
 * Pins the contract that fixes the "eval bar swaps to the wrong side
 * after every reply during free-play / exploration" bug from
 * 2026-05-08:
 *
 *   - Stockfish reports `scoreMate` from the *side-to-move's*
 *     perspective. After White plays a move forcing mate-in-1, it's
 *     Black's turn, so the engine reports `scoreMate = -1`
 *     (STM = Black is being mated). A naive bar that treats `mate > 0`
 *     as "White winning" then fills BLACK as if Black were winning.
 *
 *   - `mateForWhite(stmMate, fen)` converts to a sign-relative-to-
 *     White integer so the EvalBar fill stays anchored to the winning
 *     colour every ply.
 *
 *   - `0` and `undefined` round-trip as "no mate".
 */
describe('mateForWhite — STM → White-POV mate conversion', () => {
  // Two minimal FENs differing only in side-to-move.
  const WHITE_TO_MOVE = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  const BLACK_TO_MOVE = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 0 1';

  it('returns undefined when input is undefined', () => {
    expect(mateForWhite(undefined, WHITE_TO_MOVE)).toBeUndefined();
  });

  it('treats 0 as no-mate (formatter falls through to cp anyway)', () => {
    expect(mateForWhite(0, WHITE_TO_MOVE)).toBeUndefined();
  });

  it('passes positive mate through unchanged when STM is White (White mates)', () => {
    expect(mateForWhite(3, WHITE_TO_MOVE)).toBe(3);
  });

  it('passes negative mate through unchanged when STM is White (White is mated)', () => {
    expect(mateForWhite(-3, WHITE_TO_MOVE)).toBe(-3);
  });

  it('flips sign when STM is Black and Black mates (engine emits +N → White-POV -N)', () => {
    // Black STM, engine: scoreMate=+1 means Black is about to mate
    // White. White-POV mate = -1 (Black mates White).
    expect(mateForWhite(1, BLACK_TO_MOVE)).toBe(-1);
  });

  it('flips sign when STM is Black and Black is mated (the bug case)', () => {
    // White just played a move forcing mate-in-1. It's now Black's
    // turn. Engine reports scoreMate=-1 (STM=Black is being mated).
    // White-POV mate = +1 (White mates next move).
    expect(mateForWhite(-1, BLACK_TO_MOVE)).toBe(1);
  });
});
