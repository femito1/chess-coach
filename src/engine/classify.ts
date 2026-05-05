import { Chess, type Square } from 'chess.js';
import type { Classification } from '@/db/schema';
import { isBookFen } from './book';

/**
 * Convert a centipawn evaluation (from the side-to-move perspective)
 * to a win probability in [0,1] for that side. Uses Lichess's logistic
 * formula (https://lichess.org/page/accuracy).
 */
export function cpToWinrate(cp: number): number {
  const clamped = Math.max(-1000, Math.min(1000, cp));
  const pct = 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * clamped)) - 1);
  return pct / 100;
}

/**
 * Per-move accuracy (0-100) from winrate loss (pp). Lichess formula.
 */
export function moveAccuracy(winrateLossPct: number): number {
  const loss = Math.max(0, winrateLossPct);
  const acc = 103.1668 * Math.exp(-0.04354 * loss) - 3.1669;
  return Math.max(0, Math.min(100, acc));
}

export function mateToCp(mate: number): number {
  if (mate === 0) return 0;
  return mate > 0 ? 10000 - mate : -10000 - mate;
}

const PIECE_VALUE: Record<string, number> = {
  p: 1,
  n: 3,
  b: 3,
  r: 5,
  q: 9,
  k: 0,
};

function pieceValue(type: string | undefined): number {
  if (!type) return 0;
  return PIECE_VALUE[type] ?? 0;
}

/**
 * List the cheapest *legal* attacker a given side has on `square` in the
 * current position. Pseudo-legal is tempting but we rely on chess.js's
 * `moves()` which filters pin/illegal-move edge cases for us.
 */
function cheapestAttackerMove(
  c: Chess,
  square: Square,
): { from: Square; piece: string; value: number } | null {
  let best: { from: Square; piece: string; value: number } | null = null;
  for (const m of c.moves({ verbose: true })) {
    if (m.to !== square) continue;
    // `c` flag = capture, `e` = en-passant. We only consider the square we
    // just landed on — en-passant can't recapture there.
    if (!m.flags.includes('c')) continue;
    const v = pieceValue(m.piece);
    if (!best || v < best.value) {
      best = { from: m.from as Square, piece: m.piece, value: v };
    }
  }
  return best;
}

/**
 * Static Exchange Evaluation on a single square.
 *
 * Returns the material gain for `c.turn()` from capturing on `square`,
 * assuming both sides play optimally (capture with the cheapest attacker
 * each ply, and either side may "stand pat" if the exchange would turn
 * unfavourable for them).
 *
 * Precondition: there is a piece on `square` belonging to the side NOT to
 * move; otherwise the result is 0.
 */
function see(c: Chess, square: Square): number {
  const target = c.get(square);
  if (!target) return 0;
  if (target.color === c.turn()) return 0; // can't capture own piece
  const targetValue = pieceValue(target.type);

  const attacker = cheapestAttackerMove(c, square);
  if (!attacker) return 0;

  // Perform the capture.
  const move = c.move({ from: attacker.from, to: square, promotion: 'q' });
  if (!move) return 0;

  // Recursively evaluate: opponent may choose to keep capturing, or stop.
  // Gain for the side we just moved for = targetValue - opponent's best reply.
  const reply = see(c, square);
  c.undo();
  // Standing pat: max(0, targetValue - reply) — we never have to recapture
  // if doing so would lose material.
  return Math.max(0, targetValue - reply);
}

/**
 * Net material swing for the mover after the played move, assuming both
 * sides play the exchange on `toSq` optimally. Positive = mover gained
 * material; negative = mover gave up material.
 *
 *   net = (value captured by played move)
 *       - (value opponent will win on `toSq` via optimal exchange)
 *
 * The second term is the opponent's SEE gain starting from the position
 * right after the played move. If SEE returns 0, the opponent "stands pat"
 * (no profitable recapture) and the played piece is effectively safe.
 */
