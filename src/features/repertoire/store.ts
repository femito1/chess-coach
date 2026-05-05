import { Chess } from 'chess.js';
import {
  db,
  type Color,
  type Repertoire,
  type RepertoireCard,
  type RepertoireLineStats,
  type RepertoireNode,
} from '@/db/schema';
import { newSrsState } from '@/srs/sm2';
import { identifyOpening } from '@/features/openings/library';

/**
 * Normalize a FEN to a transposition-stable key: strip the halfmove clock
 * and fullmove number. Two FENs that only differ in those will have the
 * same key.
 */
export function fenKey(fen: string): string {
  const parts = fen.split(' ');
  return parts.slice(0, 4).join(' ');
}

export function nodeId(repertoireId: string, fen: string): string {
  return `${repertoireId}:${fenKey(fen)}`;
}

export function cardId(repertoireId: string, fen: string): string {
  return `${repertoireId}:${fenKey(fen)}`;
}

function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

export async function createRepertoire(input: {
  name: string;
  color: Color;
  description?: string;
}): Promise<Repertoire> {
  const now = Date.now();
  const rep: Repertoire = {
    id: uid(),
    name: input.name,
    color: input.color,
    description: input.description,
    createdAt: now,
    updatedAt: now,
  };
  await db.repertoires.put(rep);
  // Seed root node.
  const startFen = new Chess().fen();
  const root: RepertoireNode = {
    id: nodeId(rep.id, startFen),
    repertoireId: rep.id,
    fen: startFen,
    childFens: [],
    createdAt: now,
  };
  await db.repertoireNodes.put(root);
  return rep;
}

export async function deleteRepertoire(id: string): Promise<void> {
  await db.transaction(
    'rw',
    db.repertoires,
    db.repertoireNodes,
    db.repertoireCards,
    async () => {
      await db.repertoires.delete(id);
      const nodes = await db.repertoireNodes.where('repertoireId').equals(id).toArray();
      for (const n of nodes) await db.repertoireNodes.delete(n.id);
      const cards = await db.repertoireCards.where('repertoireId').equals(id).toArray();
      for (const c of cards) await db.repertoireCards.delete(c.id);
    },
  );
}

/**
 * Add a single move to a repertoire tree. If nodes along the way don't
 * exist, create them. For every position where the repertoire-owner is
 * TO MOVE, we also create an SRS card (so the user drills only their
 * own prep, not the opponent's moves).
 */
export async function addMove(
  repertoireId: string,
  parentFen: string,
  uci: string,
): Promise<RepertoireNode | null> {
  const rep = await db.repertoires.get(repertoireId);
  if (!rep) return null;

  const c = new Chess();
  try {
    c.load(parentFen);
  } catch {
    return null;
  }
  const mv = c.move({
    from: uci.slice(0, 2),
    to: uci.slice(2, 4),
    promotion: uci.slice(4, 5) || undefined,
  });
  if (!mv) return null;
  const childFen = c.fen();
  const now = Date.now();

  const parentId = nodeId(repertoireId, parentFen);
  const childId = nodeId(repertoireId, childFen);

  await db.transaction(
    'rw',
    db.repertoires,
    db.repertoireNodes,
    db.repertoireCards,
    async () => {
      const parent = await db.repertoireNodes.get(parentId);
      if (!parent) {
        // If the parent doesn't exist (e.g. PGN import went out of order),
        // synthesize a minimal parent node. Its own parent pointer will be
        // wrong, but children/look-ups still work.
        await db.repertoireNodes.put({
          id: parentId,
          repertoireId,
          fen: parentFen,
          childFens: [childFen],
          createdAt: now,
        });
      } else if (!parent.childFens.includes(childFen)) {
        parent.childFens.push(childFen);
        if (!parent.mainChildFen) parent.mainChildFen = childFen;
        await db.repertoireNodes.put(parent);
      }

      const existingChild = await db.repertoireNodes.get(childId);
      if (!existingChild) {
        await db.repertoireNodes.put({
          id: childId,
          repertoireId,
          fen: childFen,
          parentFen,
          moveUci: uci,
          moveSan: mv.san,
          childFens: [],
          createdAt: now,
        });
      }

      // SRS card: only for positions where the repertoire owner is TO MOVE
      // in PARENT position (so parent's turn == rep.color and this move is
      // the user's prep from that position).
      const parentTurn = parentFen.split(' ')[1] === 'w' ? 'white' : 'black';
      if (parentTurn === rep.color) {
        const cId = cardId(repertoireId, parentFen);
        const existing = await db.repertoireCards.get(cId);
        if (!existing) {
          await db.repertoireCards.put({
            id: cId,
            repertoireId,
            fen: parentFen,
            expectedUci: uci,
            srs: newSrsState(),
            createdAt: now,
          });
        }
      }
    },
  );

  await db.repertoires.update(repertoireId, { updatedAt: now });
  return (await db.repertoireNodes.get(childId)) ?? null;
}

