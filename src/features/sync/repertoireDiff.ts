import type {
  Repertoire,
  RepertoireCard,
  RepertoireLineStats,
  RepertoireNode,
} from '@/db/schema';

/**
 * Sync policy for opening repertoires. Pure — no Dexie, no network — so every
 * case below is unit-tested; `repertoireSync.ts` executes the plan.
 *
 * ── Why repertoires are not synced like games ────────────────────────────
 *
 * Games are append-mostly, so "whichever side has it" is nearly the whole
 * policy. Repertoires are edited in place (SRS cards change on every training
 * answer, nodes gain children, line stats are counters) and deleted, and the
 * records carry no per-row modification time. So the unit of sync is the whole
 * repertoire — record, node tree, cards and line stats in one snapshot — which
 * also guarantees a node and its card are never split across two half-applied
 * syncs.
 *
 * ── Three-way, not two-way ───────────────────────────────────────────────
 *
 * Each device keeps a `SyncBase` per repertoire: the cloud `rev` and the
 * content hash as of the last time the two sides agreed. Against it, "changed
 * here" (local hash ≠ base hash) and "changed there" (cloud rev ≠ base rev) are
 * facts rather than guesses, so a restore, an edit on one device and a pull to
 * another never need a conflict rule at all. Only "changed on both" merges —
 * and the merge never discards training: see `mergeSnapshots`.
 *
 * Deleting a repertoire is a tombstone in the cloud (`deleted = true`), never a
 * row delete — there is no DELETE policy, and a device that still has the
 * repertoire must learn it was deleted rather than restore it.
 */

export interface RepertoireSnapshot {
  repertoire: Repertoire;
  nodes: RepertoireNode[];
  cards: RepertoireCard[];
  lineStats: RepertoireLineStats[];
}

/** What this device last agreed with the cloud about one repertoire. */
export interface SyncBase {
  repertoireId: string;
  rev: number;
  /** Content hash of the agreed snapshot; empty for an agreed tombstone. */
  hash: string;
  deleted: boolean;
}

export interface RemoteRepertoireMeta {
  repertoire_id: string;
  rev: number;
  deleted: boolean;
}

/** `expectRev: null` = insert a new cloud row; a number = update only if the
 *  cloud row is still at that rev (compare-and-swap). */
export type RepertoireAction =
  | { kind: 'push'; id: string; expectRev: number | null }
  | { kind: 'pushTombstone'; id: string; expectRev: number }
  | { kind: 'pull'; id: string }
  | { kind: 'deleteLocal'; id: string; remoteRev: number }
  | { kind: 'merge'; id: string }
  | { kind: 'adoptBase'; id: string; base: SyncBase }
  | { kind: 'forgetBase'; id: string };

export function planRepertoireSync(args: {
  /** Content hash of every repertoire present locally. */
  localHashes: ReadonlyMap<string, string>;
  bases: ReadonlyMap<string, SyncBase>;
  remote: readonly RemoteRepertoireMeta[];
}): RepertoireAction[] {
  const { localHashes, bases } = args;
  const remote = new Map(args.remote.map((r) => [r.repertoire_id, r]));
  const ids = new Set<string>([...localHashes.keys(), ...bases.keys(), ...remote.keys()]);
  const out: RepertoireAction[] = [];

  for (const id of [...ids].sort()) {
    const hash = localHashes.get(id);
    const base = bases.get(id);
    const r = remote.get(id);
    const remoteChanged = r !== undefined && (base === undefined || r.rev !== base.rev);

    if (hash !== undefined) {
      const localChanged = base === undefined || base.deleted || base.hash !== hash;
      if (r === undefined) {
        // Never in the cloud, or pruned from it out of band: either way the
        // local copy is the only one, so it goes up.
        out.push({ kind: 'push', id, expectRev: null });
      } else if (!remoteChanged) {
        if (localChanged) out.push({ kind: 'push', id, expectRev: r.rev });
      } else if (!localChanged) {
        out.push(r.deleted ? { kind: 'deleteLocal', id, remoteRev: r.rev } : { kind: 'pull', id });
      } else if (r.deleted) {
        // Deleted elsewhere, but trained here since: keep the training. A
        // deletion is cheap to repeat; lost SRS history is not recoverable.
        out.push({ kind: 'push', id, expectRev: r.rev });
      } else {
        out.push({ kind: 'merge', id });
      }
      continue;
    }

    // Not present locally.
    if (r === undefined) {
      if (base) out.push({ kind: 'forgetBase', id });
      continue;
    }
    if (r.deleted) {
      if (!base || !base.deleted || base.rev !== r.rev) {
        out.push({ kind: 'adoptBase', id, base: { repertoireId: id, rev: r.rev, hash: '', deleted: true } });
      }
      continue;
    }
    if (base && !base.deleted && !remoteChanged) {
      // We had it, the cloud has not moved since, and it is gone here: the user
      // deleted it on this device.
      out.push({ kind: 'pushTombstone', id, expectRev: r.rev });
      continue;
    }
    // Never seen here (a restore, or created on another device), or edited
    // elsewhere after we deleted it — the edit wins, for the same reason the
    // deleted-but-trained case above does.
    out.push({ kind: 'pull', id });
  }
  return out;
}

