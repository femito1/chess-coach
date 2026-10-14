import { Chess } from 'chess.js';
import type { RepertoireNode } from '@/db/schema';

/**
 * Pure walk over a repertoire's stored node graph — no Dexie, so the
 * transposition rules below are unit-tested directly (`lineTree.test.ts`);
 * `store.ts` loads the rows and calls in.
 *
 * ── Why this is a graph walk, not a tree walk ────────────────────────────
 *
 * Nodes are keyed by `fenKey` (the FEN without its move counters), so two
 * move orders that reach the same position share ONE node. Everything that
 * resolves a `childFens` / `parentFen` / `mainChildFen` entry must therefore
 * resolve it by `fenKey`, never by the full stored string: the second move
 * order arrives with different halfmove/fullmove counters, so a full-FEN
 * lookup misses the shared node and silently drops every line behind it.
 *
 * A shared node also has more than one way in, and its stored
 * `moveUci`/`moveSan` describe only the FIRST way (its "primary" edge). The
 * move along any other edge is re-derived from the position (`edgeMove`).
 *
 * ── Which continuations belong to which move order ───────────────────────
 *
 * Position-keying alone cannot say whether a move added after a
 * transposition belongs to one move order or to all of them, and following
 * every edge from a shared node cross-multiplies the move orders: bulk-adding
 * the Queen's Gambit Declined would drill 605 lines, ~500 of them never added.
 * So each node records `paths` — every root-to-node UCI sequence it was
 * added along — and the walk follows an edge only when the extended sequence
 * is one of them. The line the user's move order added is the line drilled,
 * with its own moves.
 *
 * Nodes written before `paths` existed have no such record. For those the
 * walk falls back to `legacyFollows`: along the creation tree (every edge so
 * far the one its child was created along, with the same counters) edges are
 * followed as before; past a transposition an edge is followed only when the
 * resulting sequence is a prefix of an openings-library line. Every line
 * added since the v10 wipe came from the library, so that recovers every
 * line the user added; the price is that a transposition can also surface a
 * book line they did not add.
 */

/** UCI path key, the same shape as `store.lineKey`: moves joined by spaces.
 *  The root's path is the empty string. */
export function extendPathKey(prefix: string, uci: string): string {
  return prefix ? `${prefix} ${uci}` : uci;
}

export function fenKey(fen: string): string {
  return fen.split(' ').slice(0, 4).join(' ');
}

export interface LineEdge {
  uci: string;
  san: string;
  /** Full FEN after the move, counters as reached along THIS edge. */
  fen: string;
}

/**
 * The move from `fromFen` into `child`, with the resulting FEN.
 *
 * The child's own `moveUci` is only valid along its primary edge (its
 * `parentFen` is this position); for any other parent it describes a move
 * from a different position and must not be spliced in, so the move is
 * recovered from the legal moves instead. Returns null when no legal move
 * reaches the child (a corrupt edge), which the caller skips.
 */
export function edgeMove(fromFen: string, child: RepertoireNode): LineEdge | null {
  const fromKey = fenKey(fromFen);
  if (child.parentFen && fenKey(child.parentFen) === fromKey && child.moveUci && child.moveSan) {
    // Same position AND same counters as when the child was created: its
    // stored FEN is exactly right, so skip chess.js entirely (the hot path).
    if (child.parentFen === fromFen) {
      return { uci: child.moveUci, san: child.moveSan, fen: child.fen };
    }
    try {
      const c = new Chess(fromFen);
      const mv = c.move({
        from: child.moveUci.slice(0, 2),
        to: child.moveUci.slice(2, 4),
        promotion: child.moveUci.slice(4, 5) || undefined,
      });
      return { uci: child.moveUci, san: mv.san, fen: c.fen() };
    } catch {
      return null;
    }
  }
  const childKey = fenKey(child.fen);
  try {
    const c = new Chess(fromFen);
    for (const mv of c.moves({ verbose: true })) {
      if (fenKey(mv.after) === childKey) {
        return { uci: mv.lan, san: mv.san, fen: mv.after };
      }
    }
  } catch {
    /* unparseable FEN — treat as no edge */
  }
  return null;
}

export interface AddMoveInput {
  repertoireId: string;
  parentId: string;
  childId: string;
  parentFen: string;
  childFen: string;
  uci: string;
  san: string;
  /** The move order that reached `parentFen`, as a path key, when the
   *  caller knows it. */
  parentPathKey?: string;
  now: number;
  /** Current stored rows, if any. */
  parent?: RepertoireNode;
  child?: RepertoireNode;
}

