// Regression check for the openings page's "Add every line" button:
//
//   - `addFamilyToRepertoire` stamps `Repertoire.bulkLoadedAt` once
//     it finishes walking every line. The Openings page reads this
//     flag (via `useLiveQuery`) to disable the bulk-add button and
//     swap the label to "All lines added".
//
//   - When the underlying repertoire row is deleted, `bulkLoadedAt`
//     vanishes with it (the field travels with the row). A subsequent
//     call to `ensureFamilyRepertoire(family)` returns a fresh row
//     with `bulkLoadedAt === undefined`, so the button re-enables.
//
// We deliberately don't compare expected vs. actual node counts here
// — chess.js's halfmove clock can drift by 1 between continuous walks
// and `load(parentFen)+move(uci)` paths, which is exactly the trap
// the previous FEN-set comparison fell into. `bulkLoadedAt` is the
// unambiguous signal.

import { runBrowserTest, expect, sleep } from '../harness.mjs';

await runBrowserTest({
  name: 'repertoire-bulk-add-stamp',
  async run({ page }) {
    await sleep(800);

    const result = await page.evaluate(async () => {
      const { db } = await import('/src/db/schema.ts');
      const {
        ensureFamilyRepertoire,
        addFamilyToRepertoire,
      } = await import('/src/features/openings/library.ts');
      const { deleteRepertoire } = await import(
        '/src/features/repertoire/store.ts'
      );

      await db.repertoires.clear();
      await db.repertoireNodes.clear();
      await db.repertoireCards.clear();
      await db.repertoireLineStats.clear();

      // Pick a small family so the bulk-add finishes quickly. "Catalan
      // Opening" is fine here — exact dataset doesn't matter, only
      // the contract.
      const family = 'Italian Game';

      // 1. Fresh ensureFamilyRepertoire → no bulkLoadedAt.
      const fresh = await ensureFamilyRepertoire(family);
      const stampedBefore = fresh.bulkLoadedAt != null;

      // 2. After bulk add → bulkLoadedAt is a positive timestamp.
      await addFamilyToRepertoire(fresh.id, family);
      const after = await db.repertoires.get(fresh.id);
      const stampedAfter =
        after?.bulkLoadedAt != null && after.bulkLoadedAt > 0;

      // 3. Delete + re-ensure → fresh row, no stamp.
      await deleteRepertoire(fresh.id);
      const reborn = await ensureFamilyRepertoire(family);
      const stampedAfterDelete = reborn.bulkLoadedAt != null;
      const reincarnated = reborn.id !== fresh.id;

      return {
        stampedBefore,
        stampedAfter,
        stampedAfterDelete,
        reincarnated,
      };
    });

    expect(
      !result.stampedBefore,
      'fresh repertoire has no bulkLoadedAt',
    ).toBe(true);
    expect(
      result.stampedAfter,
      'addFamilyToRepertoire stamps bulkLoadedAt on completion',
    ).toBe(true);
    expect(
      !result.stampedAfterDelete,
      'a re-created repertoire after delete has no bulkLoadedAt',
    ).toBe(true);
    expect(
      result.reincarnated,
      'deleted + re-ensured repertoire is a new row',
    ).toBe(true);
  },
});
