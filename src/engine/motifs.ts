import { Chess, type Square, type Move } from 'chess.js';
import type { Motif } from '@/db/schema';

const PIECE_VALUE: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

function val(t: string | undefined): number {
  if (!t) return 0;
  return PIECE_VALUE[t] ?? 0;
}

function loadSafe(fen: string): Chess | null {
  try {
    const c = new Chess();
    c.load(fen);
    return c;
  } catch {
    return null;
  }
}

/**
 * Enumerate (attackerSquare, attackerPieceType) pairs for a given color
 * attacking `square` in the current position.
 */
function attackersOf(c: Chess, square: Square, color: 'w' | 'b'): { from: Square; type: string }[] {
  const out: { from: Square; type: string }[] = [];
  const origTurn = c.turn();
  const fenParts = c.fen().split(' ');
  fenParts[1] = color;
  try {
    const scratch = new Chess();
    scratch.load(fenParts.join(' '));
    for (const m of scratch.moves({ verbose: true }) as Move[]) {
      if (m.to === square && (m.flags.includes('c') || m.flags.includes('e') || m.piece)) {
        out.push({ from: m.from as Square, type: m.piece });
      }
    }
  } catch {
    // ignore
  }
  void origTurn;
  return out;
}

/**
 * Recursive static-exchange evaluation on `square`. Positive = the side
 * currently to move in `c` gains that many points by initiating captures.
 */
function see(c: Chess, square: Square): number {
  const target = c.get(square);
  if (!target) return 0;
  if (target.color === c.turn()) return 0;
  const targetValue = val(target.type);

  let best: { from: Square; type: string } | null = null;
  for (const m of c.moves({ verbose: true }) as Move[]) {
    if (m.to !== square) continue;
    if (!m.flags.includes('c')) continue;
    const v = val(m.piece);
    if (!best || v < val(best.type)) best = { from: m.from as Square, type: m.piece };
  }
  if (!best) return 0;
  const move = c.move({ from: best.from, to: square, promotion: 'q' });
  if (!move) return 0;
  const reply = see(c, square);
  c.undo();
  return Math.max(0, targetValue - reply);
}

/**
 * After playing the move, scan opponent-side pieces and find any that
 * are now en prise (attacked more than defended, SEE > 0).
 *
 * Returns the highest-value hanging piece, or null.
 */
function hangingPieceAfter(fenAfter: string): { square: Square; value: number } | null {
  const c = loadSafe(fenAfter);
  if (!c) return null;
  const opponent = c.turn() === 'w' ? 'b' : 'w';
  let best: { square: Square; value: number } | null = null;
  const board = c.board();
  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const piece = board[r][f];
      if (!piece || piece.color !== opponent) continue;
      if (piece.type === 'k' || piece.type === 'p') continue;
      const sq = String.fromCharCode(97 + f) + (8 - r) as Square;
      // Standpoint: the side-to-move (attacker) tries to capture here.
      const gain = see(c, sq);
      if (gain > 0) {
        const v = val(piece.type);
        if (!best || v > best.value) best = { square: sq, value: v };
      }
    }
  }
  return best;
}

/**
 * Detect whether the move on `fenBefore` -> `fenAfter` with `uci` leaves
 * the MOVED piece itself en prise (a one-move blunder that drops material).
 */
function leavesOwnPieceHanging(fenBefore: string, uci: string): boolean {
  const c = loadSafe(fenBefore);
  if (!c) return false;
  const to = uci.slice(2, 4) as Square;
  const from = uci.slice(0, 2) as Square;
  const piece = c.get(from);
  if (!piece || piece.type === 'k' || piece.type === 'p') return false;
  const move = c.move({ from, to, promotion: uci.slice(4, 5) || undefined });
  if (!move) return false;
  // Now opponent is to move. SEE on `to` answers: can opponent profitably capture?
  const gain = see(c, to);
  return gain >= val(piece.type) - 1;
}

