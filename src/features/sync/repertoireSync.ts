import type { SupabaseClient } from '@supabase/supabase-js';
import Dexie, { type Transaction } from 'dexie';
import { db } from '@/db/schema';
import { assertLocalDataBelongsTo } from './bindingGuard';
import {
  mergeSnapshots,
  nextRev,
  planRepertoireSync,
  snapshotHash,
  type RemoteRepertoireMeta,
  type RepertoireSnapshot,
  type SyncBase,
} from './repertoireDiff';

/**
 * Execute the repertoire sync plan from `repertoireDiff.ts` against Dexie and
 * Supabase. The policy — what to push, pull, merge or tombstone — lives there
 * and is unit-tested; this file is only the plumbing, covered by
 * `repertoire-sync.mjs`.
 *
 * ── Three properties this file is responsible for ────────────────────────
 *
 *  - **A concurrent push is detected, not overwritten.** Every update is
 *    `where rev = <the rev we planned against>`. If another device got there
 *    first, the update matches nothing, this repertoire is left for the next
 *    sync — which will then see "changed on both" and merge.
 *  - **A pull replaces a repertoire atomically, with its base.** The four
 *    repertoire tables and `repertoireSyncBases` are written in one Dexie
 *    transaction, so a crash mid-pull leaves the old state and the old base
 *    together rather than a half-replaced tree that looks "changed here".
 *  - **A pull never overwrites an edit made while the sync was in flight.**
 *    The write transaction re-checks the local snapshot against the one the
 *    plan was made from and skips the apply if it moved (`replaceLocal`).
 *
 * The table may not exist yet: the app can deploy before the SQL in
 * `supabase/cloud-sync.sql` has been re-run. That must not turn every sync red,
 * so a missing table skips this phase with a warning and nothing else.
 */

const TABLE = 'cloud_repertoires';

export interface RepertoireSyncResult {
  pushed: number;
  pulled: number;
  merged: number;
  deletedLocal: number;
  tombstoned: number;
  /** Pushes another device beat us to, and pulls/merges whose local copy was
   *  edited while the sync was in flight; both retried by the next sync. */
  conflicts: number;
  /** The cloud table does not exist yet. */
  unavailable: boolean;
}

/**
 * The transactions in which this module applies a pull, so the change hooks
 * that schedule a sync (`useCloudSync.ts`) skip the sync's own writes rather
 * than scheduling a pointless follow-up.
 *
 * Keyed by transaction, not a module-wide "applying" flag: Dexie fires a hook
 * when the write executes, and a user's write queued behind ours on the same
 * tables executes the moment ours commits — before a flag cleared in `finally`
 * would be. Such a write is a real edit that must schedule an upload; only the
 * hook's own transaction identifies the sync's writes exactly.
 */
const remoteApplyTxs = new WeakSet<Transaction>();
export function isRemoteRepertoireWrite(tx: Transaction | undefined): boolean {
  for (let t = tx; t; t = t.parent) if (remoteApplyTxs.has(t)) return true;
  return false;
}

let warnedUnavailable = false;

