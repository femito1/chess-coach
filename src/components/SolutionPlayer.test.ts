import { describe, expect, it } from 'vitest';
import { buildSolutionSteps } from './SolutionPlayer';

const INITIAL_FEN =
  'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

describe('buildSolutionSteps', () => {
  it('returns a single step (the start FEN) when moves is empty', () => {
    const steps = buildSolutionSteps(INITIAL_FEN, []);
    expect(steps).toHaveLength(1);
    expect(steps[0].fen).toBe(INITIAL_FEN);
    expect(steps[0].san).toBe('');
    expect(steps[0].uci).toBe('');
  });

  it('replays a clean line of moves into one step per move plus the start', () => {
    const steps = buildSolutionSteps(INITIAL_FEN, ['e2e4', 'e7e5', 'g1f3']);
    expect(steps).toHaveLength(4);
    expect(steps[0].san).toBe('');
    expect(steps[1].san).toBe('e4');
    expect(steps[1].uci).toBe('e2e4');
    expect(steps[2].san).toBe('e5');
    expect(steps[2].uci).toBe('e7e5');
    expect(steps[3].san).toBe('Nf3');
    expect(steps[3].uci).toBe('g1f3');
  });

  it('stops at the first illegal move instead of throwing', () => {
    // The third move (e2e4 again) is illegal in the resulting position;
    // we should still get the first two legal steps + the start step.
    const steps = buildSolutionSteps(INITIAL_FEN, ['e2e4', 'e7e5', 'e2e4']);
    expect(steps).toHaveLength(3);
    expect(steps[steps.length - 1].san).toBe('e5');
  });

  it('preserves an invalid start FEN gracefully (returns just the start step)', () => {
    const steps = buildSolutionSteps('not a fen', ['e2e4']);
    expect(steps).toHaveLength(1);
    expect(steps[0].fen).toBe('not a fen');
  });

  it('handles a promotion move via the 5-character UCI form', () => {
    // Set up a position where white can promote on h8 in one move.
    const beforePromotion =
      'rnbqkbnr/ppppppPp/8/8/8/8/PPPPPPP1/RNBQKBNR w KQkq - 0 1';
    const steps = buildSolutionSteps(beforePromotion, ['g7h8q']);
    expect(steps).toHaveLength(2);
    expect(steps[1].uci).toBe('g7h8q');
    // SAN for a queen promotion is "<square>=Q" (or capture-form).
    expect(steps[1].san).toMatch(/=Q/);
  });

  it('replays from a non-initial FEN (puzzle-style entry)', () => {
    // Mid-game FEN where white can play a discovered check via Nxe5.
    const fen =
      'r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4';
    const steps = buildSolutionSteps(fen, ['f3e5', 'c6e5']);
    expect(steps).toHaveLength(3);
    expect(steps[1].san).toMatch(/Nxe5/);
    expect(steps[2].san).toMatch(/Nxe5/);
  });
});
