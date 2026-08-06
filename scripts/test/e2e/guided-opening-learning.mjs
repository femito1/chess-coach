import { runBrowserTest, expect, DEFAULT_URL, appendBypass } from '../harness.mjs';

await runBrowserTest({
  name: 'guided-opening-learning',
  async run({ page }) {
    const setup = await page.evaluate(async () => {
      const { db } = await import('/src/db/schema.ts');
      const {
        addFamilyToRepertoire,
        addGuidedLinesToRepertoire,
        ensureFamilyRepertoire,
        getVariations,
      } = await import('/src/features/openings/library.ts');
      const { enumerateLines, lineKey, lineStatsId } = await import(
        '/src/features/repertoire/store.ts'
      );
      const { guidedLineIndices } = await import(
        '/src/features/repertoire/curriculum.ts'
      );

      await db.repertoireLineStats.clear();
      await db.repertoireCards.clear();
      await db.repertoireNodes.clear();
      await db.repertoires.clear();

      const family = 'Italian Game';
      const repertoire = await ensureFamilyRepertoire(family);
      await addGuidedLinesToRepertoire(
        repertoire.id,
        getVariations(family).slice(0, 5),
      );
      await addFamilyToRepertoire(repertoire.id, family);

      const refreshed = await db.repertoires.get(repertoire.id);
      const lines = await enumerateLines(repertoire.id);
      const guided = guidedLineIndices(lines, refreshed.activeLineKeys ?? []);
      for (const index of guided) {
        const line = lines[index];
        const uciKey = lineKey(line.uci);
        await db.repertoireLineStats.put({
          id: lineStatsId(repertoire.id, line.uci),
          repertoireId: repertoire.id,
          uciKey,
          sanPreview: line.san.slice(0, 8).join(' '),
          family,
          attempts: 1,
          completions: 1,
          movesPlayed: 1,
          correctMoves: 1,
          wrongMoves: 0,
          perfectCompletions: 1,
          createdAt: Date.now(),
          lastPracticedAt: Date.now(),
        });
      }
      return {
        repertoireId: repertoire.id,
        active: refreshed.activeLineKeys?.length ?? 0,
        total: lines.length,
      };
    });

    expect(setup.active, 'recommended starter size').toBe(5);
    expect(setup.total, 'bulk repertoire has more than starter').toBeGreaterThan(5);

    await page.goto(
      appendBypass(
        `${DEFAULT_URL}repertoire/${encodeURIComponent(setup.repertoireId)}/drill`,
      ),
      { waitUntil: 'networkidle' },
    );

    await page.getByText(/Drilling \d+ of \d+ lines/).waitFor();
    await page.getByRole('button', { name: 'Include all lines' }).waitFor();
    await page.getByRole('button', { name: 'Add next 2 lines' }).waitFor();

    await page.getByRole('button', { name: 'Include all lines' }).click();
    let allMode;
    for (let attempt = 0; attempt < 20; attempt++) {
      allMode = await page.evaluate(async (id) => {
        const { db } = await import('/src/db/schema.ts');
        return (await db.repertoires.get(id))?.learningMode;
      }, setup.repertoireId);
      if (allMode === 'all') break;
      await page.waitForTimeout(100);
    }
    expect(allMode, 'include-all persists learningMode=all').toBe('all');

    await page.getByRole('button', { name: 'Use recommended set' }).click();
    const nextButton = page.getByRole('button', { name: 'Add next 2 lines' });
    await nextButton.waitFor();
    await nextButton.click();

    let activeAfter = 0;
    for (let attempt = 0; attempt < 40; attempt++) {
      activeAfter = await page.evaluate(async (id) => {
        const { db } = await import('/src/db/schema.ts');
        return (await db.repertoires.get(id))?.activeLineKeys?.length ?? 0;
      }, setup.repertoireId);
      if (activeAfter === 7) break;
      await page.waitForTimeout(100);
    }
    expect(activeAfter, 'mastery unlock appends two lines').toBe(7);
  },
});