export async function syncRepertoires(args: {
  supabase: SupabaseClient;
  userId: string;
  now?: () => number;
}): Promise<RepertoireSyncResult> {
  const { supabase, userId } = args;
  const now = args.now ?? Date.now;
  const out: RepertoireSyncResult = {
    pushed: 0,
    pulled: 0,
    merged: 0,
    deletedLocal: 0,
    tombstoned: 0,
    conflicts: 0,
    unavailable: false,
  };
  await assertLocalDataBelongsTo(userId);

  // ---- manifest: no blobs -----------------------------------------------
  // Ordered by key so offset pages are stable — see `fetchAll` in cloudSync.ts.
  const remote: RemoteRepertoireMeta[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from(TABLE)
      .select('repertoire_id, rev, deleted')
      .eq('user_id', userId)
      .order('repertoire_id', { ascending: true })
      .range(from, from + 999);
    if (error) {
      if (isMissingTable(error)) {
        if (!warnedUnavailable) {
          warnedUnavailable = true;
          // eslint-disable-next-line no-console
          console.warn(
            `[cloud-sync] ${TABLE} does not exist yet — repertoires are not being backed up. ` +
              'Re-run supabase/cloud-sync.sql in the Supabase SQL editor.',
          );
        }
        return { ...out, unavailable: true };
      }
      throw new Error(`${TABLE} manifest: ${error.message}`);
    }
    const rows = (data ?? []) as RemoteRepertoireMeta[];
    remote.push(...rows.map((r) => ({ ...r, rev: Number(r.rev) })));
    if (rows.length < 1000) break;
  }

  // ---- local state ------------------------------------------------------
  const local = await readLocalSnapshots();
  const localHashes = new Map([...local].map(([id, s]) => [id, snapshotHash(s)]));
  const bases = new Map(
    (await db.repertoireSyncBases.toArray()).map((b) => [b.repertoireId, b as SyncBase]),
  );

  const plan = planRepertoireSync({ localHashes, bases, remote });
  if (plan.length === 0) return out;

  const needData = plan
    .filter((a) => a.kind === 'pull' || a.kind === 'merge')
    .map((a) => a.id);
  const remoteData = await fetchSnapshots(supabase, userId, needData);

  for (const action of plan) {
    switch (action.kind) {
      case 'push': {
        const snap = local.get(action.id)!;
        const ok = await writeRow(supabase, userId, action.id, action.expectRev, snap, now);
        if (ok === null) out.conflicts++;
        else {
          await db.repertoireSyncBases.put({
            repertoireId: action.id,
            rev: ok,
            hash: localHashes.get(action.id)!,
            deleted: false,
          });
          out.pushed++;
        }
        break;
      }
      case 'pushTombstone': {
        const ok = await writeRow(supabase, userId, action.id, action.expectRev, null, now);
        if (ok === null) out.conflicts++;
        else {
          await db.repertoireSyncBases.put({
            repertoireId: action.id,
            rev: ok,
            hash: '',
            deleted: true,
          });
          out.tombstoned++;
        }
        break;
      }
      case 'pull': {
        const r = remoteData.get(action.id);
        if (!r?.data) break; // vanished between manifest and fetch: next sync
        const applied = await replaceLocal(action.id, localHashes.get(action.id), r.data, {
          repertoireId: action.id,
          rev: r.rev,
          hash: snapshotHash(r.data),
          deleted: false,
        });
        if (applied) out.pulled++;
        else out.conflicts++;
        break;
      }
      case 'deleteLocal': {
        const applied = await replaceLocal(action.id, localHashes.get(action.id), null, {
          repertoireId: action.id,
          rev: action.remoteRev,
          hash: '',
          deleted: true,
        });
        if (applied) out.deletedLocal++;
        else out.conflicts++;
        break;
      }
      case 'merge': {
        const r = remoteData.get(action.id);
        const mine = local.get(action.id)!;
        if (!r?.data) break;
        const merged = mergeSnapshots(mine, r.data);
        const rev = await writeRow(supabase, userId, action.id, r.rev, merged, now);
        if (rev === null) {
          out.conflicts++;
          break;
        }
        // Local gets the merge only once the cloud has it, so a failed push
        // leaves this device exactly as it was and the next sync merges again.
        // Likewise if the user trained here meanwhile: the cloud has the merge,
        // the base still says the old rev, so the next sync sees "changed on
        // both" and merges that training into it rather than this overwriting it.
        const applied = await replaceLocal(action.id, localHashes.get(action.id), merged, {
          repertoireId: action.id,
          rev,
          hash: snapshotHash(merged),
          deleted: false,
        });
        if (applied) out.merged++;
        else out.conflicts++;
        break;
      }
      case 'adoptBase':
        await db.repertoireSyncBases.put(action.base);
        break;
      case 'forgetBase':
        await db.repertoireSyncBases.delete(action.id);
        break;
    }
  }
  return out;
}

/* ------------------------------------------------------------------------ */

async function readLocalSnapshots(): Promise<Map<string, RepertoireSnapshot>> {
  const [reps, nodes, cards, stats] = await Promise.all([
    db.repertoires.toArray(),
    db.repertoireNodes.toArray(),
    db.repertoireCards.toArray(),
    db.repertoireLineStats.toArray(),
  ]);
  const out = new Map<string, RepertoireSnapshot>();
  for (const r of reps) out.set(r.id, { repertoire: r, nodes: [], cards: [], lineStats: [] });
  // Rows whose repertoire is gone are orphans of a past partial delete; they
  // are not part of any snapshot and are deliberately not synced.
  for (const n of nodes) out.get(n.repertoireId)?.nodes.push(n);
  for (const c of cards) out.get(c.repertoireId)?.cards.push(c);
  for (const s of stats) out.get(s.repertoireId)?.lineStats.push(s);
  return out;
}

