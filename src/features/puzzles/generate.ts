import { Chess } from 'chess.js';
import { db, type Analysis, type Game, type Puzzle, type Motif } from '@/db/schema';

/**
 * Pick moves that are good puzzle sources: the player made a mistake in a
 * position where the engine's top line gains at least `minSwingCp`
 * centipawns AND has at least 2 plies of PV (so there's a real solution
 * to solve, not just "recapture").
 */
export function selectPuzzleCandidates(
  game: Game,
  analysis: Analysis,
  minSwingCp: number,
): Array<{ ply: number; motifs: Motif[] }> {
  const candidates: Array<{ ply: number; motifs: Motif[] }> = [];
  for (const m of analysis.moves) {
    const moverColor = m.ply % 2 === 1 ? 'white' : 'black';
    if (moverColor !== game.userColor) continue;
    if (m.classification !== 'blunder' && m.classification !== 'mistake' && m.classification !== 'miss') {
      continue;
    }
    if (!m.bestPvUci || m.bestPvUci.length < 1) continue;
    const swing = Math.abs((m.evalCpBefore ?? 0) - (m.evalCpAfter ?? 0));
    if (swing < minSwingCp) continue;
    // Only keep puzzles where the player HAD a winning (or near-winning)
    // continuation. evalCpBefore is from white POV; flip for black mover.
    const moverCpBefore = moverColor === 'white' ? m.evalCpBefore : -m.evalCpBefore;
    if (moverCpBefore < 50 && m.mateInBefore == null) continue;
    candidates.push({ ply: m.ply, motifs: m.motifs ?? [] });
  }
  return candidates;
}

/**
 * Build a Puzzle record from a mistake in a game. The "solution" is the
 * engine's stored PV at that position. If the PV is shorter than 3 plies
 * we still keep it (one-move tactical shot). We also compute a SAN version.
 */
export function buildPuzzle(
  game: Game,
  analysis: Analysis,
  ply: number,
  motifs: Motif[],
): Puzzle | null {
  const idx = ply - 1;
  const m = analysis.moves[idx];
  if (!m || !m.bestPvUci || m.bestPvUci.length === 0) return null;

  // Compute solution SAN by playing the UCI PV from fenBefore.
  const solutionUci = m.bestPvUci.slice(0, 8); // cap at 4 full moves
  const solutionSan: string[] = [];
  const c = new Chess();
  try {
    c.load(m.fenBefore);
    for (const u of solutionUci) {
      const move = c.move({
        from: u.slice(0, 2),
        to: u.slice(2, 4),
        promotion: u.slice(4, 5) || undefined,
      });
      if (!move) break;
      solutionSan.push(move.san);
    }
  } catch {
    return null;
  }
  if (solutionSan.length === 0) return null;

  const moverColor = m.ply % 2 === 1 ? 'white' : 'black';
  const moverCpBefore = moverColor === 'white' ? m.evalCpBefore : -m.evalCpBefore;
  const moverCpAfter = moverColor === 'white' ? m.evalCpAfter : -m.evalCpAfter;
  const swingCp = moverCpBefore - moverCpAfter;

  const tags: string[] = [`from-${m.classification}`];
  if (m.phase) tags.push(`phase-${m.phase}`);

  return {
    id: `${game.id}:${ply}`,
    gameId: game.id,
    ply,
    fen: m.fenBefore,
    solutionUci: solutionUci.slice(0, solutionSan.length),
    solutionSan,
    swingCp,
    motifs,
    generatedAt: Date.now(),
    tags,
    gameUrl: game.url,
    opponent: game.opponent,
    timeClass: game.timeClass,
  };
}

/**
 * Walk all analyzed games and (re)generate puzzles. Idempotent: the
 * puzzle id `${gameId}:${ply}` dedups identical sources. Returns number
 * of new puzzles added.
 */
export async function regeneratePuzzles(minSwingCp: number): Promise<number> {
  const games = await db.games
    .where('analysisStatus')
    .equals('done')
    .toArray();
  const gameById = new Map(games.map((g) => [g.id, g]));
  const existingPuzzles = await db.puzzles.toArray();
  const existing = new Set(existingPuzzles.map((p) => p.id));

  // Backfill: older puzzles saved before we denormalized timeClass/opponent.
  // Cheap to do here so the filter UI works immediately after upgrading.
  for (const p of existingPuzzles) {
    if (p.timeClass) continue;
    const g = gameById.get(p.gameId);
    if (!g) continue;
    await db.puzzles.update(p.id, {
      timeClass: g.timeClass,
      opponent: p.opponent ?? g.opponent,
      gameUrl: p.gameUrl ?? g.url,
    });
  }

  let added = 0;
  for (const g of games) {
    const a = await db.analyses.get(g.id);
    if (!a) continue;
    const candidates = selectPuzzleCandidates(g, a, minSwingCp);
    for (const c of candidates) {
      const id = `${g.id}:${c.ply}`;
      if (existing.has(id)) continue;
      const puzzle = buildPuzzle(g, a, c.ply, c.motifs);
      if (!puzzle) continue;
      await db.puzzles.put(puzzle);
      added++;
    }
  }
  return added;
}