/**
 * Counts enemy pieces attacked by the piece that landed on `toSquare`
 * that are also worth at least as much as the attacker OR are undefended.
 * Returns the list so we can distinguish fork vs single attack.
 */
function attackedFromSquare(
  c: Chess,
  fromSquare: Square,
): { square: Square; type: string; undefended: boolean }[] {
  const out: { square: Square; type: string; undefended: boolean }[] = [];
  // Walk chess.js moves from this square.
  const attacker = c.get(fromSquare);
  if (!attacker) return out;
  const moves = c.moves({ square: fromSquare, verbose: true }) as Move[];
  for (const m of moves) {
    if (!m.flags.includes('c')) continue;
    const target = c.get(m.to as Square);
    if (!target) continue;
    if (target.type === 'k') {
      out.push({ square: m.to as Square, type: 'k', undefended: true });
      continue;
    }
    // Undefended = no friendly attackers of m.to for `target.color`.
    const defenders = attackersOf(c, m.to as Square, target.color);
    const undefended = defenders.length <= 1; // only the piece itself "defends" by occupying
    out.push({ square: m.to as Square, type: target.type, undefended });
  }
  // Also include squares the attacker X-rays into: not needed for forks.
  return out;
}

function isForkAt(fenAfter: string, toSquare: Square): boolean {
  const c = loadSafe(fenAfter);
  if (!c) return false;
  // After our move, opponent is to move. The attacker is OUR piece that just landed on toSquare.
  // For chess.js to enumerate its attacks we temporarily swap the side to move.
  const parts = fenAfter.split(' ');
  parts[1] = parts[1] === 'w' ? 'b' : 'w';
  const scratch = loadSafe(parts.join(' '));
  if (!scratch) return false;
  const attacks = attackedFromSquare(scratch, toSquare);
  if (attacks.length < 2) return false;
  // A fork worth calling out: attacker must hit at least two valuable targets
  // (king, queen, rook, or any undefended piece worth >= minor).
  const attackerPiece = scratch.get(toSquare);
  const attackerVal = val(attackerPiece?.type);
  let juicy = 0;
  for (const a of attacks) {
    const tv = a.type === 'k' ? 100 : val(a.type);
    if (tv > attackerVal || a.undefended) juicy++;
  }
  return juicy >= 2;
}

/**
 * Very light pin/skewer detector: checks if removing a piece along the
 * line from `toSquare` to the enemy king/queen reveals an X-ray attack.
 *
 * We keep it simple: if any of our sliders (B/R/Q) on/after the move has
 * a line where the first enemy piece is not the king/queen and the second
 * IS the king (pin) or the second is a lower-value piece than the first
 * (skewer), count it.
 */
function detectPinOrSkewer(fenAfter: string): { pin: boolean; skewer: boolean } {
  const c = loadSafe(fenAfter);
  if (!c) return { pin: false, skewer: false };
  // Attacker side = the side that just moved = !turn.
  const me = c.turn() === 'w' ? 'b' : 'w';
  const board = c.board();
  const directions: Record<string, [number, number][]> = {
    b: [[1, 1], [1, -1], [-1, 1], [-1, -1]],
    r: [[1, 0], [-1, 0], [0, 1], [0, -1]],
    q: [[1, 1], [1, -1], [-1, 1], [-1, -1], [1, 0], [-1, 0], [0, 1], [0, -1]],
  };
  let pin = false;
  let skewer = false;
  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const piece = board[r][f];
      if (!piece || piece.color !== me) continue;
      const dirs = directions[piece.type];
      if (!dirs) continue;
      for (const [dr, df] of dirs) {
        let rr = r + dr;
        let ff = f + df;
        let first: { type: string; value: number } | null = null;
        while (rr >= 0 && rr < 8 && ff >= 0 && ff < 8) {
          const sq = board[rr][ff];
          if (sq) {
            if (sq.color === me) break;
            if (!first) {
              first = { type: sq.type, value: sq.type === 'k' ? 100 : val(sq.type) };
            } else {
              const secondVal = sq.type === 'k' ? 100 : val(sq.type);
              if (sq.type === 'k' && first.type !== 'k') {
                pin = true;
              } else if (secondVal < first.value && first.type !== 'k') {
                skewer = true;
              }
              break;
            }
          }
          rr += dr;
          ff += df;
        }
      }
    }
  }
  return { pin, skewer };
}