function netMaterialSwing(
  fenBefore: string,
  uci: string,
): { net: number; exposedValue: number } | null {
  try {
    const c = new Chess();
    c.load(fenBefore);

    const fromSq = uci.slice(0, 2) as Square;
    const toSq = uci.slice(2, 4) as Square;
    const promotion = uci.slice(4, 5) || undefined;

    const target = c.get(toSq);
    const capturedValue = target ? pieceValue(target.type) : 0;

    const played = c.move({ from: fromSq, to: toSq, promotion });
    if (!played) return null;

    const pieceOnTo = c.get(toSq);
    if (!pieceOnTo) return null;
    const exposedValue = pieceValue(pieceOnTo.type);

    // Opponent's SEE gain on `toSq`.
    const oppGain = see(c, toSq);
    return { net: capturedValue - oppGain, exposedValue };
  } catch {
    return null;
  }
}

/**
 * Decide whether a given best move is a genuine *piece sacrifice*.
 *
 * Requirements (all must hold):
 *  - The moved piece is worth ≥ a minor (pawns & king don't qualify).
 *  - The move is NOT a recapture on the square the opponent just moved to.
 *  - After full static exchange evaluation on the destination square,
 *    the mover's net material swing is ≤ -2 (gave up at least a minor
 *    after all trades resolve).
 *
 * SEE correctly handles: defenders of the destination, multiple attackers,
 * and trades where the opponent wouldn't actually recapture.
 */
function isPieceSacrifice(fenBefore: string, uci: string, prevMoveTo?: string): boolean {
  try {
    const c = new Chess();
    c.load(fenBefore);

    const fromSq = uci.slice(0, 2) as Square;
    const toSq = uci.slice(2, 4) as Square;
    const movedPieceBefore = c.get(fromSq);
    if (!movedPieceBefore) return false;
    if (movedPieceBefore.type === 'p' || movedPieceBefore.type === 'k') return false;

    if (prevMoveTo && toSq === prevMoveTo) return false;

    const swing = netMaterialSwing(fenBefore, uci);
    if (!swing) return false;
    // Require the piece we're giving up to be at least a minor.
    if (swing.exposedValue < 3) return false;
    return swing.net <= -2;
  } catch {
    return false;
  }
}

/**
 * Is the mover currently in check AND has only one legal reply?
 * Forced moves can't be brilliant (no creativity involved).
 */
function isForcedMove(fenBefore: string): boolean {
  try {
    const c = new Chess();
    c.load(fenBefore);
    if (!c.inCheck()) return false;
    return c.moves().length <= 1;
  } catch {
    return false;
  }
}

export interface ClassifyInput {
  /** Winrate for the mover before the move (0-1). */
  moverWinrateBefore: number;
  /** Winrate for the mover after the move (0-1). */
  moverWinrateAfter: number;
  /** True if the played move is the engine's #1 choice. */
  isBest: boolean;
  /** 1-indexed ply of this move in the game. */
  ply: number;
  /** Whether the game has a recognized opening (ECO/Opening tag present). */
  inBookPhase: boolean;
  /** FEN before the move. */
  fenBefore: string;
  /** FEN after the move. Optional for backwards compat with older
   *  call-sites; supplying it enables FEN-based book detection (any
   *  move whose endpoints are both in the openings library is `book`,
   *  regardless of whether the engine considered it #1). */
  fenAfter?: string;
  /** UCI of the played move. */
  playedUci: string;
  /** Destination square of the previous move (for recapture detection). */
  prevMoveToSquare?: string;
}

/**
 * Classify a played move using Chess.com-style buckets:
 *   brilliant | best | excellent | good | book | inaccuracy | miss | mistake | blunder
 *
 * Ordering (top wins):
 *   1. book       — played the engine's #1 move early in a theory line
 *   2. brilliant  — best move AND a genuine piece sacrifice in a fighting position
 *   3. best       — any other engine #1 move
 *   4. non-best drop buckets: blunder → miss → mistake → inaccuracy → good → excellent
 *
 * "drop" means the mover's winrate loss (before → after), in [0, 1].
 */