/**
 * Import moves from a PGN string into a repertoire. Walks the mainline
 * and calls `addMove` for each. Variations are flattened into separate
 * lines sharing the same parent.
 */
export async function importPgn(repertoireId: string, pgn: string): Promise<number> {
  const c = new Chess();
  try {
    c.loadPgn(pgn);
  } catch {
    return 0;
  }
  const history = c.history({ verbose: true });
  const replay = new Chess();
  let count = 0;
  for (const mv of history) {
    const parentFen = replay.fen();
    const uci = mv.from + mv.to + (mv.promotion ?? '');
    await addMove(repertoireId, parentFen, uci);
    replay.move(mv.san);
    count++;
  }
  return count;
}

/**
 * Remove a node and (recursively) all of its descendants + their cards.
 * Leaves siblings intact and updates the parent's childFens.
 */
export async function deleteNode(
  repertoireId: string,
  fen: string,
): Promise<void> {
  const root = await db.repertoireNodes.get(nodeId(repertoireId, fen));
  if (!root) return;

  const toDelete: string[] = [];
  const stack: string[] = [fen];
  while (stack.length > 0) {
    const f = stack.pop()!;
    const n = await db.repertoireNodes.get(nodeId(repertoireId, f));
    if (!n) continue;
    toDelete.push(f);
    for (const child of n.childFens) stack.push(child);
  }

  await db.transaction('rw', db.repertoireNodes, db.repertoireCards, async () => {
    for (const f of toDelete) {
      await db.repertoireNodes.delete(nodeId(repertoireId, f));
      await db.repertoireCards.delete(cardId(repertoireId, f));
    }
    // Drop from parent's childFens.
    if (root.parentFen) {
      const parent = await db.repertoireNodes.get(nodeId(repertoireId, root.parentFen));
      if (parent) {
        parent.childFens = parent.childFens.filter((c) => c !== fen);
        if (parent.mainChildFen === fen) {
          parent.mainChildFen = parent.childFens[0];
        }
        await db.repertoireNodes.put(parent);
      }
    }
  });
}

export async function setNoteOnNode(
  repertoireId: string,
  fen: string,
  notes: string,
): Promise<void> {
  await db.repertoireNodes.update(nodeId(repertoireId, fen), { notes });
  await db.repertoires.update(repertoireId, { updatedAt: Date.now() });
}

/**
 * Return the immediate children of a node, sorted with mainChildFen first.
 */
export async function childrenOf(
  repertoireId: string,
  fen: string,
): Promise<RepertoireNode[]> {
  const node = await db.repertoireNodes.get(nodeId(repertoireId, fen));
  if (!node) return [];
  const children = await Promise.all(
    node.childFens.map((f) => db.repertoireNodes.get(nodeId(repertoireId, f))),
  );
  const filtered = children.filter((x): x is RepertoireNode => !!x);
  if (node.mainChildFen) {
    filtered.sort((a, b) => {
      if (a.fen === node.mainChildFen) return -1;
      if (b.fen === node.mainChildFen) return 1;
      return 0;
    });
  }
  return filtered;
}

/**
 * One root-to-leaf path through the repertoire tree. Used by the "play
 * through the whole line" trainer.
 */
export interface RepertoireLine {
  /** UCI moves from the start position. */
  uci: string[];
  /** SAN moves aligned with `uci`. */
  san: string[];
  /** FEN after each move; `fens[0]` is the starting FEN, `fens[i]` is the
   *  position AFTER move `i-1`. Length = uci.length + 1. */
  fens: string[];
  /** Display name: best effort. Falls back to first few SAN moves. */
  name: string;
}

