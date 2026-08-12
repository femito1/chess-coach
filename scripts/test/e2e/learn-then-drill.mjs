// Pin the drill-page "find a line you've never seen → Learn it → Drill
// it" flow — the acquisition path the difficulty/learn feature exists to
// provide. The old drill page only listed lines already in the
// repertoire; the unified picker now also lists library lines you could
// add, tiered Easy/Medium/Hard, each with a "Learn" step (active recall
// on the board) that hands straight off into drilling.
//
// Story:
//   1. Seed a family repertoire with only the 5 guided starter lines, so
//      the library still has many NOT-yet-added lines to discover.
//   2. Open the drill page; the picker lists a "not added" library line.
//   3. Click its "Learn" — the LearnPanel mounts.
//   4. Reveal a couple of moves (active recall; no score kept), then
//      click "Drill this line".
//   5. Assert the line was imported (activeLineKeys grew) and the drill
//      runner mounted on it (the Learn panel is gone, a board is shown).

import { runBrowserTest, expect, appendBypass, DEFAULT_URL, pollUntil } from '../harness.mjs';

await runBrowserTest({
  name: 'learn-then-drill',
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

    // The picker lists library lines not yet added, marked "not added".
    const notAddedRow = page.locator('li:has-text("not added")').first();
    await notAddedRow.waitFor({ timeout: 15_000 });

    // Remember WHICH line we're about to learn, so we can assert later
    // that the drill runner mounted on exactly this line. Without this the
    // test passes as long as *some* board renders — which it does even
    // when the handoff is broken and the session falls back to another
    // line. That false pass is the whole reason this assertion exists.
    const learnedVariation = (
      await notAddedRow.locator('label span.text-sm').first().innerText()
    ).trim();
    expect(learnedVariation.length > 0, 'captured the variation name').toBeTruthy();

    // Open Learn for that line.
    await notAddedRow.getByRole('button', { name: 'Learn' }).click();
    await page.locator('[data-testid="learn-panel"]').waitFor({ timeout: 10_000 });

    // The Learn panel must be showing the line we clicked.
    const panelTitle = (
      await page.locator('[data-testid="learn-panel"]').innerText()
    );
    expect(
      panelTitle.includes(learnedVariation),
      `Learn panel shows the chosen line (${learnedVariation})`,
    ).toBeTruthy();

    // Active recall: reveal a couple of the user's moves. The reveal
    // button is only present while there's a user move left to guess; if
    // it's gone we've reached the end, which is fine.
    for (let i = 0; i < 2; i++) {
      const reveal = page.locator('[data-testid="learn-reveal"]');
      if ((await reveal.count()) === 0) break;
      await reveal.click();
      await page.waitForTimeout(300);
    }

    // Hand off into drilling this line.
    await page.locator('[data-testid="learn-drill"]').click();

    // The line should now be imported…
    const grew = await pollUntil(
      async () => {
        const n = await page.evaluate(async (id) => {
          const { db } = await import('/src/db/schema.ts');
          return (await db.repertoires.get(id))?.activeLineKeys?.length ?? 0;
        }, setup.repertoireId);
        return { done: n > setup.startActive, value: n, label: `active=${n}` };
      },
      { timeoutMs: 20_000 },
    );
    expect(grew, 'drilling a discovered line imports it').toBeAtLeast(setup.startActive + 1);

    // …and the drill runner should be mounted (Learn panel gone, board up).
    await page.locator('[data-testid="learn-panel"]').waitFor({
      state: 'detached',
      timeout: 10_000,
    });
    const boards = await page.locator('.cg-wrap').count();
    expect(boards, 'a board is rendered after handing off to drilling').toBeAtLeast(1);

    // THE load-bearing assertion: the runner must be drilling the line we
    // just learned, not whatever the session queue happened to pick. The
    // focused-drill banner names it.
    const focusBanner = page.locator('text=/Drilling one line:/');
    await focusBanner.waitFor({ timeout: 10_000 });
    const bannerText = await focusBanner.innerText();
    expect(
      bannerText.includes(learnedVariation),
      `drilling the learned line (banner="${bannerText}", learned="${learnedVariation}")`,
    ).toBeTruthy();

    // Structural check that the runner is drilling EXACTLY this line and
    // not a deeper repertoire leaf that merely extends it (which would
    // test moves Learn never showed — the trap this feature exists to
    // remove). The status bar renders "<ply>/<total> ply", so compare its
    // total against the library line's own length.
    const expectedPlies = await page.evaluate(async (variation) => {
      const { getVariations } = await import('/src/features/openings/library.ts');
      const target = getVariations('Italian Game').find(
        (l) => (l.variation || 'Mainline') === variation,
      );
      return target ? target.uci.length : -1;
    }, learnedVariation);
    expect(expectedPlies, 'found the learned line in the library').toBeAtLeast(1);

    const statusText = await pollUntil(
      async () => {
        const el = page.locator('text=/\\d+\\/\\d+ ply/').first();
        const n = await el.count();
        if (n === 0) return { done: false, label: 'waiting for status bar' };
        const txt = await el.innerText();
        return { done: true, value: txt, label: txt.trim() };
      },
      { timeoutMs: 15_000 },
    );
    const totalPly = Number(/\d+\/(\d+) ply/.exec(statusText)?.[1] ?? -1);
    expect(
      totalPly,
      `drilling the learned line's own length (status="${statusText.trim()}", learned=${expectedPlies} ply)`,
    ).toBe(expectedPlies);
  },
});