/**
 * Detect back-rank pattern: the defender's king is on the back rank,
 * trapped behind its own pawns, with no escape square, and an enemy
 * heavy piece (R/Q) is (or will be) on or near that rank.
 */
function isBackRankWeak(fen: string): boolean {
  const c = loadSafe(fen);
  if (!c) return false;
  // Check both sides.
  for (const color of ['w', 'b'] as const) {
    const rank = color === 'w' ? '1' : '8';
    const pawnRank = color === 'w' ? '2' : '7';
    // Find king.
    const board = c.board();
    let kingFile = -1;
    let kingRank = -1;
    for (let r = 0; r < 8; r++) {
      for (let f = 0; f < 8; f++) {
        const p = board[r][f];
        if (p && p.type === 'k' && p.color === color) {
          kingFile = f;
          kingRank = 8 - r;
        }
      }
    }
    if (String(kingRank) !== rank) continue;
    // King must be blocked: squares above it (for white) all have own pawns.
    const up = color === 'w' ? 1 : -1;
    let blocked = true;
    for (const df of [-1, 0, 1]) {
      const nf = kingFile + df;
      if (nf < 0 || nf > 7) continue;
      const nrBoardIdx = 8 - (Number(rank) + up);
      if (nrBoardIdx < 0 || nrBoardIdx > 7) { blocked = false; break; }
      const above = board[nrBoardIdx][nf];
      if (df === 0) continue;
      if (!above || above.color !== color || above.type !== 'p') { blocked = false; break; }
    }
    if (!blocked) continue;
    void pawnRank;
    return true;
  }
  return false;
}

export interface DetectMotifsInput {
  fenBefore: string;
  fenAfter: string;
  playedUci: string;
  bestUci?: string;
  bestPvUci?: string[];
  /** Mover's winrate before the move (0-1). */
  winrateBefore: number;
  /** Mover's winrate after the move (0-1). */
  winrateAfter: number;
  /** Engine-reported mate from mover POV before the played move (positive = mover mating). */
  mateInBefore?: number;
  /** Engine-reported mate AFTER the played move (mover POV). */
  mateInAfter?: number;
}

/**
 * Heuristic motif detector. Given one mistake (blunder/mistake/miss/etc.)
 * in a game, tag it with as many motifs as apply. We look at:
 *
 *   - the played move: did it hang a piece? allow a fork/pin on the player?
 *   - the engine's best reply (the refutation the player missed): does it
 *     fork/pin/skewer/exploit a back rank? mate?
 *   - the opposite when the engine's best was the MISSED win: did the
 *     player miss a fork / mate / back-rank?
 */
