// Pin the drill page's selection against the line list being rebuilt.
//
// Adding a line bumps the repertoire's `updatedAt` and `activeLineKeys`,
// which re-enumerates the lines — and `enumerateLines` walks the node tree,
// so a new leaf renumbers every leaf after it. The page used to answer that
// rebuild by re-seeding scope + selection from the guided plan, which threw
// away whatever the user had ticked by hand ("it added the line to my
// repertoire but reset my selections"). Selection is now held by line KEY
// with the session's indices remapped across the rebuild, so this test
// drives the exact reported sequence:
//
//   1. hand-edit the drill selection (untick a line),
//   2. tick a not-yet-added library row and press "Add 1 selected",
//   3. assert the hand-edit survived, the added line joined the drill set,
//      and the line under the runner did not change.
//
// The added line is chosen so it is neither a prefix nor an extension of an
// existing leaf. That matters: adding a line that EXTENDS a leaf deepens it,
// which legitimately changes that leaf's key (and therefore which line a
// shallow picker row proxies), and the assertions below would be testing
// leaf identity rather than selection persistence.

import { runBrowserTest, expect, appendBypass, DEFAULT_URL, pollUntil } from '../harness.mjs';

await runBrowserTest({
  name: 'drill-selection-survives-add',
  viewport: { width: 1280, height: 1024 },
  waitUntil: 'domcontentloaded',
  async run({ page }) {
    await page.waitForSelector('a[href="/repertoire"]', { timeout: 10_000 });

    const setup = await page.evaluate(async () => {
      const { db } = await import('/src/db/schema.ts');
      const { ensureFamilyRepertoire, addGuidedLinesToRepertoire, getVariations } =
        await import('/src/features/openings/library.ts');
      const { enumerateLines } = await import('/src/features/repertoire/store.ts');

      await db.repertoireLineStats.clear();
      await db.repertoireCards.clear();
      await db.repertoireNodes.clear();
      await db.repertoires.clear();

      const family = 'Italian Game';
      const rep = await ensureFamilyRepertoire(family);
      const variations = getVariations(family);
      await addGuidedLinesToRepertoire(rep.id, variations.slice(0, 8));

      const leaves = (await enumerateLines(rep.id)).map((l) => l.uci.join(' '));
      // A line that shares no ancestry with any current leaf, so adding it
      // creates a leaf without deepening one.
      const standalone = variations.find((line) => {
        const key = line.uci.join(' ');
        return leaves.every(
          (leaf) => leaf !== key && !leaf.startsWith(`${key} `) && !key.startsWith(`${leaf} `),
        );
      });
      return {
        repertoireId: rep.id,
        leafCount: leaves.length,
        addName: standalone?.variation ?? '',
        // Numbered SAN, matching the `title` the picker puts on every row.
        addTitle: standalone
          ? standalone.pgn.replace(/(\d+)\.\s*/g, (_, n) => `${n}. `).trim()
          : '',
      };
    });
    expect(Boolean(setup.addTitle), 'found a standalone library line to add').toBe(true);

    await page.goto(
      appendBypass(`${DEFAULT_URL}repertoire/${encodeURIComponent(setup.repertoireId)}/drill`),
      { waitUntil: 'networkidle' },
    );
    await page.locator('li:has-text("not added")').first().waitFor({ timeout: 20_000 });

    /** Every picker row: its name, its moves (the row `title`), whether its
     *  drill box is ticked, plus the runner's current line and the header. */
    const readState = () =>
      page.evaluate(() => {
        const rows = [];
        for (const li of document.querySelectorAll('li')) {
          const box = li.querySelector('input[type=checkbox]');
          if (!box) continue;
          rows.push({
            name: li.querySelector('label span.text-sm')?.textContent?.trim() ?? '',
            moves: (li.querySelector('label')?.getAttribute('title') ?? '').trim(),
            checked: box.checked,
            notAdded: li.textContent.includes('not added'),
          });
        }
        return {
          rows,
          runnerLine:
            document.querySelector('.card .font-mono.text-sm')?.textContent?.trim() ?? '',
        };
      });

    // ── 1. Hand-edit the selection: untick the first ticked row. ───────
    const before = await readState();
    const untickTarget = before.rows.find((r) => r.checked);
    expect(Boolean(untickTarget), 'some line starts out ticked').toBe(true);
    await page
      .locator(`li:has(label[title="${untickTarget.moves}"]) input[type=checkbox]`)
      .first()
      .uncheck();
    await page.waitForTimeout(300);
    const afterUntick = await readState();
    const tickedAfterUntick = afterUntick.rows.filter((r) => r.checked).length;
    expect(
      afterUntick.rows.find((r) => r.moves === untickTarget.moves)?.checked,
      'the untick registered',
    ).toBe(false);

    // ── 2. Tick the standalone not-added row and add it. ───────────────
    const addRow = page.locator(`li:has(label[title="${setup.addTitle}"])`);
    await addRow.first().waitFor({ timeout: 10_000 });
    await addRow.first().locator('input[type=checkbox]').check();
    await page.getByRole('button', { name: /Add 1 selected/ }).click();
    await pollUntil(
      async () => {
        const n = await page.evaluate(async (id) => {
          const { enumerateLines } = await import('/src/features/repertoire/store.ts');
          return (await enumerateLines(id)).length;
        }, setup.repertoireId);
        return { done: n > setup.leafCount, value: n, label: `leaves=${n}` };
      },
      { timeoutMs: 20_000 },
    );
    // Let the rebuilt line list land in the page.
    await page.waitForTimeout(1500);

    // ── 3. The hand-edit survived, the add landed, the drill didn't move.
    const after = await readState();
    expect(
      after.rows.find((r) => r.moves === untickTarget.moves)?.checked,
      'the line the user unticked is still unticked after the add',
    ).toBe(false);

    const added = after.rows.find((r) => r.moves === setup.addTitle);
    expect(added?.notAdded, 'the added line is no longer marked "not added"').toBe(false);
    expect(added?.checked, 'the added line joined the drill set').toBe(true);

    expect(
      after.rows.filter((r) => r.checked).length,
      'exactly one row joined the ticked set — nothing was re-seeded',
    ).toBe(tickedAfterUntick + 1);

    expect(
      after.runnerLine,
      'the line under the runner survived the renumbering',
    ).toBe(afterUntick.runnerLine);
  },
});
