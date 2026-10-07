// End-to-end coverage for repertoire cloud sync against a fake Supabase.
//
// `repertoireDiff.test.ts` covers the policy — every push / pull / merge /
// tombstone decision — in the unit tier. This drives the real `syncRepertoires`
// against real Dexie and the real repertoire store, with only the network
// faked, because the mistakes that break sync live in the plumbing: a
// compare-and-swap that never matches, a pull that leaves half a tree, a base
// that is not written with the data it describes.
//
// The fake implements exactly the query shapes repertoireSync builds, including
// a unique violation on a duplicate insert and `update … where rev = ?`
// matching nothing when the rev has moved — the two signals of a concurrent
// write from another device.
//
// Story:
//   1. A repertoire built through the real store uploads.
//   2. A second sync moves nothing.
//   3. Wipe local, sync → the repertoire comes back byte-identical.
//   4. An edit here pushes, compare-and-swapping the rev forward.
//   5. An edit "on another device" pulls down.
//   6. Edits on both sides merge, and both edits survive on both sides.
//   7. Another device's write between manifest and push is a conflict, not an
//      overwrite — and the next sync merges it.
//   8. Deleting a repertoire pushes a tombstone; a fresh device does not
//      resurrect it.
//   9. A cloud project without the table skips the phase instead of failing.

import { runBrowserTest, expect, appendBypass } from '../harness.mjs';

const USER = 'user_repsync_test';

