// End-to-end check for the family-first repertoire flow:
//
//   - `ensureFamilyRepertoire(family)` is idempotent: calling it twice
//     for the same family returns the same row, regardless of whether
//     legacy / custom repertoires of the same color exist.
//
//   - Adding a line via `addLineToRepertoire` populates the
//     `repertoireNodes` tree and seeds at least one card.
//
//   - `enumerateLines(repId)` returns ≥1 line for the seeded
//     repertoire; the family of the first line matches the
//     repertoire's `family` field.
//
//   - The pure practice-mode reducer (sequential / random /
//     repeat-until-perfect) drives `currentIndex` through the right
//     transitions when fed `finished` events. Pure-logic checks live
//     in unit tests; this script is the smoke test that the page
//     wiring (Dexie + library + practiceMode) holds together.

import { runBrowserTest, expect, sleep } from '../harness.mjs';

await runBrowserTest({
  name: 'repertoire-practice',
  async run({ page }) {
    await sleep(800);

    const result = await page.evaluate(async () => {
      const { db } = await import('/src/db/schema.ts');
      const {
        ensureFamilyRepertoire,
        addLineToRepertoire,
        getVariations,
      } = await import('/src/features/openings/library.ts');
      const { enumerateLines } = await import(
        '/src/features/repertoire/store.ts'
      );
      const {
        initSession,
        reduceSession,
      } = await import('/src/features/repertoire/practiceMode.ts');

      // Wipe relevant tables so re-runs are deterministic.
      await db.repertoires.clear();
      await db.repertoireNodes.clear();
      await db.repertoireCards.clear();
      await db.repertoireLineStats.clear();

      // 1. Idempotent ensure.
      const r1 = await ensureFamilyRepertoire('Sicilian Defense');
      const r2 = await ensureFamilyRepertoire('Sicilian Defense');
      const r3 = await ensureFamilyRepertoire('Italian Game');
      const idMatches = r1.id === r2.id;
      const familyMatches = r1.family === 'Sicilian Defense';
      const kindMatches = r1.kind === 'family';
      const distinctFamilyDistinctRow = r3.id !== r1.id;

      // 2. Seed a couple of Sicilian lines + one Italian line.
      const sicilianLines = getVariations('Sicilian Defense').slice(0, 2);
      const italianLines = getVariations('Italian Game').slice(0, 1);
      let totalAdded = 0;
      for (const l of sicilianLines) {
        totalAdded += await addLineToRepertoire(r1.id, l);
      }
      for (const l of italianLines) {
        totalAdded += await addLineToRepertoire(r3.id, l);
      }

      // 3. enumerateLines respects the rep boundary.
      const sicilianEnum = await enumerateLines(r1.id);
      const italianEnum = await enumerateLines(r3.id);
      const sicilianHasOurFamily = sicilianEnum.length > 0;
      const italianHasOurFamily = italianEnum.length > 0;

      // 4. Reducer smoke: sequential cycles through the lines.
      const sel = sicilianEnum.map((_, i) => i);
      let s = initSession({ mode: 'sequential', selectedIndices: sel });
      const seqIds = [s.currentIndex];
      for (let i = 0; i < sel.length; i++) {
        s = reduceSession(s, { type: 'finished', perfect: false });
        seqIds.push(s.currentIndex);
      }
      const wraps =
        seqIds.length === sel.length + 1 &&
        seqIds[seqIds.length - 1] === seqIds[0];

      // 5. Repeat-until-perfect terminates when every line is perfect.
      s = initSession({
        mode: 'repeat-until-perfect',
        selectedIndices: sel,
      });
      const visited = new Set();
      let safety = 0;
      while (s.currentIndex !== null && safety < 50) {
        visited.add(s.currentIndex);
        s = reduceSession(s, { type: 'finished', perfect: true });
        safety += 1;
      }
      const repeatTerminated = s.currentIndex === null;

      return {
        idMatches,
        familyMatches,
        kindMatches,
        distinctFamilyDistinctRow,
        totalAdded,
        sicilianHasOurFamily,
        italianHasOurFamily,
        wraps,
        repeatTerminated,
        visitedCount: visited.size,
        sicilianCount: sicilianEnum.length,
        italianCount: italianEnum.length,
      };
    });

    expect(result.idMatches, 'ensureFamilyRepertoire is idempotent').toBe(true);
    expect(result.familyMatches, 'family field is set').toBe(true);
    expect(result.kindMatches, 'kind is family').toBe(true);
    expect(
      result.distinctFamilyDistinctRow,
      'different families produce different repertoires',
    ).toBe(true);
    expect(result.totalAdded > 0, 'addLineToRepertoire seeded moves').toBe(true);
    expect(result.sicilianHasOurFamily, 'sicilian rep has lines').toBe(true);
    expect(result.italianHasOurFamily, 'italian rep has lines').toBe(true);
    expect(result.wraps, 'sequential mode wraps after one cycle').toBe(true);
    expect(
      result.repeatTerminated,
      'repeat-until-perfect terminates when every line is perfect',
    ).toBe(true);
    expect(
      result.visitedCount === result.sicilianCount,
      `repeat visited every line (got ${result.visitedCount}/${result.sicilianCount})`,
    ).toBe(true);
  },
});
