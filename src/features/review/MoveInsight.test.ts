import { describe, expect, it } from 'vitest';
import type { MoveEval } from '@/db/schema';
import { formatEvalAfter } from './MoveInsight';

function move(fenAfter: string, mateInAfter: number | undefined, evalCpAfter = 0): MoveEval {
  return {
    ply: 1,
    san: 'x',
    fenBefore: fenAfter,
    fenAfter,
    evalCpBefore: 0,
    evalCpAfter,
    winrateBefore: 0.5,
    winrateAfter: 0.5,
    classification: 'good',
    depth: 16,
    mateInAfter,
  };
}

const WHITE_TO_MOVE = 'rnbqkbnr/ppppp2p/5p2/6p1/8/P3P3/1PPP1PPP/RNBQKBNR w KQkq - 0 3';
const BLACK_TO_MOVE = 'rnbqkbnr/pppp1ppp/8/4p3/6P1/5P2/PPPPP2P/RNBQKBNR b KQkq - 0 2';

/**
 * `mateInAfter` is stored from the side to move in `fenAfter`, while the
 * centipawn branch of this label is White's view. The bug this pins: the raw
 * number was printed, so White mating read "M1" after a Black move but a
 * Black mate after a White move read "M-1" — a sign convention that flipped
 * every ply beside a centipawn figure that didn't.
 */
describe('formatEvalAfter', () => {
  it('labels a mate from White’s side, like the centipawn figure next to it', () => {
    // After 2...g5?? White, to move, mates: stored +1.
    expect(formatEvalAfter(move(WHITE_TO_MOVE, 1))).toBe('M1');
    // After 2.g4?? Black, to move, mates: stored +1 too, but it is Black's.
    expect(formatEvalAfter(move(BLACK_TO_MOVE, 1))).toBe('-M1');
    // The side to move being mated reads the other way round.
    expect(formatEvalAfter(move(WHITE_TO_MOVE, -3))).toBe('-M3');
    expect(formatEvalAfter(move(BLACK_TO_MOVE, -3))).toBe('M3');
  });

  it('keeps # for mate delivered and centipawns otherwise', () => {
    expect(formatEvalAfter(move(WHITE_TO_MOVE, 0))).toBe('#');
    expect(formatEvalAfter(move(WHITE_TO_MOVE, undefined, 150))).toBe('+1.50');
  });
});