export function detectMotifs(input: DetectMotifsInput): Motif[] {
  const motifs = new Set<Motif>();
  const {
    fenBefore,
    fenAfter,
    playedUci,
    bestUci,
    bestPvUci,
    winrateBefore,
    winrateAfter,
    mateInBefore,
    mateInAfter,
  } = input;

  // --- Played-move motifs -------------------------------------------------

  // Allowed mate: evaluation collapses to a mate on the opponent after the move.
  if (mateInAfter != null && mateInAfter < 0) motifs.add('allowedMate');

  // Hanging own piece after the move (player blundered material).
  if (leavesOwnPieceHanging(fenBefore, playedUci)) {
    motifs.add('hangingPiece');
    motifs.add('lostMaterial');
  }

  // Any opponent-side piece hanging after the move = tactical shot coming.
  const hung = hangingPieceAfter(fenAfter);
  if (hung && hung.value >= 3) motifs.add('hangingPiece');

  // Opponent now has a fork on our king/queen via their best reply?
  if (bestUci && bestUci.length >= 4) {
    const refutationTo = bestUci.slice(2, 4) as Square;
    // Simulate opponent playing their best move.
    const c = loadSafe(fenAfter);
    if (c) {
      const from = bestUci.slice(0, 2) as Square;
      try {
        const mv = c.move({ from, to: refutationTo, promotion: bestUci.slice(4, 5) || undefined });
        if (mv) {
          const afterRefutation = c.fen();
          if (isForkAt(afterRefutation, refutationTo)) motifs.add('fork');
          const ps = detectPinOrSkewer(afterRefutation);
          if (ps.pin) motifs.add('pin');
          if (ps.skewer) motifs.add('skewer');
          if (isBackRankWeak(afterRefutation)) motifs.add('backRank');
          c.undo();
        }
      } catch {
        // ignore
      }
    }
  }

  // --- Missed-win motifs --------------------------------------------------
  //
  // If the player failed to find a strong move, inspect the engine's PV
  // from fenBefore to see what they missed.
  const missedWin = winrateBefore - winrateAfter >= 0.1;
  if (missedWin) {
    // Missed mate sequence.
    if (mateInBefore != null && mateInBefore > 0) motifs.add('missedMate');

    const pv = bestPvUci && bestPvUci.length > 0 ? bestPvUci : bestUci ? [bestUci] : [];
    if (pv.length > 0) {
      const c = loadSafe(fenBefore);
      if (c) {
        // Play the engine's first move on a scratch board and look at
        // the resulting position.
        const first = pv[0];
        const from = first.slice(0, 2) as Square;
        const to = first.slice(2, 4) as Square;
        try {
          const mv = c.move({ from, to, promotion: first.slice(4, 5) || undefined });
          if (mv) {
            const afterBest = c.fen();
            if (isForkAt(afterBest, to)) motifs.add('missedFork');
            const ps = detectPinOrSkewer(afterBest);
            if (ps.pin) motifs.add('missedPin');
            if (ps.skewer) motifs.add('missedSkewer');
            if (isBackRankWeak(afterBest)) motifs.add('missedBackRank');
            // Deeper PV walk: play up to 3 more plies and re-check for hanging
            // gains, so we catch combinations.
            for (let i = 1; i < Math.min(pv.length, 4); i++) {
              const u = pv[i];
              if (!u || u.length < 4) break;
              try {
                const moved = c.move({
                  from: u.slice(0, 2),
                  to: u.slice(2, 4),
                  promotion: u.slice(4, 5) || undefined,
                });
                if (!moved) break;
              } catch {
                break;
              }
            }
            // If after the full line, opponent has a hanging piece = combo.
            const finalHung = hangingPieceAfter(c.fen());
            if (finalHung && finalHung.value >= 3) motifs.add('lostMaterial');
          }
        } catch {
          // ignore
        }
      }
    }
  }

  // King-in-trouble: if opponent has many attackers near our king and no
  // solid defenders, tag 'weakKing'.
  if (winrateBefore - winrateAfter >= 0.15 && isKingUnsafe(fenAfter)) {
    motifs.add('weakKing');
  }

  if (motifs.size === 0 && winrateBefore - winrateAfter >= 0.1) {
    motifs.add('other');
  }

  return Array.from(motifs);
}

/**
 * Cheap "king safety" heuristic: count squares adjacent to the mover-to-move
 * king that are attacked by the opponent.
 */
function isKingUnsafe(fen: string): boolean {
  const c = loadSafe(fen);
  if (!c) return false;
  const me = c.turn();
  const board = c.board();
  let kingFile = -1;
  let kingRankIdx = -1;
  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const p = board[r][f];
      if (p && p.type === 'k' && p.color === me) {
        kingFile = f;
        kingRankIdx = r;
      }
    }
  }
  if (kingFile < 0) return false;
  let attackedCount = 0;
  for (let dr = -1; dr <= 1; dr++) {
    for (let df = -1; df <= 1; df++) {
      if (dr === 0 && df === 0) continue;
      const nr = kingRankIdx + dr;
      const nf = kingFile + df;
      if (nr < 0 || nr > 7 || nf < 0 || nf > 7) continue;
      const sq = (String.fromCharCode(97 + nf) + (8 - nr)) as Square;
      const atks = attackersOf(c, sq, me === 'w' ? 'b' : 'w');
      if (atks.length > 0) attackedCount++;
    }
  }
  return attackedCount >= 3;
}

