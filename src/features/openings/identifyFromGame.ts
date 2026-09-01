import { Chess } from 'chess.js';
import { db } from '@/db/schema';
import { identifyOpeningLine } from './library';

/**
 * Identify an opening from a game's *moves* rather than its name.
 *
 * The fallback for when `resolveOpeningFamily` returns null. That happens when
 * the two datasets disagree on the name itself rather than on punctuation:
 * Chess.com's ECO slug says "King's Fianchetto Opening" for 1.g3 where the
 * bundled Lichess data says "Hungarian Opening". They share no prefix, so no
 * amount of key-folding connects them, and the affected rows silently lose
 * their link to the library.
 *
 * Moves have no such problem, and this generalises: it fixes every present and
 * future naming divergence rather than the ones someone thought to enumerate in
 * an alias table.
 *
 * Costs one PGN read per call, so callers should only reach for it on the rows
 * that failed to resolve by name — never as the primary path.
 */

/** A game's moves as UCI, or null if the PGN won't parse. */
export function uciFromPgn(pgn: string): string[] | null {
  try {
    const chess = new Chess();
    chess.loadPgn(pgn);
    const uci = chess
      .history({ verbose: true })
      .map((move) => move.from + move.to + (move.promotion ?? ''));
    return uci.length > 0 ? uci : null;
  } catch {
    // A malformed historical PGN should never break a caller's render.
    return null;
  }
}

/**
 * The canonical library family for a game, derived from its moves. Null when
 * the game is missing, its PGN won't parse, or the library covers nothing in
 * it — all cases where the honest answer is "no idea", not a guess.
 */
export async function familyFromGameMoves(gameId: string): Promise<string | null> {
  const game = await db.games.get(gameId);
  if (!game?.pgn) return null;
  const uci = uciFromPgn(game.pgn);
  if (!uci) return null;
  return identifyOpeningLine(uci)?.family ?? null;
}

/**
 * Resolve several game-derived family names at once, given one sample game id
 * apiece. Returns only the ones that resolved, so a caller can treat a missing
 * key as "still unknown".
 */
export async function familiesFromGameMoves(
  samples: ReadonlyArray<{ family: string; sampleGameId: string }>,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const { family, sampleGameId } of samples) {
    const resolved = await familyFromGameMoves(sampleGameId);
    if (resolved) out.set(family, resolved);
  }
  return out;
}