await runBrowserTest({
  name: 'repertoire-sync',
  waitUntil: 'domcontentloaded',
  skipInitialGoto: true,
  async run({ page }) {
    await page.goto(appendBypass('http://localhost:5173/dashboard'), {
      waitUntil: 'domcontentloaded',
    });
    await page.waitForSelector('a[href="/puzzles"]', { timeout: 15_000 });

    const out = await page.evaluate(async (userId) => {
      try {
        const { db } = await import('/src/db/schema.ts');
        const { syncRepertoires } = await import('/src/features/sync/repertoireSync.ts');
        const { snapshotHash } = await import('/src/features/sync/repertoireDiff.ts');
        const store = await import('/src/features/repertoire/store.ts');

        const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

        /* ------------------------------------------------ fake Supabase -- */
        const rows = new Map(); // repertoire_id -> row
        const fake = { tableMissing: false, beforeUpdate: null };
        const supabase = {
          from(table) {
            if (table !== 'cloud_repertoires') throw new Error(`fake: unknown table ${table}`);
            if (fake.tableMissing) {
              const missing = { data: null, error: { code: 'PGRST205', message: "Could not find the table 'public.cloud_repertoires'" } };
              const b = { eq: () => b, in: async () => missing, range: async () => missing };
              return { select: () => b };
            }
            const filters = {};
            const pick = (cols, r) => {
              const o = {};
              for (const c of cols.split(',').map((x) => x.trim())) o[c] = r[c];
              return o;
            };
            const matches = (r) =>
              Object.entries(filters).every(([k, v]) =>
                v instanceof Set ? v.has(r[k]) : r[k] === v,
              );
            return {
              select(cols) {
                const b = {
                  eq(k, v) { filters[k] = v; return b; },
                  async in(k, vs) {
                    filters[k] = new Set(vs);
                    const data = [...rows.values()].filter(matches).map((r) => pick(cols, r));
                    return { data: JSON.parse(JSON.stringify(data)), error: null };
                  },
                  async range(from, to) {
                    const data = [...rows.values()]
                      .filter(matches)
                      .sort((a, b) => (a.repertoire_id < b.repertoire_id ? -1 : 1))
                      .slice(from, to + 1)
                      .map((r) => pick(cols, r));
                    return { data: JSON.parse(JSON.stringify(data)), error: null };
                  },
                };
                return b;
              },
              async insert(row) {
                if (rows.has(row.repertoire_id)) {
                  return { error: { code: '23505', message: 'duplicate key value' } };
                }
                rows.set(row.repertoire_id, JSON.parse(JSON.stringify(row)));
                return { error: null };
              },
              update(patch) {
                const b = {
                  eq(k, v) { filters[k] = v; return b; },
                  async select() {
                    fake.beforeUpdate?.();
                    fake.beforeUpdate = null;
                    const hit = [...rows.values()].filter(matches);
                    for (const r of hit) Object.assign(r, JSON.parse(JSON.stringify(patch)));
                    return { data: hit.map((r) => ({ repertoire_id: r.repertoire_id })), error: null };
                  },
                };
                return b;
              },
            };
          },
        };

        let clock = 1_800_000_000_000;
        const sync = () => syncRepertoires({ supabase, userId, now: () => ++clock });

        const snapshotOf = async (id) => ({
          repertoire: await db.repertoires.get(id),
          nodes: await db.repertoireNodes.where('repertoireId').equals(id).toArray(),
          cards: await db.repertoireCards.where('repertoireId').equals(id).toArray(),
          lineStats: await db.repertoireLineStats.where('repertoireId').equals(id).toArray(),
        });
        const wipeLocal = async () => {
          await db.repertoires.clear();
          await db.repertoireNodes.clear();
          await db.repertoireCards.clear();
          await db.repertoireLineStats.clear();
          await db.repertoireSyncBases.clear();
        };
        await wipeLocal();

        /* ---------------------------------------------- 1. first upload -- */
        const rep = await store.createRepertoire({ name: 'Italian', color: 'white', kind: 'custom' });
        let fen = START;
        for (const uci of ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4']) {
          const n = await store.addMove(rep.id, fen, uci);
          fen = n.fen;
        }
        const localBefore = await snapshotOf(rep.id);
        const r1 = await sync();
        const cloud1 = rows.get(rep.id);
        const first = {
          pushed: r1.pushed,
          cloudNodes: cloud1?.data?.nodes?.length ?? 0,
          localNodes: localBefore.nodes.length,
          cloudCards: cloud1?.data?.cards?.length ?? 0,
          localCards: localBefore.cards.length,
        };

        /* ----------------------------------------------- 2. idempotent -- */
        const r2 = await sync();
        const second = r2.pushed + r2.pulled + r2.merged + r2.tombstoned + r2.deletedLocal;

        /* -------------------------------------------------- 3. restore -- */
        await wipeLocal();
        const r3 = await sync();
        const restored = await snapshotOf(rep.id);
        const restore = {
          pulled: r3.pulled,
          identical: snapshotHash(restored) === snapshotHash(localBefore),
          base: (await db.repertoireSyncBases.get(rep.id))?.rev === rows.get(rep.id).rev,
        };

        /* ------------------------------------------- 4. local edit pushes -- */
        const revBefore = rows.get(rep.id).rev;
        await store.addMove(rep.id, fen, 'f8c5');
        const r4 = await sync();
        const localEdit = {
          pushed: r4.pushed,
          revAdvanced: rows.get(rep.id).rev > revBefore,
          cloudNodes: rows.get(rep.id).data.nodes.length,
        };

        /* ----------------------------------- 5. edit elsewhere pulls down -- */
        {
          const r = rows.get(rep.id);
          r.data.repertoire = { ...r.data.repertoire, name: 'Italian (renamed elsewhere)', updatedAt: clock + 10 };
          r.rev = ++clock;
        }
        const r5 = await sync();
        const remoteEdit = {
          pulled: r5.pulled,
          name: (await db.repertoires.get(rep.id)).name,
        };

        /* --------------------------------------- 6. both sides, merged -- */
        // Here: a new branch. Elsewhere: a reviewed card.
        const afterE4 = (await db.repertoireNodes.get(store.nodeId(rep.id, START))).childFens[0];
        await store.addMove(rep.id, afterE4, 'c7c5');
        {
          const r = rows.get(rep.id);
          const c = r.data.cards[0];
          c.srs = { ...c.srs, reps: 7, lastReviewedAt: clock + 50 };
          r.rev = ++clock;
        }
        const cardId = rows.get(rep.id).data.cards[0].id;
        const r6 = await sync();
        const mergedLocal = await snapshotOf(rep.id);
        const merged = {
          merged: r6.merged,
          localHasBranch: mergedLocal.nodes.some((n) => n.moveUci === 'c7c5'),
          cloudHasBranch: rows.get(rep.id).data.nodes.some((n) => n.moveUci === 'c7c5'),
          localHasReview: mergedLocal.cards.find((c) => c.id === cardId)?.srs.reps === 7,
          cloudHasReview: rows.get(rep.id).data.cards.find((c) => c.id === cardId)?.srs.reps === 7,
          agree: snapshotHash(mergedLocal) === snapshotHash(rows.get(rep.id).data),
        };

        /* ------------------------- 7. concurrent write is a conflict ----- */
        await store.setNoteOnNode(rep.id, START, 'main line');
        // Another device pushes between this device's manifest and its update.
        fake.beforeUpdate = () => {
          const r = rows.get(rep.id);
          r.data.repertoire = { ...r.data.repertoire, description: 'from the other device', updatedAt: clock + 100 };
          r.rev = ++clock;
        };
        const r7 = await sync();
        const afterConflict = rows.get(rep.id);
        const r7b = await sync();
        const finalLocal = await snapshotOf(rep.id);
        const conflict = {
          conflicts: r7.conflicts,
          notOverwritten: afterConflict.data.repertoire.description === 'from the other device',
          thenMerged: r7b.merged,
          keptNote: finalLocal.nodes.find((n) => n.fen === START)?.notes === 'main line',
          keptOther: finalLocal.repertoire.description === 'from the other device',
        };

        /* ------------------------------------------- 8. tombstones ------ */
        await store.deleteRepertoire(rep.id);
        const r8 = await sync();
        const tomb = rows.get(rep.id);
        await wipeLocal();
        const r8b = await sync();
        const tombstone = {
          tombstoned: r8.tombstoned,
          cloudDeleted: tomb.deleted === true,
          freshDevicePulled: r8b.pulled,
          freshDeviceHasIt: Boolean(await db.repertoires.get(rep.id)),
          adoptedBase: (await db.repertoireSyncBases.get(rep.id))?.deleted === true,
        };

        /* ---------------------------------------- 9. table missing ------ */
        fake.tableMissing = true;
        const r9 = await sync();

        await wipeLocal();
        return { ok: true, first, second, restore, localEdit, remoteEdit, merged, conflict, tombstone, missing: r9.unavailable };
      } catch (e) {
        return { ok: false, error: e?.message ?? String(e), stack: e?.stack };
      }
    }, USER);

    console.log(JSON.stringify(out, null, 1));
    expect(out.ok, `evaluate (error=${out.error})\n${out.stack ?? ''}`).toBe(true);

    expect(out.first.pushed, '1. the repertoire uploaded').toBe(1);
    expect(out.first.cloudNodes, '1. every node is in the cloud').toBe(out.first.localNodes);
    expect(out.first.cloudCards, '1. every SRS card is in the cloud').toBe(out.first.localCards);
    expect(out.first.cloudCards, '1. and there are cards to check').toBeAtLeast(1);

    expect(out.second, '2. a second sync moves nothing').toBe(0);

    expect(out.restore.pulled, '3. a wiped device gets it back').toBe(1);
    expect(out.restore.identical, '3. byte-identical after the round trip').toBe(true);
    expect(out.restore.base, '3. and the base records the agreed rev').toBe(true);

    expect(out.localEdit.pushed, '4. a local edit pushes').toBe(1);
    expect(out.localEdit.revAdvanced, '4. compare-and-swap moved the rev forward').toBe(true);
    expect(out.localEdit.cloudNodes, '4. the new move is in the cloud').toBe(out.first.localNodes + 1);

    expect(out.remoteEdit.pulled, '5. an edit elsewhere pulls down').toBe(1);
    expect(out.remoteEdit.name, '5. and lands locally').toBe('Italian (renamed elsewhere)');

    expect(out.merged.merged, '6. edits on both sides merge').toBe(1);
    expect(out.merged.localHasBranch, "6. this device's branch survives here").toBe(true);
    expect(out.merged.cloudHasBranch, "6. …and in the cloud").toBe(true);
    expect(out.merged.localHasReview, "6. the other device's review survives here").toBe(true);
    expect(out.merged.cloudHasReview, '6. …and in the cloud').toBe(true);
    expect(out.merged.agree, '6. both sides converged').toBe(true);

    expect(out.conflict.conflicts, '7. a concurrent write is detected').toBe(1);
    expect(out.conflict.notOverwritten, '7. and not overwritten').toBe(true);
    expect(out.conflict.thenMerged, '7. the next sync merges it').toBe(1);
    expect(out.conflict.keptNote, "7. this device's note survived").toBe(true);
    expect(out.conflict.keptOther, "7. the other device's edit survived").toBe(true);

    expect(out.tombstone.tombstoned, '8. a deletion pushes a tombstone').toBe(1);
    expect(out.tombstone.cloudDeleted, '8. the cloud row is marked deleted, not removed').toBe(true);
    expect(out.tombstone.freshDevicePulled, '8. a fresh device does not pull it').toBe(0);
    expect(out.tombstone.freshDeviceHasIt, '8. and does not have it').toBe(false);
    expect(out.tombstone.adoptedBase, '8. it records the tombstone instead').toBe(true);

    expect(out.missing, '9. a missing table is skipped, not an error').toBe(true);
  },
});
