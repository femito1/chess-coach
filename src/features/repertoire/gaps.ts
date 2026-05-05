import { Chess } from 'chess.js';
import { db, type Color } from '@/db/schema';
import { nodeId } from './store';

export interface Gap {
  /** SAN moves from the start of the game, up to (but not including) the
   *  first move not in the repertoire. */
  pathSan: string[];
  /** The opponent move that walked off your prep. SAN. */
  missingSan: string;
  /** How many of the user's games reach this exact out-of-book point. */
  frequency: number;
}

export interface GapsResult {
  totalGames: number;
  lines: Gap[];
}

/**
 * Walk each of the user's games against a repertoire tree. For each game:
 *   - replay the PGN; at every position where OPPONENT is to move, check
 *     the repertoire (via the node for that FEN).
 *   - if the repertoire has children but none matches the opponent's move,
 *     that's a gap. Stop walking (deeper positions are, by definition, also
 *     out of book).
 *
 * Gaps are aggregated by (path, missingSan) so recurring opponent
 * responses we haven't prepped surface to the top.
 */
export async function analyzeGaps(opts: {
  repertoireId: string;
  rootFen: string;
  color: Color;
}): Promise<GapsResult> {
  const { repertoireId, color } = opts;

  const games = await db.games
    .where('analysisStatus')
    .equals('done')
    .toArray();

  const userGames = games.filter((g) => g.userColor === color);

  const gapMap = new Map<string, { pathSan: string[]; missingSan: string; frequency: number }>();

  for (const g of userGames) {
    const c = new Chess();
    try {
      c.loadPgn(g.pgn);
    } catch {
      continue;
    }
    const history = c.history({ verbose: true });
    const replay = new Chess();
    const pathSan: string[] = [];
    for (const mv of history) {
      const fenBefore = replay.fen();
      const turn = fenBefore.split(' ')[1] === 'w' ? 'white' : 'black';
      const sanOfMove = mv.san;
      if (turn === color) {
        // Our move: advance silently.
        replay.move(mv.san);
        pathSan.push(mv.san);
        continue;
      }
      // Opponent's move: check repertoire.
      const parentNode = await db.repertoireNodes.get(nodeId(repertoireId, fenBefore));
      if (!parentNode || parentNode.childFens.length === 0) {
        // We don't have prep this deep yet. Still record once per position.
        if (pathSan.length > 0) {
          const key = `${pathSan.join(' ')}||${sanOfMove}`;
          const existing = gapMap.get(key);
          if (existing) existing.frequency++;
          else gapMap.set(key, { pathSan: [...pathSan], missingSan: sanOfMove, frequency: 1 });
        }
        break;
      }
      // Compute the FEN that WOULD result from opponent's move and see if
      // it's a child.
      const scratch = new Chess();
      scratch.load(fenBefore);
      const moved = scratch.move({ from: mv.from, to: mv.to, promotion: mv.promotion });
      if (!moved) break;
      const resultingFen = scratch.fen();
      const inBook = parentNode.childFens.some((f) => f === resultingFen);
      if (!inBook) {
        const key = `${pathSan.join(' ')}||${sanOfMove}`;
        const existing = gapMap.get(key);
        if (existing) existing.frequency++;
        else gapMap.set(key, { pathSan: [...pathSan], missingSan: sanOfMove, frequency: 1 });
        break;
      }
      replay.move(mv.san);
      pathSan.push(mv.san);
    }
  }

  return {
    totalGames: userGames.length,
    lines: Array.from(gapMap.values()).sort((a, b) => b.frequency - a.frequency),
  };
}
