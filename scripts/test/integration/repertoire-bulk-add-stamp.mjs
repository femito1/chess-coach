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
        addGuidedLinesToRepertoire,
        getVariations,
      } = await import('/src/features/openings/library.ts');
      const { deleteRepertoire, enumerateLines } = await import(
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

      // 2. Guided import activates only five recommendations and does not
      // pretend that the whole family was imported.
      const starter = getVariations(family).slice(0, 5);
      await addGuidedLinesToRepertoire(fresh.id, starter);
      const afterGuided = await db.repertoires.get(fresh.id);
      const guidedLeaves = await enumerateLines(fresh.id);

      // 3. After bulk add → bulkLoadedAt is a positive timestamp, while
      // guided active keys remain a small practice scope.
      await addFamilyToRepertoire(fresh.id, family);
      const after = await db.repertoires.get(fresh.id);
      const allLeaves = await enumerateLines(fresh.id);
      const stampedAfter =
        after?.bulkLoadedAt != null && after.bulkLoadedAt > 0;

      // 4. Delete + re-ensure → fresh row, no stamp.
      await deleteRepertoire(fresh.id);
      const reborn = await ensureFamilyRepertoire(family);
      const stampedAfterDelete = reborn.bulkLoadedAt != null;
      const reincarnated = reborn.id !== fresh.id;

      return {
        stampedBefore,
        guidedMode: afterGuided?.learningMode,
        guidedActive: afterGuided?.activeLineKeys?.length ?? 0,
        guidedLeaves: guidedLeaves.length,
        stampedAfter,
        activeAfterBulk: after?.activeLineKeys?.length ?? 0,
        allLeaves: allLeaves.length,
        stampedAfterDelete,
        reincarnated,
      };
    });

    expect(
      !result.stampedBefore,
      'fresh repertoire has no bulkLoadedAt',
    ).toBe(true);
    expect(
      result.guidedMode,
      'guided subset enables guided learning mode',
    ).toBe('guided');
    expect(
      result.guidedActive,
      'guided subset activates exactly five lines',
    ).toBe(5);
    expect(
      result.guidedLeaves <= 5,
      'guided subset creates at most five practice leaves',
    ).toBe(true);
    expect(
      result.stampedAfter,
      'addFamilyToRepertoire stamps bulkLoadedAt on completion',
    ).toBe(true);
    expect(
      result.activeAfterBulk,
      'bulk import preserves the five-line guided scope',
    ).toBe(5);
    expect(
      result.allLeaves >= result.guidedLeaves,
      'bulk import expands stored coverage without shrinking it',
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
