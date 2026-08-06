import { runBrowserTest, expect, DEFAULT_URL, appendBypass } from '../harness.mjs';

/**
 * Deep links from the dashboard's "win rate by opening" list.
 *
 * Two destinations, picked per row:
 *   - No repertoire for that family → `/openings?family=<canonical>`,
 *     which selects the family and flashes its sidebar row.
 *   - Repertoire exists            → `/repertoire?highlight=<repId>`,
 *     which scrolls that card into view and flashes it.
 *
 * The regression this pins: chart rows carry the *game-derived* family
 * spelling, which for Chess.com imports comes from an ECO-URL slug with
 * every hyphen flattened to a space ("Caro Kann Defense"). The library's
 * names come from Lichess and keep the punctuation and diacritics
 * ("Caro-Kann Defense", "Réti Opening"). An exact-equality check meant
 * those rows rendered no link at all.
 */
await runBrowserTest({
  name: 'dashboard-opening-deeplinks',
  async run({ page }) {
    // Two games whose `opening` uses the flattened chess.com spelling —
    // exactly what `parseOpeningFromEcoUrl` produces. Caro-Kann gets a
    // repertoire (→ repertoire link), Réti does not (→ library link).
    const setup = await page.evaluate(async () => {
      const { db } = await import('/src/db/schema.ts');
      const { ensureFamilyRepertoire } = await import(
        '/src/features/openings/library.ts'
      );

      await db.repertoireLineStats.clear();
      await db.repertoireCards.clear();
      await db.repertoireNodes.clear();
      await db.repertoires.clear();
      await db.games.clear();

      const base = {
        source: 'chesscom',
        username: 'tester',
        opponent: 'someone',
        userColor: 'black',
        result: 'win',
        timeClass: 'blitz',
        timeControl: '300',
        pgn: '1. e4 c6',
        fen: '',
        importedAt: Date.now(),
        analysisStatus: 'pending',
      };
      await db.games.bulkPut([
        // "Caro Kann Defense" — no hyphen, as the importer emits it.
        {
          ...base,
          id: 'g-ck-1',
          url: 'https://x/1',
          opening: 'Caro Kann Defense: Advance Variation',
          eco: 'B12',
          endTime: Date.now() - 4000,
          userRating: 1500,
        },
        // "Reti Opening" — no diacritic, as the importer emits it.
        {
          ...base,
          id: 'g-reti-1',
          url: 'https://x/2',
          userColor: 'white',
          result: 'loss',
          opening: 'Reti Opening: Kings Indian Attack',
          eco: 'A05',
          endTime: Date.now() - 3000,
          userRating: 1500,
        },
      ]);

      // Repertoire for Caro-Kann only, under the CANONICAL spelling —
      // the resolver has to bridge the two.
      const rep = await ensureFamilyRepertoire('Caro-Kann Defense');
      return { repId: rep.id };
    });

    await page.goto(appendBypass(`${DEFAULT_URL}dashboard`), {
      waitUntil: 'networkidle',
    });

    // Both rows must offer a link. Before the fix, neither did.
    const repLink = page.getByRole('link', {
      name: /Go to your Caro-Kann Defense repertoire/,
    });
    const libLink = page.getByRole('link', {
      name: /View Réti Opening in the openings library/,
    });
    await repLink.waitFor({ timeout: 15000 });
    await libLink.waitFor({ timeout: 15000 });

    // The library link must carry the canonical name, or the openings
    // page can't resolve a family and renders the empty state.
    const libHref = await libLink.getAttribute('href');
    expect(
      decodeURIComponent(libHref).includes('family=Réti Opening'),
      'library link uses canonical family spelling',
    ).toBe(true);

    const repHref = await repLink.getAttribute('href');
    expect(
      repHref.includes(`highlight=${encodeURIComponent(setup.repId)}`),
      'repertoire link targets the existing repertoire id',
    ).toBe(true);

    // ── Library deep link ───────────────────────────────────────────
    await libLink.click();
    await page.getByRole('heading', { name: 'Réti Opening' }).waitFor();

    // Family row flashes, and the param is consumed so a reload / back
    // doesn't re-fire it.
    const flashed = await page
      .locator('li.flash-highlight', { hasText: 'Réti Opening' })
      .count();
    expect(flashed, 'deep-linked family row flashes').toBe(1);
    expect(
      new URL(page.url()).searchParams.has('family'),
      'family param is consumed on arrival',
    ).toBe(false);

    // Flash clears itself; the selection must survive it.
    await page.waitForTimeout(2400);
    expect(
      await page.locator('.flash-highlight').count(),
      'flash clears after the animation',
    ).toBe(0);
    await page.getByRole('heading', { name: 'Réti Opening' }).waitFor();

    // ── Repertoire deep link ───────────────────────────────────────
    await page.goto(appendBypass(`${DEFAULT_URL}dashboard`), {
      waitUntil: 'networkidle',
    });
    await repLink.waitFor({ timeout: 15000 });
    await repLink.click();

    const flashedCard = page.locator('.card.flash-highlight');
    await flashedCard.waitFor({ timeout: 10000 });
    expect(
      (await flashedCard.innerText()).includes('Caro-Kann Defense'),
      'flashed card is the Caro-Kann repertoire',
    ).toBe(true);
    expect(
      new URL(page.url()).searchParams.has('highlight'),
      'highlight param is consumed on arrival',
    ).toBe(false);

    await page.waitForTimeout(2400);
    expect(
      await page.locator('.flash-highlight').count(),
      'repertoire flash clears after the animation',
    ).toBe(0);
  },
});