/**
 * Enumerate every root-to-leaf path through a repertoire as a flat list
 * of lines. A "leaf" is any node with no children. We also emit a line at
 * each branching point so partial sub-lines aren't lost.
 *
 * Lines are sorted with the main line (following `mainChildFen` from the
 * root) first; the rest follow alphabetically by their first SAN.
 */
export async function enumerateLines(
  repertoireId: string,
): Promise<RepertoireLine[]> {
  const rep = await db.repertoires.get(repertoireId);
  if (!rep) return [];
  const allNodes = await db.repertoireNodes
    .where('repertoireId')
    .equals(repertoireId)
    .toArray();
  if (allNodes.length === 0) return [];
  const byFen = new Map<string, RepertoireNode>();
  for (const n of allNodes) byFen.set(n.fen, n);
  const startFen = new Chess().fen();
  const root = byFen.get(startFen);
  if (!root) return [];

  const lines: RepertoireLine[] = [];
  // DFS; emit a line whenever we hit a node with no children.
  function dfs(
    fen: string,
    uci: string[],
    san: string[],
    fens: string[],
  ): void {
    const node = byFen.get(fen);
    if (!node || node.childFens.length === 0) {
      if (uci.length === 0) return; // skip empty root
      lines.push({
        uci: [...uci],
        san: [...san],
        fens: [...fens],
        name: san.slice(0, 6).join(' ') + (san.length > 6 ? '…' : ''),
      });
      return;
    }
    // Order children: main child first.
    const ordered = [...node.childFens].sort((a, b) => {
      if (a === node.mainChildFen) return -1;
      if (b === node.mainChildFen) return 1;
      return 0;
    });
    for (const childFen of ordered) {
      const child = byFen.get(childFen);
      if (!child || !child.moveUci || !child.moveSan) continue;
      dfs(
        childFen,
        [...uci, child.moveUci],
        [...san, child.moveSan],
        [...fens, childFen],
      );
    }
  }
  dfs(startFen, [], [], [startFen]);

  // De-duplicate: identical move sequences can appear if a sub-tree was
  // imported twice. Key by joined UCI.
  const seen = new Set<string>();
  const unique: RepertoireLine[] = [];
  for (const l of lines) {
    const k = l.uci.join(' ');
    if (seen.has(k)) continue;
    seen.add(k);
    unique.push(l);
  }

  // Sort lexicographically by SAN sequence so related lines (same prefix)
  // sit next to each other in the trainer's queue. The DFS already pushed
  // main-children first, so the result begins with the canonical mainline.
  unique.sort((a, b) => {
    const min = Math.min(a.san.length, b.san.length);
    for (let i = 0; i < min; i++) {
      if (a.san[i] !== b.san[i]) return a.san[i].localeCompare(b.san[i]);
    }
    return a.san.length - b.san.length;
  });

  return unique;
}

export async function dueCards(repertoireId?: string): Promise<RepertoireCard[]> {
  const all = repertoireId
    ? await db.repertoireCards.where('repertoireId').equals(repertoireId).toArray()
    : await db.repertoireCards.toArray();
  const now = Date.now();
  return all.filter((c) => c.srs.dueAt <= now);
}

/* =======================================================================
 *  Per-line training stats
 * =======================================================================
 *
 *  Lines aren't first-class in the schema (we re-derive them on demand
 *  from the node tree). To track how many times each line is practiced,
 *  we key stats by `${repertoireId}:${ucisJoinedBySpace}`. That key is
 *  stable as long as the move sequence is — adding a new sub-line at the
 *  end keeps the parent line's key, so its history isn't lost.
 */

export function lineKey(uci: string[]): string {
  return uci.join(' ');
}

export function lineStatsId(repertoireId: string, uci: string[]): string {
  return `${repertoireId}:${lineKey(uci)}`;
}

/**
 * Read all stats for a repertoire keyed by line UCI key. Missing stats
 * are returned as fresh zeroed structures so the caller doesn't need to
 * thread `??` checks everywhere.
 */
