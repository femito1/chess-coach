import { describe, expect, it } from 'vitest';
import { MOTIF_EXPLANATION, MOTIF_LABEL } from './motifs';
import type { Motif, MoveEval } from '@/db/schema';

describe('motif metadata', () => {
  it('every motif label has a non-empty explanation of the right shape', () => {
    const labelKeys = Object.keys(MOTIF_LABEL) as Motif[];
    expect(labelKeys.length).toBeGreaterThan(0);
    for (const m of labelKeys) {
      expect(MOTIF_LABEL[m], `label for ${m}`).toBeTruthy();
      const exp = MOTIF_EXPLANATION[m];
      expect(exp, `explanation for ${m}`).toBeTruthy();
      expect(exp.length, `explanation for ${m} too short`).toBeGreaterThan(20);
      // Explanations should stay within a reasonable size (single
      // sentence-ish) so they fit on the weakness card without
      // truncation. Pin this contract via a soft cap.
      expect(exp.length, `explanation for ${m} too long`).toBeLessThan(320);
    }
  });

  it('MOTIF_LABEL and MOTIF_EXPLANATION have the same set of keys', () => {
    const labelKeys = Object.keys(MOTIF_LABEL).sort();
    const expKeys = Object.keys(MOTIF_EXPLANATION).sort();
    expect(expKeys).toEqual(labelKeys);
  });
});

describe('MoveEval type wiring', () => {
  // Pure compile-time assertion that the new aggregate fields
  // (`fenBefore`, `evalCpBefore`, `bestMoveUci`, `motifs`) are
  // present on MoveEval. If someone refactors them away the test
  // file will fail to compile.
  it('MoveEval exposes the fields the weaknesses page reads', () => {
    const sample: MoveEval = {
      ply: 1,
      uci: 'e2e4',
      san: 'e4',
      fenBefore: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      fenAfter: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1',
      evalCpBefore: 0,
      evalCpAfter: 30,
      winrateBefore: 0.5,
      winrateAfter: 0.55,
      depth: 14,
      classification: 'good',
      bestMoveUci: 'd2d4',
      bestMoveSan: 'd4',
      motifs: [],
    };
    expect(sample.fenBefore).toBeTruthy();
    expect(typeof sample.evalCpBefore).toBe('number');
  });
});