/**
 * The node rows `store.addMove` writes for one move (parent and/or child;
 * empty when the move and its move order are already recorded). Pure, so
 * the exact rows the walk later reads are what the unit tests build.
 *
 * Without `parentPathKey` the move is recorded under every move order
 * already recorded for the parent — a move added "at this position".
 */
export function planAddMove(input: AddMoveInput): RepertoireNode[] {
  const { parent, child, parentFen, childFen, uci, parentPathKey, now } = input;
  const childKey = fenKey(childFen);
  const parentPaths = parentPathKey !== undefined ? [parentPathKey] : parent?.paths;
  const childPaths = parentPaths?.map((p) => extendPathKey(p, uci));
  const writes: RepertoireNode[] = [];

  if (!parent) {
    // If the parent doesn't exist (e.g. PGN import went out of order),
    // synthesize a minimal parent node. Its own parent pointer will be
    // wrong, but children/look-ups still work.
    writes.push({
      id: input.parentId,
      repertoireId: input.repertoireId,
      fen: parentFen,
      childFens: [childFen],
      ...(parentPaths ? { paths: [...parentPaths] } : {}),
      createdAt: now,
    });
  } else {
    const next: RepertoireNode = { ...parent, childFens: [...parent.childFens] };
    let changed = false;
    // Compared by key: the same child reached in another move order has
    // other counters, and listing it twice is what a full-FEN lookup used
    // to trip over.
    if (!next.childFens.some((f) => fenKey(f) === childKey)) {
      next.childFens.push(childFen);
      if (!next.mainChildFen) next.mainChildFen = childFen;
      changed = true;
    }
    if (parentPathKey !== undefined && !parent.paths?.includes(parentPathKey)) {
      next.paths = [...(parent.paths ?? []), parentPathKey];
      changed = true;
    }
    if (changed) writes.push(next);
  }

  if (!child) {
    writes.push({
      id: input.childId,
      repertoireId: input.repertoireId,
      fen: childFen,
      parentFen,
      moveUci: uci,
      moveSan: input.san,
      childFens: [],
      ...(childPaths ? { paths: childPaths } : {}),
      createdAt: now,
    });
  } else if (childPaths) {
    const missing = childPaths.filter((p) => !child.paths?.includes(p));
    if (missing.length > 0) {
      writes.push({ ...child, paths: [...(child.paths ?? []), ...missing] });
    }
  }
  return writes;
}

/** Predicate over a UCI path key: is it a prefix of (or equal to) some
 *  openings-library line? Injected so the walk stays dataset-free. */
export type BookPrefixTest = (pathKey: string) => boolean;

/** Is the edge `fromFen → child` the one the child was created along, with
 *  the very counters it was created with? */
function isCreationEdge(fromFen: string, child: RepertoireNode): boolean {
  return child.parentFen === fromFen;
}

/**
 * Fallback rule for nodes that carry no `paths` record. See the header.
 *
 * `onCreationTree` is true while every edge so far was a creation edge.
 * Only then does a creation edge prove the child belongs to this move
 * order: past a transposition, a child created from the shared position by
 * another move order looks identical whenever the two orders' counters
 * happen to agree (common — every pawn move resets the halfmove clock), and
 * trusting it there cross-multiplied the move orders into hundreds of lines
 * nobody added.
 */
function legacyFollows(
  fromFen: string,
  child: RepertoireNode,
  nextPath: string,
  onCreationTree: boolean,
  isBookPrefix: BookPrefixTest,
): boolean {
  if (onCreationTree && isCreationEdge(fromFen, child)) return true;
  return isBookPrefix(nextPath);
}

export interface WalkedLine {
  uci: string[];
  san: string[];
  fens: string[];
}

/** Lines are never longer than this many plies — a backstop against a
 *  malformed graph, far above the deepest library line (36 plies). */
const MAX_PLY = 400;

/**
 * Walk every added line from the start position.
 *
 * Emits a line wherever a path stops: a node with no children, or one whose
 * children were all added along OTHER move orders (so this move order ends
 * here even though another continues). `onVisit` sees every node reached
 * with the path key it was reached by — the legacy upgrade uses it to write
 * `paths` that reproduce exactly what this walk shows.
 *
 * A position is never revisited within one line, so a cycle in the graph
 * (a line that shuffles back to an earlier position) cannot recurse forever.
 * No library line repeats a position, so this costs nothing real.
 */