/* =======================================================================
 *  Merge — only for "changed on both sides"
 * ======================================================================= */

/**
 * Combine two diverged snapshots of one repertoire without discarding work.
 *
 *  - The repertoire record: the side with the newer `updatedAt` (name,
 *    description, bulk-load stamp). Ties go to `a`.
 *  - Nodes: the union. A node on both sides takes the newer side's fields, with
 *    `childFens` unioned so neither side's branches are orphaned. Consequence: a
 *    line deleted on one device while the same repertoire was edited on another
 *    comes back. Resurrecting a deletion is the deliberate trade against losing
 *    a line someone added.
 *  - Cards: per card, the one reviewed most recently — its SRS state is the
 *    later state of the same schedule. Then more reps, then `a`.
 *  - Line stats: counters only ever grow, so field-wise max. Same rule as
 *    puzzle attempts.
 */
export function mergeSnapshots(a: RepertoireSnapshot, b: RepertoireSnapshot): RepertoireSnapshot {
  const aNewer = a.repertoire.updatedAt >= b.repertoire.updatedAt;
  const [newer, older] = aNewer ? [a, b] : [b, a];

  const nodes = new Map<string, RepertoireNode>();
  for (const n of older.nodes) nodes.set(n.id, n);
  for (const n of newer.nodes) {
    const prev = nodes.get(n.id);
    if (!prev) {
      nodes.set(n.id, n);
      continue;
    }
    const childFens = [...n.childFens];
    for (const f of prev.childFens) if (!childFens.includes(f)) childFens.push(f);
    nodes.set(n.id, {
      ...prev,
      ...n,
      childFens,
      mainChildFen: n.mainChildFen ?? prev.mainChildFen,
      notes: n.notes ?? prev.notes,
    });
  }

  const cards = new Map<string, RepertoireCard>();
  for (const c of [...a.cards, ...b.cards]) {
    const prev = cards.get(c.id);
    if (!prev || cardIsLater(c, prev)) cards.set(c.id, c);
  }

  const stats = new Map<string, RepertoireLineStats>();
  for (const s of [...a.lineStats, ...b.lineStats]) {
    const prev = stats.get(s.id);
    stats.set(s.id, prev ? mergeLineStats(prev, s) : s);
  }

  return {
    repertoire: newer.repertoire,
    nodes: [...nodes.values()],
    cards: [...cards.values()],
    lineStats: [...stats.values()],
  };
}

/** Strictly later, so the first-seen card (from `a`) wins ties. */
function cardIsLater(c: RepertoireCard, prev: RepertoireCard): boolean {
  const t = c.srs.lastReviewedAt ?? 0;
  const p = prev.srs.lastReviewedAt ?? 0;
  if (t !== p) return t > p;
  return c.srs.reps > prev.srs.reps;
}

function mergeLineStats(a: RepertoireLineStats, b: RepertoireLineStats): RepertoireLineStats {
  const last = Math.max(a.lastPracticedAt ?? 0, b.lastPracticedAt ?? 0);
  return {
    ...a,
    attempts: Math.max(a.attempts, b.attempts),
    completions: Math.max(a.completions, b.completions),
    movesPlayed: Math.max(a.movesPlayed, b.movesPlayed),
    correctMoves: Math.max(a.correctMoves, b.correctMoves),
    wrongMoves: Math.max(a.wrongMoves, b.wrongMoves),
    perfectCompletions: Math.max(a.perfectCompletions, b.perfectCompletions),
    ...(last > 0 ? { lastPracticedAt: last } : {}),
    createdAt: Math.min(a.createdAt, b.createdAt),
  };
}

/* =======================================================================
 *  Hashing
 * ======================================================================= */

/**
 * Content hash of a snapshot, independent of row order and key order — Dexie
 * returns rows in key order today, but "changed" must not depend on that.
 * cyrb53: 53 bits, so a missed change needs a collision at ~2⁻⁵³.
 */
export function snapshotHash(s: RepertoireSnapshot): string {
  const byId = <T extends { id: string }>(rows: readonly T[]) =>
    [...rows].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  return cyrb53(
    canonical({
      repertoire: s.repertoire,
      nodes: byId(s.nodes),
      cards: byId(s.cards),
      lineStats: byId(s.lineStats),
    }),
  );
}

/** JSON with object keys sorted and `undefined` dropped, as JSON itself does. */
function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
}

function cyrb53(str: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** Next cloud rev: monotonic per row even across devices with skewed clocks. */
export function nextRev(expectRev: number | null, now: number): number {
  return Math.max(now, (expectRev ?? 0) + 1);
}