export async function getLineStatsMap(
  repertoireId: string,
): Promise<Map<string, RepertoireLineStats>> {
  const rows = await db.repertoireLineStats
    .where('repertoireId')
    .equals(repertoireId)
    .toArray();
  const map = new Map<string, RepertoireLineStats>();
  for (const r of rows) map.set(r.uciKey, r);
  return map;
}

function emptyStats(
  repertoireId: string,
  line: RepertoireLine,
): RepertoireLineStats {
  const opening = identifyOpening(line.uci);
  return {
    id: lineStatsId(repertoireId, line.uci),
    repertoireId,
    uciKey: lineKey(line.uci),
    sanPreview: line.san.slice(0, 8).join(' '),
    family: opening?.family,
    attempts: 0,
    completions: 0,
    movesPlayed: 0,
    correctMoves: 0,
    wrongMoves: 0,
    perfectCompletions: 0,
    createdAt: Date.now(),
  };
}

async function getOrCreateStats(
  repertoireId: string,
  line: RepertoireLine,
): Promise<RepertoireLineStats> {
  const id = lineStatsId(repertoireId, line.uci);
  const existing = await db.repertoireLineStats.get(id);
  if (existing) return existing;
  const fresh = emptyStats(repertoireId, line);
  await db.repertoireLineStats.put(fresh);
  return fresh;
}

/**
 * Bump `attempts` and last-practiced timestamp. Called when the user
 * starts (or restarts) a line in the trainer.
 */
export async function recordLineAttempt(
  repertoireId: string,
  line: RepertoireLine,
): Promise<void> {
  const stats = await getOrCreateStats(repertoireId, line);
  stats.attempts += 1;
  stats.lastPracticedAt = Date.now();
  await db.repertoireLineStats.put(stats);
}

/**
 * Bump per-move counters. `correct` increments correctMoves, `wrong`
 * increments wrongMoves; `movesPlayed` always goes up by one. Called
 * once per user attempt at a single move.
 */
export async function recordLineMove(
  repertoireId: string,
  line: RepertoireLine,
  outcome: 'correct' | 'wrong',
): Promise<void> {
  const stats = await getOrCreateStats(repertoireId, line);
  stats.movesPlayed += 1;
  if (outcome === 'correct') stats.correctMoves += 1;
  else stats.wrongMoves += 1;
  stats.lastPracticedAt = Date.now();
  await db.repertoireLineStats.put(stats);
}

/**
 * Mark a line completed. `perfect` indicates whether the user reached the
 * final ply without a single wrong attempt or hint.
 */
export async function recordLineCompletion(
  repertoireId: string,
  line: RepertoireLine,
  perfect: boolean,
): Promise<void> {
  const stats = await getOrCreateStats(repertoireId, line);
  stats.completions += 1;
  if (perfect) stats.perfectCompletions += 1;
  stats.lastPracticedAt = Date.now();
  await db.repertoireLineStats.put(stats);
}

/**
 * Walk backwards from `fen` through the repertoire tree, following
 * `parentFen` pointers until we hit the root. Returns the UCI sequence
 * from the root down to (but NOT including) `fen`. Used to identify the
 * opening that a given card / position belongs to.
 *
 * Bounded at 200 hops to defend against accidental cycles in synthesized
 * parents (see `addMove`'s out-of-order branch).
 */
export async function uciPathToFen(
  repertoireId: string,
  fen: string,
): Promise<string[]> {
  const path: string[] = [];
  let cursor: string | undefined = fen;
  for (let i = 0; i < 200 && cursor; i++) {
    const node: RepertoireNode | undefined = await db.repertoireNodes.get(
      nodeId(repertoireId, cursor),
    );
    if (!node || !node.parentFen || !node.moveUci) break;
    path.push(node.moveUci);
    cursor = node.parentFen;
  }
  return path.reverse();
}

/**
 * Look up a repertoire node by position. Returns the first rep of the
 * right color that has this FEN.
 */
export async function findNodeByFen(
  fen: string,
  color: Color,
): Promise<RepertoireNode | null> {
  const key = fenKey(fen);
  const reps = await db.repertoires.where('color').equals(color).toArray();
  for (const r of reps) {
    const n = await db.repertoireNodes.get(nodeId(r.id, fen));
    if (n && fenKey(n.fen) === key) return n;
  }
  return null;
}
