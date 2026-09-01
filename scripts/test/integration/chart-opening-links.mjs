// Pin that a win-rate chart row still links to the library when the two
// datasets disagree on the opening's NAME.
//
// Chess.com's ECO slug calls 1.g3 "King's Fianchetto Opening"; the bundled
// Lichess data calls the same opening "Hungarian Opening". They share no
// prefix, so `resolveOpeningFamily`'s three prefix-based stages all miss and the
// row used to render with no link — which reads as "this opening isn't in the
// library" when it is. The fallback identifies it from the game's moves.
//
// The assertion is on the link's *target*, not just on a link existing: the row
// has to point at the canonical family the library actually indexes, or the
// openings page can't select it.

import { runBrowserTest, expect, appendBypass, DEFAULT_URL, pollUntil } from '../harness.mjs';

const FIANCHETTO_PGN = `[Event "Live Chess"]
[Site "Chess.com"]
[White "tester"]
[Black "opponent"]
[Result "0-1"]
[ECO "A00"]
[ECOUrl "https://www.chess.com/openings/Kings-Fianchetto-Opening"]

1. g3 e5 2. Bg2 d5 3. d3 Nf6 0-1`;

await runBrowserTest({
  name: 'chart-opening-links',
  viewport: { width: 1280, height: 1024 },
  waitUntil: 'domcontentloaded',
  async run({ page }) {
    await page.waitForSelector('a[href="/dashboard"]', { timeout: 10_000 });

    const seeded = await page.evaluate(async (pgn) => {
      const { db } = await import('/src/db/schema.ts');
      const { resolveOpeningFamily } = await import('/src/features/openings/library.ts');
      await db.games.clear();
      const rows = [];
      for (let i = 0; i < 4; i++) {
        rows.push({
          id: `kf-${i}`,
          url: `https://example.invalid/kf/${i}`,
          source: 'chesscom',
          username: 'tester',
          userColor: 'white',
          opponent: 'opponent',
          result: i === 0 ? 'win' : 'loss',
          timeControl: '600',
          timeClass: 'rapid',
          endTime: 1_700_000_000 + i * 3600,
          // Exactly what parseOpeningFromEcoUrl emits for this slug.
          opening: 'Kings Fianchetto Opening',
          eco: 'A00',
          pgn,
          importedAt: Date.now(),
          analysisStatus: 'done',
        });
      }
      await db.games.bulkPut(rows);
      return {
        // The precondition: the name genuinely does not resolve.
        byName: resolveOpeningFamily('Kings Fianchetto Opening'),
      };
    }, FIANCHETTO_PGN);

    expect(
      seeded.byName,
      'precondition: the name is unresolvable, so the fallback is what is under test',
    ).toBe(null);

    await page.goto(appendBypass(`${DEFAULT_URL}dashboard`), {
      waitUntil: 'networkidle',
    });

    const href = await pollUntil(
      async () => {
        const found = await page.evaluate(() => {
          const rows = Array.from(document.querySelectorAll('li'));
          const row = rows.find((li) =>
            li.textContent?.includes('Kings Fianchetto Opening'),
          );
          const link = row?.querySelector('a[href*="/openings"], a[href*="/repertoire"]');
          return link ? link.getAttribute('href') : '';
        });
        return { done: Boolean(found), value: found, label: `href: ${found || '(none yet)'}` };
      },
      { timeoutMs: 20_000 },
    );

    expect(
      href.includes('Hungarian%20Opening'),
      'row links to the canonical family the library indexes',
    ).toBeTruthy();
  },
});
