import { Chess } from 'chess.js';
import {
  db,
  type Color,
  type Repertoire,
  type RepertoireCard,
  type RepertoireKind,
  type RepertoireLineStats,
  type RepertoireNode,
} from '@/db/schema';
import { newSrsState } from '@/srs/sm2';
import { identifyOpening, isLibraryLinePrefix } from '@/features/openings/library';
import {
  enumerateLinesFromNodes,
  fenKey,
  movesFrom,
  planAddMove,
  reachedPaths,
  type RepertoireLine,
} from './lineTree';

/**
 * Normalize a FEN to a transposition-stable key: strip the halfmove clock
 * and fullmove number. Two FENs that only differ in those will have the
 * same key. Every lookup of a stored `childFens`/`parentFen`/`mainChildFen`
 * entry must go through it — see `lineTree.ts` for what a full-FEN lookup
 * silently drops.
 */
export { fenKey };

const START_FEN = new Chess().fen();

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
  /** `'family'` (default) for repertoires bound to a single openings-
   *  library family; `'custom'` for the legacy free-form bucket. */
  kind?: RepertoireKind;
  /** Required when `kind === 'family'`; ignored otherwise. */
  family?: string;
}): Promise<Repertoire> {
  const now = Date.now();
  const kind: RepertoireKind = input.kind ?? 'family';
  const family = kind === 'family' ? input.family : undefined;
  const rep: Repertoire = {
    id: uid(),
    name: input.name,
    color: input.color,
    description: input.description,
    kind,
    family,
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
    // The root's path is the empty sequence; its presence also marks the
    // repertoire as recording move orders (see `upgradeLegacyPaths`).
    paths: [''],
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
    db.repertoireLineStats,
    async () => {
      await db.repertoires.delete(id);
      await db.repertoireNodes.where('repertoireId').equals(id).delete();
      await db.repertoireCards.where('repertoireId').equals(id).delete();
      // Repertoire ids are never reused, so stats left behind are dead
      // weight that every cloud sync still reads (it loads the whole table
      // and discards orphans) — and that would never be cleaned up.
      await db.repertoireLineStats.where('repertoireId').equals(id).delete();
    },
  );
}

/**
 * Add a single move to a repertoire tree. If nodes along the way don't
 * exist, create them. For every position where the repertoire-owner is
 * TO MOVE, we also create an SRS card (so the user drills only their
 * own prep, not the opponent's moves).
 *
 * `pathToParent` is the UCI sequence from the start position that reached
 * `parentFen` — the move order this move is being added in. It is recorded
 * on the child (`RepertoireNode.paths`) so a move added after a
 * transposition is drilled in the move order it was added in, not in every
 * move order that reaches the same position. Line-adding callers always
 * know it; when omitted, the move is added under every move order already
 * recorded for the parent (a move "at this position", however reached).
 */