export function walkLines(
  nodes: readonly RepertoireNode[],
  startFen: string,
  isBookPrefix: BookPrefixTest,
  onVisit?: (node: RepertoireNode, pathKey: string) => void,
): WalkedLine[] {
  const byKey = new Map<string, RepertoireNode>();
  for (const n of nodes) byKey.set(fenKey(n.fen), n);
  const root = byKey.get(fenKey(startFen));
  if (!root) return [];

  const lines: WalkedLine[] = [];
  const onPath = new Set<string>();

  function dfs(
    node: RepertoireNode,
    fen: string,
    pathKey: string,
    uci: string[],
    san: string[],
    fens: string[],
    onCreationTree: boolean,
  ): void {
    onVisit?.(node, pathKey);
    const key = fenKey(fen);
    onPath.add(key);
    // Main child first; then the stored order. Compared by key — a stored
    // `mainChildFen` may carry another move order's counters.
    const mainKey = node.mainChildFen ? fenKey(node.mainChildFen) : undefined;
    const childKeys: string[] = [];
    for (const f of node.childFens) {
      const k = fenKey(f);
      if (!childKeys.includes(k)) childKeys.push(k);
    }
    if (mainKey) {
      const i = childKeys.indexOf(mainKey);
      if (i > 0) childKeys.unshift(...childKeys.splice(i, 1));
    }

    let followed = 0;
    if (uci.length < MAX_PLY) {
      for (const k of childKeys) {
        if (onPath.has(k)) continue;
        const child = byKey.get(k);
        if (!child) continue;
        const edge = edgeMove(fen, child);
        if (!edge) continue;
        const nextPath = extendPathKey(pathKey, edge.uci);
        const follows = child.paths
          ? child.paths.includes(nextPath)
          : legacyFollows(fen, child, nextPath, onCreationTree, isBookPrefix);
        if (!follows) continue;
        followed++;
        dfs(
          child,
          edge.fen,
          nextPath,
          [...uci, edge.uci],
          [...san, edge.san],
          [...fens, edge.fen],
          onCreationTree && isCreationEdge(fen, child),
        );
      }
    }
    onPath.delete(key);
    if (followed === 0 && uci.length > 0) {
      lines.push({ uci, san, fens });
    }
  }

  dfs(root, startFen, '', [], [], [startFen], true);
  return lines;
}

/**
 * Every path key each node is reached by under `walkLines`' rules, keyed by
 * node id. The one-time upgrade of a pre-`paths` repertoire writes these, so
 * the exact rule afterwards shows precisely the lines the legacy fallback
 * showed before — adding a new line never makes an old one vanish.
 */
export function reachedPaths(
  nodes: readonly RepertoireNode[],
  startFen: string,
  isBookPrefix: BookPrefixTest,
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  walkLines(nodes, startFen, isBookPrefix, (node, pathKey) => {
    const arr = out.get(node.id) ?? [];
    if (!arr.includes(pathKey)) arr.push(pathKey);
    out.set(node.id, arr);
  });
  return out;
}

/**
 * Every repertoire move from one position, regardless of how it was
 * reached: the SRS card is per position, so any of them is a correct answer
 * there. In stored child order.
 */
export function movesFrom(
  node: RepertoireNode,
  byKey: ReadonlyMap<string, RepertoireNode>,
): string[] {
  const out: string[] = [];
  for (const f of node.childFens) {
    const child = byKey.get(fenKey(f));
    if (!child) continue;
    const edge = edgeMove(node.fen, child);
    if (edge && !out.includes(edge.uci)) out.push(edge.uci);
  }
  return out;
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
 * Enumerate every added line as a flat list (`walkLines`): one per place a
 * move order stops, each in its own move order.
 *
 * Lines are sorted lexicographically by SAN so related lines (same prefix)
 * sit next to each other in the trainer's queue.
 */
export function enumerateLinesFromNodes(
  nodes: readonly RepertoireNode[],
  startFen: string,
  isBookPrefix: BookPrefixTest,
): RepertoireLine[] {
  const walked = walkLines(nodes, startFen, isBookPrefix);

  // De-duplicate: identical move sequences can appear if a sub-tree was
  // imported twice. Key by joined UCI.
  const seen = new Set<string>();
  const unique: RepertoireLine[] = [];
  for (const l of walked) {
    const k = l.uci.join(' ');
    if (seen.has(k)) continue;
    seen.add(k);
    unique.push({
      ...l,
      name: l.san.slice(0, 6).join(' ') + (l.san.length > 6 ? '…' : ''),
    });
  }

  unique.sort((a, b) => {
    const min = Math.min(a.san.length, b.san.length);
    for (let i = 0; i < min; i++) {
      if (a.san[i] !== b.san[i]) return a.san[i].localeCompare(b.san[i]);
    }
    return a.san.length - b.san.length;
  });

  return unique;
}
