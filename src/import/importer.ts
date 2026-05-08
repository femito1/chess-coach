import type { ChessComGame } from '@/api/chesscom';
import type { Game, GameResult } from '@/db/schema';

/**
 * FNV-1a 32-bit hash. Used to derive a deterministic, URL-stable
 * `Game.id` from the public chess.com game URL — the chrome extension
 * relies on this being predictable so it can deep-link to a game by
 * URL without first having to round-trip through an import. Exported
 * (rather than file-local) so callers that need the same id (e.g.
 * `importGameByUrl` in `src/features/import/auto.ts`) don't have to
 * re-implement the algorithm and silently drift.
 */
export function gameIdFromUrl(url: string): string {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < url.length; i++) {
    h ^= url.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

/** Pull a header tag value from a PGN string, e.g. `[ECO "C00"]` → `"C00"`. */
function pgnHeader(pgn: string, tag: string): string | undefined {
  const m = pgn.match(new RegExp(`\\[${tag}\\s+"([^"]*)"\\]`));
  return m?.[1];
}

/**
 * Convert a Chess.com ECO URL slug into a readable opening name.
 * `https://www.chess.com/openings/Sicilian-Defense-Najdorf-Variation-6.Be2`
 *   -> "Sicilian Defense: Najdorf Variation, 6.Be2"
 */
export function parseOpeningFromEcoUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const slug = url.split('/openings/')[1];
  if (!slug) return undefined;
  // Hyphens -> spaces, but keep the 3-dot move sequences intact.
  const decoded = decodeURIComponent(slug).replace(/-/g, ' ');
  // Chess.com slug convention: first two "words" are usually the opening family,
  // the rest are the variation. We'll simply replace the first hyphen-separated
  // word boundary with a colon for readability on the first known marker.
  const variationMarkers = ['Variation', 'Defense', 'Attack', 'Gambit', 'System', 'Opening'];
  for (const marker of variationMarkers) {
    const idx = decoded.indexOf(` ${marker} `);
    if (idx > 0) {
      return `${decoded.slice(0, idx + marker.length + 1)}: ${decoded.slice(idx + marker.length + 2)}`;
    }
  }
  return decoded;
}

function resultFromChessCom(
  userColor: 'white' | 'black',
  whiteResult: string,
  blackResult: string,
): GameResult {
  const userResult = userColor === 'white' ? whiteResult : blackResult;
  if (userResult === 'win') return 'win';
  if (
    ['checkmated', 'timeout', 'resigned', 'lose', 'abandoned', 'bughousepartnerlose'].includes(
      userResult,
    )
  ) {
    return 'loss';
  }
  if (
    [
      'agreed',
      'repetition',
      'stalemate',
      'insufficient',
      '50move',
      'timevsinsufficient',
      'draw',
    ].includes(userResult)
  ) {
    return 'draw';
  }
  return 'unknown';
}

/**
 * Given a stored PGN, re-derive opening/eco. Used to backfill games that were
 * imported before the importer was fixed to read PGN headers.
 */
export function reparseOpeningFromPgn(pgn: string): { opening?: string; eco?: string } | null {
  const eco = pgnHeader(pgn, 'ECO');
  const ecoUrl = pgnHeader(pgn, 'ECOUrl');
  const opening = pgnHeader(pgn, 'Opening') ?? parseOpeningFromEcoUrl(ecoUrl);
  if (!eco && !opening) return null;
  return { eco, opening };
}

export function chessComGameToGame(g: ChessComGame, username: string): Game {
  const lowered = username.toLowerCase();
  const userIsWhite = g.white.username.toLowerCase() === lowered;
  const userColor: 'white' | 'black' = userIsWhite ? 'white' : 'black';
  const opponent = userIsWhite ? g.black.username : g.white.username;
  const userRating = userIsWhite ? g.white.rating : g.black.rating;
  const opponentRating = userIsWhite ? g.black.rating : g.white.rating;

  // Chess.com's top-level `eco` field is actually the ECO URL. The real ECO
  // code and opening name are in the PGN headers.
  const ecoCode = pgnHeader(g.pgn, 'ECO');
  const ecoUrl = pgnHeader(g.pgn, 'ECOUrl') ?? (typeof g.eco === 'string' && g.eco.startsWith('http') ? g.eco : undefined);
  const openingName =
    pgnHeader(g.pgn, 'Opening') ?? parseOpeningFromEcoUrl(ecoUrl);

  return {
    id: gameIdFromUrl(g.url),
    url: g.url,
    source: 'chesscom',
    username,
    userColor,
    opponent,
    opponentRating,
    userRating,
    result: resultFromChessCom(userColor, g.white.result, g.black.result),
    timeControl: g.time_control,
    timeClass: g.time_class,
    endTime: g.end_time * 1000,
    opening: openingName,
    eco: ecoCode,
    pgn: g.pgn,
    fen: g.fen,
    importedAt: Date.now(),
    analysisStatus: 'pending',
  };
}
