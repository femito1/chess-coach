// Pin the Learn panel's active-recall loop for a BLACK repertoire.
//
// Why this exists as its own test: Learn has to decide, at every step,
// whether the next move is the user's (ask them to recall it) or the
// opponent's (auto-play it). Getting that from ply parity is tempting and
// wrong — it breaks for Black, and it desynchronises from the board
// entirely when a line can't be fully replayed. The panel derives the
// turn from the FEN instead, exactly as `LineRunner` does, and this test
// pins the observable consequence:
//
//   For a Black repertoire, White's first move must auto-play, and the
//   panel must then be asking Black (the user) to recall THEIR move —
//   with the answer still concealed.

import { runBrowserTest, expect, appendBypass, DEFAULT_URL, pollUntil } from '../harness.mjs';

await runBrowserTest({
  name: 'learn-black-recall',
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

      // Caro-Kann is a Black defence, so the repertoire's colour is black
      // and every line starts with a White move the user must NOT be
      // asked to recall.
      const family = 'Caro-Kann Defense';
      const rep = await ensureFamilyRepertoire(family);
      await addGuidedLinesToRepertoire(rep.id, getVariations(family).slice(0, 3));
      const refreshed = await db.repertoires.get(rep.id);
      return { repertoireId: rep.id, color: refreshed.color };
    });
    expect(setup.color, 'Caro-Kann repertoire is black').toBe('black');

    await page.goto(
      appendBypass(`${DEFAULT_URL}repertoire/${encodeURIComponent(setup.repertoireId)}/drill`),
      { waitUntil: 'networkidle' },
    );

    // Open Learn on the first line offered.
    const firstLearn = page.getByRole('button', { name: 'Learn' }).first();
    await firstLearn.waitFor({ timeout: 15_000 });
    await firstLearn.click();
    const panel = page.locator('[data-testid="learn-panel"]');
    await panel.waitFor({ timeout: 10_000 });

    // White's move auto-plays, then the panel asks the user (Black) to
    // recall theirs. Poll because the auto-play is on a short timer.
    const prompt = await pollUntil(
      async () => {
        const txt = await panel.innerText();
        if (txt.includes('Your move')) return { done: true, value: txt, label: 'your move' };
        return { done: false, label: 'waiting for user turn' };
      },
      { timeoutMs: 15_000 },
    );
    expect(
      prompt.includes('Your move'),
      'panel asks Black to recall their own move',
    ).toBeTruthy();

    // A reveal control must be offered for the user's move (that's the
    // recall affordance), and the panel must not have skipped to the end.
    const revealCount = await page.locator('[data-testid="learn-reveal"]').count();
    expect(revealCount, 'reveal offered for the user move').toBe(1);
    expect(
      prompt.includes("stepped through the whole line"),
      'has not auto-played to the end',
    ).toBeFalsy();

    // Exactly one White move should be on the board so far: the ribbon
    // shows "1." plus a concealed "?" for Black's pending move.
    expect(prompt.includes('?'), 'next move stays concealed').toBeTruthy();
  },
});
