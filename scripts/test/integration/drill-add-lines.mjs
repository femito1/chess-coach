// Pin the drill-page bulk "Add N selected" flow and its idempotency.
//
// The unified picker lets you tick library lines that aren't in your
// repertoire yet and add them in one action. This test drives that UI —
// ticking two not-added rows and clicking "Add N selected" — then checks
// that the repertoire's activeLineKeys and SRS cards reflect exactly
// those additions, and that re-adding the same lines is a no-op at the
// node/card level (idempotent).

import { runBrowserTest, expect, appendBypass, DEFAULT_URL, pollUntil } from '../harness.mjs';

await runBrowserTest({
  name: 'drill-add-lines',
  viewport: { width: 1280, height: 1024 },
  waitUntil: 'domcontentloaded',
  async run({ page }) {
    await page.waitForSelector('a[href="/repertoire"]', { timeout: 10_000 });

    const setup = await page.evaluate(async () => {
      const { db } = await import('/src/db/schema.ts');
      const { ensureFamilyRepertoire, addGuidedLinesToRepertoire, getVariations } =
        await import('/src/features/openings/library.ts');

      await db.repertoireLineStats.clear();
      await db.repertoireCards.clear();
      await db.repertoireNodes.clear();
      await db.repertoires.clear();

      const family = 'Italian Game';
      const rep = await ensureFamilyRepertoire(family);
      await addGuidedLinesToRepertoire(rep.id, getVariations(family).slice(0, 5));
      const refreshed = await db.repertoires.get(rep.id);
      return {
        repertoireId: rep.id,
        startActive: refreshed.activeLineKeys?.length ?? 0,
      };
    });
    expect(setup.startActive, 'starter set is 5 lines').toBe(5);

    await page.goto(
      appendBypass(`${DEFAULT_URL}repertoire/${encodeURIComponent(setup.repertoireId)}/drill`),
      { waitUntil: 'networkidle' },
    );

    // Tick two not-added rows' add checkboxes.
    const notAdded = page.locator('li:has-text("not added")');
    await notAdded.first().waitFor({ timeout: 15_000 });
    await notAdded.nth(0).locator('input[type="checkbox"]').check();
    await notAdded.nth(1).locator('input[type="checkbox"]').check();

    // The bulk-add button reflects the count; click it.
    const addButton = page.getByRole('button', { name: /Add 2 selected/ });
    await addButton.waitFor({ timeout: 5_000 });
    await addButton.click();

    // activeLineKeys should grow by exactly two.
    const afterAdd = await pollUntil(
      async () => {
        const n = await page.evaluate(async (id) => {
          const { db } = await import('/src/db/schema.ts');
          return (await db.repertoires.get(id))?.activeLineKeys?.length ?? 0;
        }, setup.repertoireId);
        return { done: n >= setup.startActive + 2, value: n, label: `active=${n}` };
      },
      { timeoutMs: 20_000 },
    );
    expect(afterAdd, 'bulk add appends exactly two lines').toBe(setup.startActive + 2);

    // Idempotency: re-adding the same two lines must not duplicate nodes
    // or cards. Capture counts, re-run the add path with the same lines,
    // and assert the counts are unchanged.
    const idem = await page.evaluate(async (id) => {
      const { db } = await import('/src/db/schema.ts');
      const { addGuidedLinesToRepertoire, getVariations } = await import(
        '/src/features/openings/library.ts'
      );
      const rep = await db.repertoires.get(id);
      const activeKeys = new Set(rep.activeLineKeys ?? []);
      // The two most recently added lines are the ones beyond the first 5
      // guided; reconstruct them from the library by key.
      const added = getVariations('Italian Game').filter((l) =>
        activeKeys.has(l.uci.join(' ')),
      );
      const nodesBefore = await db.repertoireNodes.where('repertoireId').equals(id).count();
      const cardsBefore = await db.repertoireCards.where('repertoireId').equals(id).count();
      const keysBefore = (await db.repertoires.get(id)).activeLineKeys?.length ?? 0;
      await addGuidedLinesToRepertoire(id, added);
      const nodesAfter = await db.repertoireNodes.where('repertoireId').equals(id).count();
      const cardsAfter = await db.repertoireCards.where('repertoireId').equals(id).count();
      const keysAfter = (await db.repertoires.get(id)).activeLineKeys?.length ?? 0;
      return { nodesBefore, nodesAfter, cardsBefore, cardsAfter, keysBefore, keysAfter };
    }, setup.repertoireId);

    expect(idem.nodesAfter, 'nodes unchanged on repeat add').toBe(idem.nodesBefore);
    expect(idem.cardsAfter, 'cards unchanged on repeat add').toBe(idem.cardsBefore);
    expect(idem.keysAfter, 'activeLineKeys unchanged on repeat add').toBe(idem.keysBefore);
  },
});
