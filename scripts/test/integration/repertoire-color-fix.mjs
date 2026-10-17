// A family repertoire stored in the wrong colour (created under older
// `familyColor` rules, or restored from a cloud row written then) is fixed by
// `fixFamilyRepertoireColors`, the every-boot pass in `startAnalysisQueue`:
//
//   - its colour becomes `familyColor(family)`;
//   - its SRS cards end up exactly where a repertoire built in the right colour
//     from the same lines would have them, with fresh schedules;
//   - its per-line stats, which measured the opponent's moves, are cleared;
//   - a repertoire already in the right colour is not touched;
//   - a second run finds nothing to fix.

import { runBrowserTest, expect, sleep } from '../harness.mjs';

await runBrowserTest({
  name: 'repertoire-color-fix',
  async run({ page }) {
    await sleep(800);

    const result = await page.evaluate(async () => {
      const { db } = await import('/src/db/schema.ts');
      const { addLineToRepertoire, familyColor, fixFamilyRepertoireColors, getVariations } =
        await import('/src/features/openings/library.ts');
      const { createRepertoire, enumerateLines, recordLineAttempt } = await import(
        '/src/features/repertoire/store.ts'
      );

      await db.repertoires.clear();
      await db.repertoireNodes.clear();
      await db.repertoireCards.clear();
      await db.repertoireLineStats.clear();

      const family = 'Latvian Gambit';
      const lines = getVariations(family).slice(0, 6);

      // What the old rules produced: the Latvian as White's.
      const wrong = await createRepertoire({ name: family, color: 'white', kind: 'family', family });
      for (const l of lines) await addLineToRepertoire(wrong.id, l);
      await recordLineAttempt(wrong.id, (await enumerateLines(wrong.id))[0]);
      const statsBefore = await db.repertoireLineStats.where('repertoireId').equals(wrong.id).count();

      // The reference: the same lines, in the right colour from the start.
      const right = await createRepertoire({ name: 'reference', color: 'black', kind: 'custom' });
      for (const l of lines) await addLineToRepertoire(right.id, l);

      // Already correct, and must be left alone.
      const caro = await createRepertoire({
        name: 'Caro-Kann Defense',
        color: 'black',
        kind: 'family',
        family: 'Caro-Kann Defense',
      });
      for (const l of getVariations('Caro-Kann Defense').slice(0, 3)) await addLineToRepertoire(caro.id, l);
      const caroCardsBefore = JSON.stringify(
        await db.repertoireCards.where('repertoireId').equals(caro.id).sortBy('id'),
      );
      const caroUpdatedBefore = (await db.repertoires.get(caro.id)).updatedAt;

      const fixed = await fixFamilyRepertoireColors();
      const fixedAgain = await fixFamilyRepertoireColors();

      const shape = async (id) =>
        (await db.repertoireCards.where('repertoireId').equals(id).toArray())
          .map((c) => `${c.fen.split(' ').slice(0, 4).join(' ')} ${c.expectedUci} ${c.srs.repetitions}`)
          .sort();
      const migrated = await shape(wrong.id);
      const reference = await shape(right.id);

      return {
        ruleColor: familyColor(family),
        fixed,
        fixedAgain,
        color: (await db.repertoires.get(wrong.id)).color,
        migrated,
        reference,
        blackToMove: (await db.repertoireCards.where('repertoireId').equals(wrong.id).toArray()).every(
          (c) => c.fen.split(' ')[1] === 'b',
        ),
        statsBefore,
        statsAfter: await db.repertoireLineStats.where('repertoireId').equals(wrong.id).count(),
        caroUntouched:
          JSON.stringify(await db.repertoireCards.where('repertoireId').equals(caro.id).sortBy('id')) ===
            caroCardsBefore && (await db.repertoires.get(caro.id)).updatedAt === caroUpdatedBefore,
      };
    });

    expect(result.ruleColor, 'the Latvian Gambit is Black’s by the current rules').toBe('black');
    expect(result.fixed, 'exactly the wrong-colour repertoire is fixed').toBe(1);
    expect(result.fixedAgain, 'a second run finds nothing').toBe(0);
    expect(result.color, 'its colour now follows the rule').toBe('black');
    expect(result.migrated.length > 0, 'it has cards after the fix').toBe(true);
    expect(result.blackToMove, 'every card is on a position Black is to move in').toBe(true);
    expect(
      JSON.stringify(result.migrated),
      'its cards match a repertoire built in the right colour from the same lines',
    ).toBe(JSON.stringify(result.reference));
    expect(result.statsBefore > 0, 'the fixture recorded line stats').toBe(true);
    expect(result.statsAfter, 'line stats from the wrong side are cleared').toBe(0);
    expect(result.caroUntouched, 'a repertoire already in the right colour is untouched').toBe(true);
  },
});