export async function addMove(
  repertoireId: string,
  parentFen: string,
  uci: string,
  pathToParent?: readonly string[],
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

  await upgradeLegacyPaths(repertoireId);

  const parentId = nodeId(repertoireId, parentFen);
  const childId = nodeId(repertoireId, childFen);
  const parentPathKey = pathToParent ? pathToParent.join(' ') : undefined;

  await db.transaction(
    'rw',
    db.repertoires,
    db.repertoireNodes,
    db.repertoireCards,
    async () => {
      const writes = planAddMove({
        repertoireId,
        parentId,
        childId,
        parentFen,
        childFen,
        uci,
        san: mv.san,
        parentPathKey,
        now,
        parent: await db.repertoireNodes.get(parentId),
        child: await db.repertoireNodes.get(childId),
      });
      if (writes.length > 0) await db.repertoireNodes.bulkPut(writes);

      // SRS card: only for positions where the repertoire owner is TO MOVE
      // in PARENT position (so parent's turn == rep.color and this move is
      // the user's prep from that position). One card per position: a
      // second repertoire move from here is accepted by the trainer via the
      // node's children (`repertoireMovesAt`), not by a second card.
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
 * One-time upgrade of a repertoire written before nodes recorded their
 * move orders (`RepertoireNode.paths`). The root carries `paths` from
 * creation on, so its absence marks a legacy tree.
 *
 * Must run before the first recorded write: once a node has `paths`, the
 * line walk trusts them exactly, so recording only the NEW move order on a
 * legacy node would hide every old line through it. Writing what the
 * read-time fallback already shows (`reachedPaths`) keeps the drill list
 * unchanged by the upgrade itself.
 */
async function upgradeLegacyPaths(repertoireId: string): Promise<void> {
  const root = await db.repertoireNodes.get(nodeId(repertoireId, START_FEN));
  if (!root || root.paths) return;
  await db.transaction('rw', db.repertoireNodes, async () => {
    const nodes = await db.repertoireNodes
      .where('repertoireId')
      .equals(repertoireId)
      .toArray();
    const reached = reachedPaths(nodes, START_FEN, isLibraryLinePrefix);
    const updated: RepertoireNode[] = [];
    for (const n of nodes) {
      const found = reached.get(n.id);
      if (!found) continue;
      const paths = [...(n.paths ?? [])];
      for (const p of found) if (!paths.includes(p)) paths.push(p);
      updated.push({ ...n, paths });
    }
    // The root is always reached, which is what marks the upgrade done.
    await db.repertoireNodes.bulkPut(updated);
  });
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
  const path: string[] = [];
  for (const mv of history) {
    const parentFen = replay.fen();
    const uci = mv.from + mv.to + (mv.promotion ?? '');
    await addMove(repertoireId, parentFen, uci, path);
    replay.move(mv.san);
    path.push(uci);
    count++;
  }
  return count;
}

/**
 * Remove a position and every line through it, with their cards.
 *
 * Positions are shared between move orders, so "everything below" is not a
 * subtree walk: a descendant that some other move order also reaches
 * survives, minus the move orders that ran through the deleted position.
 * Every node that pointed at a removed one is cleaned — a transposed
 * position has more than one parent — and a card whose expected move led
 * into the removed position is repointed at a remaining repertoire move
 * there, or dropped when none is left.
 */
export async function deleteNode(
  repertoireId: string,
  fen: string,
): Promise<void> {
  await upgradeLegacyPaths(repertoireId);
  await db.transaction('rw', db.repertoireNodes, db.repertoireCards, async () => {
    const nodes = await db.repertoireNodes
      .where('repertoireId')
      .equals(repertoireId)
      .toArray();
    const targetId = nodeId(repertoireId, fen);
    const target = nodes.find((n) => n.id === targetId);
    if (!target) return;

    const cut = target.paths ?? [];
    // `''` is the root's path, which every move order runs through.
    const runsThrough = (p: string) =>
      cut.some((t) => t === '' || p === t || p.startsWith(`${t} `));
    const doomed = new Set<string>([targetId]);
    for (const n of nodes) {
      if (n.paths && n.paths.length > 0 && n.paths.every(runsThrough)) doomed.add(n.id);
    }
    // Nodes no move order reaches (none recorded) can only be found by
    // walking down from the target.
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const stack = [target];
    while (stack.length > 0) {
      const n = stack.pop()!;
      for (const f of n.childFens) {
        const child = byId.get(nodeId(repertoireId, f));
        if (child && !child.paths?.length && !doomed.has(child.id)) {
          doomed.add(child.id);
          stack.push(child);
        }
      }
    }

    const survivors = new Map<string, RepertoireNode>();
    const trimmed: RepertoireNode[] = [];
    for (const n of nodes) {
      if (doomed.has(n.id)) continue;
      const childFens = n.childFens.filter((f) => !doomed.has(nodeId(repertoireId, f)));
      const paths = n.paths?.filter((p) => !runsThrough(p));
      const lostChild = childFens.length !== n.childFens.length;
      const next: RepertoireNode = { ...n, childFens };
      if (paths) next.paths = paths;
      if (n.mainChildFen && doomed.has(nodeId(repertoireId, n.mainChildFen))) {
        next.mainChildFen = childFens[0];
      }
      survivors.set(fenKey(n.fen), next);
      if (lostChild || paths?.length !== n.paths?.length) trimmed.push(next);
    }

    for (const id of doomed) {
      await db.repertoireNodes.delete(id);
      await db.repertoireCards.delete(id); // card ids share the node-id shape
    }
    for (const n of trimmed) {
      await db.repertoireNodes.put(n);
      const card = await db.repertoireCards.get(cardId(repertoireId, n.fen));
      if (!card) continue;
      const remaining = movesFrom(n, survivors);
      if (remaining.includes(card.expectedUci)) continue;
      if (remaining.length > 0) {
        await db.repertoireCards.update(card.id, { expectedUci: remaining[0] });
      } else {
        await db.repertoireCards.delete(card.id);
      }
    }
  });
  await db.repertoires.update(repertoireId, { updatedAt: Date.now() });
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
  // By key: older rows can list one child twice, under two move orders'
  // counters.
  const ids = [...new Set(node.childFens.map((f) => nodeId(repertoireId, f)))];
  const children = await Promise.all(ids.map((id) => db.repertoireNodes.get(id)));
  const filtered = children.filter((x): x is RepertoireNode => !!x);
  if (node.mainChildFen) {
    const mainKey = fenKey(node.mainChildFen);
    filtered.sort((a, b) => {
      if (fenKey(a.fen) === mainKey) return -1;
      if (fenKey(b.fen) === mainKey) return 1;
      return 0;
    });
  }
  return filtered;
}

/**
 * Every repertoire move from `fen`, however the position was reached. The
 * SRS card for a position stores one `expectedUci` (the first move added
 * there), but at a branch point every one of these is the user's prep and
 * must be graded correct.
 */
export async function repertoireMovesAt(
  repertoireId: string,
  fen: string,
): Promise<string[]> {
  const node = await db.repertoireNodes.get(nodeId(repertoireId, fen));
  if (!node) return [];
  const ids = [...new Set(node.childFens.map((f) => nodeId(repertoireId, f)))];
  const children = await Promise.all(ids.map((id) => db.repertoireNodes.get(id)));
  const byKey = new Map<string, RepertoireNode>();
  for (const c of children) if (c) byKey.set(fenKey(c.fen), c);
  return movesFrom(node, byKey);
}

export type { RepertoireLine };

/**
 * Every added line of a repertoire, as a flat list — see
 * `enumerateLinesFromNodes` for the rules, including how move orders that
 * transpose into a shared position are kept apart.
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
  return enumerateLinesFromNodes(allNodes, START_FEN, isLibraryLinePrefix);
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
