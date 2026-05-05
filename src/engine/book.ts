/**
 * Set of FENs reachable from the openings library
 * (`src/data/openings.generated.ts`). Used to:
 *
 *   1) Skip Stockfish evaluation for moves where both endpoints are in
 *      book (analyzer fast-path), saving a large fraction of opening
 *      compute on every imported game.
 *   2) Classify any move whose before+after FENs are both book positions
 *      as `book`, regardless of whether the engine considers it #1
 *      (`classifyMove`). This is the *correct* semantic — a canonical
 *      theory move is "book" by definition; whether Stockfish would
 *      pick it as the absolute best is irrelevant.
 *
 * The set is built lazily on first access and reused for the lifetime
 * of the page. Build cost is a few hundred ms one-off; lookups are
 * O(1) afterwards.
 *
 * We strip the halfmove + fullmove counters from the FEN before
 * inserting/looking up so that transpositions and games imported with
 * slightly different counters still match the book.
 *
 * This module is intentionally a leaf: it only depends on `chess.js`
 * and the generated openings data, so `classify.ts` can import it
 * without pulling in Dexie / DB code.
 */

import { Chess } from 'chess.js';
import { OPENING_LINES } from '@/data/openings.generated';

/** First four FEN fields (placement, side, castling, en-passant) — all
 *  that determines whether two positions are equivalent for opening-book
 *  purposes. Defensive against missing/empty input: older `MoveEval`
 *  rows occasionally lack `fenAfter`, and we never want a malformed
 *  cell in the analyses table to crash the boot-time recompute pass. */
export function bookFenKey(fen: string | undefined | null): string {
  if (!fen || typeof fen !== 'string') return '';
  const parts = fen.split(' ');
  return parts.slice(0, 4).join(' ');
}

let _bookSet: Set<string> | null = null;

export function buildBookSet(): Set<string> {
  if (_bookSet) return _bookSet;
  const set = new Set<string>();
  // Initial position is always "in book".
  set.add(bookFenKey(new Chess().fen()));
  for (const line of OPENING_LINES) {
    const c = new Chess();
    for (const uci of line.uci) {
      const mv = c.move({
        from: uci.slice(0, 2),
        to: uci.slice(2, 4),
        promotion: uci.slice(4, 5) || undefined,
      });
      if (!mv) break;
      set.add(bookFenKey(c.fen()));
    }
  }
  _bookSet = set;
  return set;
}

export function isBookFen(fen: string | undefined | null): boolean {
  if (!fen) return false;
  const key = bookFenKey(fen);
  if (!key) return false;
  return buildBookSet().has(key);
}
