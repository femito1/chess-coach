import { Chess } from 'chess.js';
import type { Phase } from '@/db/schema';

/**
 * Classify a position's phase from a FEN.
 *
 * Rules (tuned to match typical engine reports, not a strict standard):
 *   - Endgame if both sides have <= 13 points of non-pawn non-king material,
 *     OR queens are off AND both sides have <= 17 points.
 *   - Opening for the first 10 full moves (20 plies), unless we've already
 *     dropped into endgame material levels.
 *   - Otherwise middlegame.
 */
const NON_KP_VALUE: Record<string, number> = {
  n: 3,
  b: 3,
  r: 5,
  q: 9,
};

export function detectPhase(fen: string): Phase {
  try {
    const c = new Chess();
    c.load(fen);
    const board = c.board();
    let whiteMat = 0;
    let blackMat = 0;
    let whiteQueens = 0;
    let blackQueens = 0;
    for (const row of board) {
      for (const piece of row) {
        if (!piece) continue;
        const val = NON_KP_VALUE[piece.type] ?? 0;
        if (piece.color === 'w') whiteMat += val;
        else blackMat += val;
        if (piece.type === 'q') {
          if (piece.color === 'w') whiteQueens++;
          else blackQueens++;
        }
      }
    }
    const queensOff = whiteQueens === 0 && blackQueens === 0;
    const fullmove = Number(fen.split(' ')[5] ?? '1') || 1;

    const isEndgame =
      (whiteMat <= 13 && blackMat <= 13) ||
      (queensOff && whiteMat <= 17 && blackMat <= 17);
    if (isEndgame) return 'endgame';
    if (fullmove <= 10) return 'opening';
    return 'middlegame';
  } catch {
    return 'middlegame';
  }
}

/**
 * Extract per-ply remaining clocks from a PGN, in seconds. Chess.com PGNs
 * embed `{[%clk H:MM:SS]}` after each move. The returned array is aligned
 * with ply indices (index i = clock after ply i+1).
 */
export function extractClocks(pgn: string): (number | undefined)[] {
  const clocks: (number | undefined)[] = [];
  const re = /\{\[%clk\s+([0-9:.]+)\]\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(pgn)) !== null) {
    clocks.push(parseClock(m[1]));
  }
  return clocks;
}

function parseClock(s: string): number | undefined {
  const parts = s.split(':').map((x) => Number(x));
  if (parts.some((n) => Number.isNaN(n))) return undefined;
  let seconds = 0;
  if (parts.length === 3) seconds = parts[0] * 3600 + parts[1] * 60 + parts[2];
  else if (parts.length === 2) seconds = parts[0] * 60 + parts[1];
  else if (parts.length === 1) seconds = parts[0];
  return seconds;
}

/**
 * Derive per-move time-spent from a list of remaining clocks. We compute
 * each player's "time used on this move" = (their clock before) - (their
 * clock after). For the first move of each color we fall back to the
 * base time guess from `baseSeconds`.
 */
export function deriveTimeSpent(
  clocks: (number | undefined)[],
  baseSeconds?: number,
): (number | undefined)[] {
  const out: (number | undefined)[] = [];
  for (let i = 0; i < clocks.length; i++) {
    const curr = clocks[i];
    if (curr == null) {
      out.push(undefined);
      continue;
    }
    // Previous clock for THIS color is two plies earlier.
    const prev = i >= 2 ? clocks[i - 2] : baseSeconds;
    if (prev == null) {
      out.push(undefined);
    } else {
      const delta = Math.max(0, prev - curr);
      out.push(delta);
    }
  }
  return out;
}

/**
 * Parse `TimeControl` header (e.g. `"600+5"`, `"180"`) into base seconds.
 */
export function baseSecondsFromTimeControl(tc: string | undefined): number | undefined {
  if (!tc) return undefined;
  const main = tc.split('+')[0];
  const n = Number(main);
  return Number.isFinite(n) ? n : undefined;
}