/**
 * UI-facing labels + short descriptions for each motif. Order roughly
 * from "biggest-deal" to "smallest-deal" so lists read naturally.
 */
export const MOTIF_LABEL: Record<Motif, string> = {
  missedMate: 'Missed mate',
  allowedMate: 'Allowed mate',
  missedFork: 'Missed fork',
  missedPin: 'Missed pin',
  missedSkewer: 'Missed skewer',
  missedBackRank: 'Missed back-rank',
  fork: 'Walked into a fork',
  pin: 'Walked into a pin',
  skewer: 'Walked into a skewer',
  backRank: 'Back-rank weakness',
  hangingPiece: 'Hanging piece',
  overloadedDefender: 'Overloaded defender',
  discoveredAttack: 'Discovered attack',
  trappedPiece: 'Trapped piece',
  weakKing: 'Weak king',
  lostMaterial: 'Lost material',
  other: 'Other',
};

export const MOTIF_ORDER: Motif[] = [
  'missedMate',
  'allowedMate',
  'missedFork',
  'missedPin',
  'missedSkewer',
  'missedBackRank',
  'fork',
  'pin',
  'skewer',
  'backRank',
  'hangingPiece',
  'trappedPiece',
  'overloadedDefender',
  'discoveredAttack',
  'weakKing',
  'lostMaterial',
  'other',
];

/**
 * Plain-English description of each motif. Surfaced in two places:
 *  - the weaknesses page's expanded mistake card ("This is a fork because
 *    the knight attacks two pieces at once…"),
 *  - the review page's "from weakness" banner when the user clicks
 *    through from a weakness example.
 *
 * Kept short — one sentence, study-flashcard register. Avoid jargon
 * the player wouldn't recognise from a beginner book.
 */
export const MOTIF_EXPLANATION: Record<Motif, string> = {
  missedMate:
    'There was a forced mate available — the engine sees a winning sequence that ends the game.',
  allowedMate:
    'This move walks into a forced mate — the opponent now has a sequence that ends the game.',
  missedFork:
    'A move was available that attacks two valuable pieces at once, so the opponent can\u2019t save both.',
  missedPin:
    'A piece could have been pinned against a more valuable one, freezing it in place.',
  missedSkewer:
    'A line attack on a valuable piece would have forced it to move, exposing the piece behind it.',
  missedBackRank:
    'The opponent\u2019s back rank was weak — a heavy piece could have delivered (or threatened) mate along the first/eighth rank.',
  fork: 'The opponent\u2019s reply attacks two of your pieces at once, and you can\u2019t save both.',
  pin:
    'Your piece is now pinned to a more valuable piece behind it — it can\u2019t move without losing material.',
  skewer:
    'A line attack now forces a valuable piece of yours to move, losing the piece behind it.',
  backRank:
    'Your king is stuck on the back rank with no escape squares — heavy pieces can mate along the first/eighth rank.',
  hangingPiece:
    'A piece is left undefended, attacked by more pieces than defend it. The opponent can take it for free.',
  trappedPiece:
    'A piece has no safe squares to move to — it will be lost on the next move.',
  overloadedDefender:
    'A defender is asked to do too many jobs at once — protecting it on one front leaves another open.',
  discoveredAttack:
    'Moving one piece uncovers an attack from a piece behind it.',
  weakKing:
    'Your king has lost its pawn cover and several attackers are converging — the position is unsafe.',
  lostMaterial:
    'The line ends with you down material — pieces drop without sufficient compensation.',
  other:
    'A significant evaluation drop without a clean tactical name attached.',
};



