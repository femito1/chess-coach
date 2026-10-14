import { describe, expect, it } from 'vitest';
import { Chess } from 'chess.js';
import { MOTIF_EXPLANATION, MOTIF_LABEL, detectMotifs, type DetectMotifsInput } from './motifs';
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

/** Play one UCI move on `fen` and return the resulting FEN. */
function after(fen: string, uci: string): string {
  const c = new Chess(fen);
  c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci.slice(4, 5) || undefined });
  return c.fen();
}

/** A tagged mistake: `played` on `fenBefore`, a clear winrate drop. */
function motifsOf(
  fenBefore: string,
  played: string,
  extra: Partial<DetectMotifsInput> = {},
): Motif[] {
  return detectMotifs({
    fenBefore,
    fenAfter: after(fenBefore, played),
    playedUci: played,
    winrateBefore: 0.6,
    winrateAfter: 0.3,
    ...extra,
  });
}

describe('detectMotifs — mate perspective', () => {
  // 1.e3 f6 2.a3 g5?? — Qh5# is on. The engine scores `fenAfter` for White,
  // the side to move there, so the stored reading is +1.
  const FOOLS = 'rnbqkbnr/ppppp1pp/5p2/8/8/P3P3/1PPP1PPP/RNBQKBNR b KQkq - 0 2';

  it('tags allowedMate when the opponent, to move after the blunder, mates', () => {
    expect(motifsOf(FOOLS, 'g7g5', { mateInAfter: 1 })).toContain('allowedMate');
  });

  it('does not tag allowedMate on a mate the mover delivered, or one it is giving', () => {
    expect(motifsOf(FOOLS, 'g7g5', { mateInAfter: 0 })).not.toContain('allowedMate');
    expect(motifsOf(FOOLS, 'g7g5', { mateInAfter: -3 })).not.toContain('allowedMate');
  });
});

describe('detectMotifs — walked into (the opponent’s reply)', () => {
  it('finds a fork from the opponent’s best reply, not the mover’s best move', () => {
    // Black drifts with ...h6 and White's Nc7+ forks king and rook. The
    // mover's own best move (`bestUci`, a black move) cannot be played on
    // `fenAfter`, so detection has to run off `replyUci`.
    const fen = 'r3k3/7p/8/1N6/8/8/8/6K1 b - - 0 1';
    expect(motifsOf(fen, 'h7h6', { bestUci: 'a8c8', replyUci: 'b5c7' })).toContain('fork');
  });

  it('tags a pin the reply creates, but not one that was already standing', () => {
    const fresh = '4k3/7p/2n5/8/8/8/8/3BK3 b - - 0 1';
    expect(motifsOf(fresh, 'h7h6', { replyUci: 'd1a4' })).toContain('pin');
    const standing = '4k3/7p/2n5/8/B7/8/8/4K3 b - - 0 1';
    expect(motifsOf(standing, 'h7h6', { replyUci: 'e1e2' })).not.toContain('pin');
  });

  it('tags backRank only when a heavy piece then has a back-rank mate', () => {
    // ...Ra2 abandons the eighth rank; after any White reply Rd8# is on.
    const fen = 'r5k1/5ppp/8/8/8/8/5PPP/3R2K1 b - - 0 1';
    expect(motifsOf(fen, 'a8a2', { replyUci: 'g1f1' })).toContain('backRank');
    // Same structure, but ...h6 already gave the king luft.
    const luft = 'r5k1/5pp1/7p/8/8/8/5PPP/3R2K1 b - - 0 1';
    expect(motifsOf(luft, 'a8a2', { replyUci: 'g1f1' })).not.toContain('backRank');
  });
});

describe('detectMotifs — missed', () => {
  it('does not call a knight hitting two defended minors a fork', () => {
    // Nd5 hits both bishops, but the king on d8 covers c7 and e7.
    const defended = '3k4/2b1b3/8/8/1N6/8/8/6K1 w - - 0 1';
    expect(motifsOf(defended, 'g1h1', { bestUci: 'b4d5' })).not.toContain('missedFork');
    // Control: the same hit on two loose bishops is a fork.
    const loose = '7k/2b1b3/8/8/1N6/8/8/6K1 w - - 0 1';
    expect(motifsOf(loose, 'g1h1', { bestUci: 'b4d5' })).toContain('missedFork');
  });

  it('does not tag missedBackRank on a castled structure with no heavy piece to use it', () => {
    // Both kings sit behind three unmoved pawns — what the old test called
    // "weak", for either king — but neither side can mate along a rank.
    const fen = '6k1/5ppp/8/3n4/8/2B5/5PPP/6K1 w - - 0 1';
    expect(motifsOf(fen, 'c3a5', { bestUci: 'c3d2' })).not.toContain('missedBackRank');
  });

  it('tags missedBackRank when the best move mates on the back rank', () => {
    const fen = '6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1';
    expect(motifsOf(fen, 'g1f1', { bestUci: 'a1a8' })).toContain('missedBackRank');
  });

  it('does not tag missedPin for a pin that stood before the move', () => {
    const fen = '4k3/7p/2n5/8/B7/8/8/4K3 w - - 0 1';
    expect(motifsOf(fen, 'a4b3', { bestUci: 'e1e2' })).not.toContain('missedPin');
  });
});
