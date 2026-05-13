/**
 * Pure UCI → SAN principal-variation formatter. Used by the engine
 * cockpit so the live PV reads as `Nf3 Nc6 Bb5 a6` instead of the raw
 * UCI `g1f3 b8c6 f1b5 a7a6`. Sits next to other engine helpers because
 * it depends on `chess.js` for legality + SAN rendering.
 *
 * Defensive: a malformed PV (illegal UCI, malformed FEN) doesn't throw
 * — we return what we successfully formatted up to the bad ply and
 * stop. Stockfish PVs are *usually* legal (they were generated from
 * the engine's own search) but we re-parse for two reasons:
 *
 *   1. FENs that fail Stockfish's internal legality checks aren't
 *      uncommon (e.g. a slightly malformed castling-rights field
 *      produced by an older importer) and we don't want one broken
 *      game to take the cockpit down.
 *   2. The cockpit can be rendering an info line whose PV was
 *      truncated mid-line by the next info update — chess.js will
 *      reject the truncated tail cleanly.
 *
 * The function takes a *starting* FEN (the position currently being
 * analyzed) and a list of UCIs. Returns SAN strings, parallel-indexed
 * to the input.
 */

import { Chess } from 'chess.js';

export interface PvFormatResult {
  /** SANs successfully parsed from the input UCIs. May be shorter than
   *  the input if a UCI was illegal (defensive bail). */
  sans: string[];
  /** Count of UCIs that couldn't be replayed. >0 means the PV was
   *  truncated; usually a transient cockpit-rendering condition. */
  invalid: number;
}

export function formatPv(startFen: string, uciPv: string[]): PvFormatResult {
  if (uciPv.length === 0) {
    return { sans: [], invalid: 0 };
  }
  let chess: Chess;
  try {
    chess = new Chess(startFen);
  } catch {
    // Malformed start FEN: treat the whole PV as invalid rather than
    // throwing. The cockpit will render a fallback "thinking…" string.
    return { sans: [], invalid: uciPv.length };
  }
  const sans: string[] = [];
  let invalid = 0;
  for (const uci of uciPv) {
    if (uci.length < 4) {
      invalid += 1;
      break;
    }
    const from = uci.slice(0, 2);
    const to = uci.slice(2, 4);
    const promotion = uci.length >= 5 ? uci.slice(4, 5) : undefined;
    try {
      const m = chess.move({ from, to, promotion });
      if (!m) {
        invalid += 1;
        break;
      }
      sans.push(m.san);
    } catch {
      invalid += 1;
      break;
    }
  }
  return { sans, invalid };
}

/**
 * Render a SAN PV with chess move numbers, e.g.
 *
 *     formatPvLine('… some FEN with Black to move', ['e7e5', 'g1f3', 'b8c6'])
 *     // → '12... e5 13. Nf3 Nc6'
 *
 * Move numbers are derived from the FEN's halfmove counter so the
 * display agrees with the move list on the review page. This is the
 * format the cockpit's PV ribbon renders.
 */
export function formatPvLine(startFen: string, uciPv: string[]): string {
  const { sans } = formatPv(startFen, uciPv);
  if (sans.length === 0) return '';
  // FEN: "<board> <stm> <castling> <ep> <halfmove> <fullmove>"
  const parts = startFen.split(' ');
  const stm: 'w' | 'b' = parts[1] === 'b' ? 'b' : 'w';
  const fullMoveNum = Number(parts[5] ?? '1') || 1;
  const tokens: string[] = [];
  let plyIdx = 0;
  let move = fullMoveNum;
  let nextIsWhite = stm === 'w';
  while (plyIdx < sans.length) {
    if (nextIsWhite) {
      tokens.push(`${move}. ${sans[plyIdx]}`);
    } else {
      // Black-to-move start: emit the elision `12... e5` for the
      // first black ply, then continue with paired numbering.
      if (plyIdx === 0) {
        tokens.push(`${move}... ${sans[plyIdx]}`);
      } else {
        tokens.push(sans[plyIdx]);
      }
    }
    if (!nextIsWhite) move += 1;
    nextIsWhite = !nextIsWhite;
    plyIdx += 1;
  }
  return tokens.join(' ');
}