async function fetchSnapshots(
  supabase: SupabaseClient,
  userId: string,
  ids: string[],
): Promise<Map<string, { rev: number; data: RepertoireSnapshot | null }>> {
  const out = new Map<string, { rev: number; data: RepertoireSnapshot | null }>();
  // A repertoire blob can run to hundreds of KB, so fetch in small batches.
  for (let i = 0; i < ids.length; i += 20) {
    const { data, error } = await supabase
      .from(TABLE)
      .select('repertoire_id, rev, deleted, data')
      .eq('user_id', userId)
      .in('repertoire_id', ids.slice(i, i + 20));
    if (error) throw new Error(`pull repertoires: ${error.message}`);
    for (const r of (data ?? []) as Array<{
      repertoire_id: string;
      rev: number;
      deleted: boolean;
      data: RepertoireSnapshot | Record<string, never>;
    }>) {
      out.set(r.repertoire_id, {
        rev: Number(r.rev),
        data: r.deleted ? null : (r.data as RepertoireSnapshot),
      });
    }
  }
  return out;
}

/**
 * Insert (`expectRev === null`) or compare-and-swap update. `snap === null`
 * writes a tombstone. Returns the new rev, or `null` when another device's
 * write got there first.
 */
async function writeRow(
  supabase: SupabaseClient,
  userId: string,
  id: string,
  expectRev: number | null,
  snap: RepertoireSnapshot | null,
  now: () => number,
): Promise<number | null> {
  const rev = nextRev(expectRev, now());
  const row = {
    rev,
    deleted: snap === null,
    // `data` is NOT NULL; a tombstone carries an empty object.
    data: snap ?? {},
  };
  if (expectRev === null) {
    const { error } = await supabase
      .from(TABLE)
      .insert({ user_id: userId, repertoire_id: id, ...row });
    if (error) {
      // Unique violation: another device inserted it since our manifest.
      if (error.code === '23505') return null;
      throw new Error(`push repertoire: ${error.message}`);
    }
    return rev;
  }
  const { data, error } = await supabase
    .from(TABLE)
    .update(row)
    .eq('user_id', userId)
    .eq('repertoire_id', id)
    .eq('rev', expectRev)
    .select('repertoire_id');
  if (error) throw new Error(`push repertoire: ${error.message}`);
  return (data ?? []).length === 1 ? rev : null;
}

async function readLocalSnapshot(id: string): Promise<RepertoireSnapshot | undefined> {
  const repertoire = await db.repertoires.get(id);
  if (!repertoire) return undefined;
  const [nodes, cards, lineStats] = await Promise.all([
    db.repertoireNodes.where('repertoireId').equals(id).toArray(),
    db.repertoireCards.where('repertoireId').equals(id).toArray(),
    db.repertoireLineStats.where('repertoireId').equals(id).toArray(),
  ]);
  return { repertoire, nodes, cards, lineStats };
}

/**
 * Replace one repertoire's local state wholesale (or delete it), with its
 * base, in one transaction — unless it changed since the sync read it.
 *
 * `expectHash` is the local hash the plan was made from (undefined: absent).
 * Between that read and this write lie several network round trips, and the
 * user may have answered a card or added a line in them. Overwriting would lose
 * that edit for good: the base saved here would then match the overwritten
 * state, so no later sync could tell anything had happened. So the snapshot is
 * re-read inside the write transaction — which IndexedDB serializes against
 * every other write to these tables — and on any difference the apply is
 * skipped and `false` returned. Base and data stay as they were, so the next
 * sync sees the edit as "changed here" and pushes or merges it.
 */
async function replaceLocal(
  id: string,
  expectHash: string | undefined,
  snap: RepertoireSnapshot | null,
  base: SyncBase,
): Promise<boolean> {
  return db.transaction(
    'rw',
    [db.repertoires, db.repertoireNodes, db.repertoireCards, db.repertoireLineStats, db.repertoireSyncBases],
    async () => {
      const current = await readLocalSnapshot(id);
      const currentHash = current ? snapshotHash(current) : undefined;
      if (currentHash !== expectHash) return false;
      remoteApplyTxs.add(Dexie.currentTransaction);
      await db.repertoireNodes.where('repertoireId').equals(id).delete();
      await db.repertoireCards.where('repertoireId').equals(id).delete();
      await db.repertoireLineStats.where('repertoireId').equals(id).delete();
      if (snap) {
        await db.repertoires.put(snap.repertoire);
        await db.repertoireNodes.bulkPut(snap.nodes);
        await db.repertoireCards.bulkPut(snap.cards);
        await db.repertoireLineStats.bulkPut(snap.lineStats);
      } else {
        await db.repertoires.delete(id);
      }
      await db.repertoireSyncBases.put(base);
      return true;
    },
  );
}

function isMissingTable(error: { code?: string; message?: string }): boolean {
  // Postgres "undefined_table", and PostgREST's schema-cache miss for a table
  // that was never created.
  return (
    error.code === '42P01' ||
    error.code === 'PGRST205' ||
    /does not exist|could not find the table/i.test(error.message ?? '')
  );
}