export function classifyMove(input: ClassifyInput): Classification {
  const {
    moverWinrateBefore,
    moverWinrateAfter,
    isBest,
    ply,
    inBookPhase,
    fenBefore,
    fenAfter,
    playedUci,
    prevMoveToSquare,
  } = input;

  const drop = Math.max(0, moverWinrateBefore - moverWinrateAfter);

  // Book (FEN-based): if both the before and after positions are in the
  // openings library, the move is canonical theory by definition. This
  // takes precedence over the engine's top-move check because the
  // analyzer's fast path skips engine evaluation for fully-in-book
  // moves — `isBest` will be false for those, but they're still book.
  if (fenAfter && isBookFen(fenBefore) && isBookFen(fenAfter)) return 'book';

  // Book (engine-based, legacy): the player stayed on the engine's #1
  // move early in a recognized opening line. Kept as a fallback for
  // games whose openings aren't in the library.
  if (isBest && inBookPhase && ply <= 10) return 'book';

  if (isBest) {
    // Brilliant requires a lot of things to be true at once. These guards
    // exist because "best + sacrifice" alone over-triggers on:
    //   - forced only-moves,
    //   - positions that are already decisively winning (just "best"),
    //   - recaptures (trades, not sacs),
    //   - pawn sacs,
    //   - and routine equal trades where the SEE is ~0.
    const winningEnough = moverWinrateAfter >= 0.5;
    const notAlreadyCrushing = moverWinrateBefore < 0.85;
    if (
      winningEnough &&
      notAlreadyCrushing &&
      !isForcedMove(fenBefore) &&
      isPieceSacrifice(fenBefore, playedUci, prevMoveToSquare)
    ) {
      return 'brilliant';
    }
    return 'best';
  }

  // Non-best moves: bucket by winrate drop.
  //
  // "Miss" means: the mover had a clearly winning position and gave up the
  // win, but didn't play an outright losing move themselves. We require
  //   - a meaningful drop (≥ 10%),
  //   - the mover WAS clearly winning (≥ 80%),
  //   - the mover is no longer clearly winning (< 60%),
  //   - but the resulting position is not actually losing (≥ 40%).
  // Anything larger/worse is called a blunder instead.
  const wasWinning = moverWinrateBefore >= 0.8;
  const stillNotLosing = moverWinrateAfter >= 0.4;
  const noLongerWinning = moverWinrateAfter < 0.6;

  if (drop >= 0.2) {
    if (wasWinning && stillNotLosing && noLongerWinning) return 'miss';
    return 'blunder';
  }
  if (drop >= 0.1 && wasWinning && noLongerWinning) return 'miss';
  if (drop >= 0.1) return 'mistake';
  if (drop >= 0.05) return 'inaccuracy';
  if (drop >= 0.02) return 'good';
  return 'excellent';
}

export const CLASSIFICATION_SYMBOL: Record<Classification, string> = {
  brilliant: '!!',
  best: '★',
  excellent: '!',
  good: '✓',
  book: 'o',
  inaccuracy: '?!',
  miss: 'x',
  mistake: '?',
  blunder: '??',
};

export const CLASSIFICATION_LABEL: Record<Classification, string> = {
  brilliant: 'Brilliant',
  best: 'Best',
  excellent: 'Excellent',
  good: 'Good',
  book: 'Book',
  inaccuracy: 'Inaccuracy',
  miss: 'Miss',
  mistake: 'Mistake',
  blunder: 'Blunder',
};

/**
 * Ordering from best to worst, used for sorting / stat displays.
 */
export const CLASSIFICATION_ORDER: Classification[] = [
  'brilliant',
  'best',
  'excellent',
  'good',
  'book',
  'inaccuracy',
  'miss',
  'mistake',
  'blunder',
];
