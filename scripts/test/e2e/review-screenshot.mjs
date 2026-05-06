// Open the Review page for the first analyzed game and take screenshots of
// the board + move list for visual inspection.
//
// Output goes to /tmp/review-*.png.
//
// NOTE: this script imports a real game from the Chess.com API, so it
// effectively also depends on chess.com being reachable. It still lives
// in the e2e bucket because its primary purpose is visual capture for
// manual inspection, not API correctness.

import { runBrowserTest, expect } from '../harness.mjs';

await runBrowserTest({
  name: 'review-screenshot',
  viewport: { width: 1400, height: 900 },
  async run({ page }) {
    const firstId = await page.evaluate(async () => {
      const { fetchMonth } = await import('/src/api/chesscom.ts');
      const { chessComGameToGame } = await import('/src/import/importer.ts');
      const { db } = await import('/src/db/schema.ts');
      const raw = await fetchMonth(
        'https://api.chess.com/pub/player/magnuscarlsen/games/2024/01',
      );
      const pick = raw.find(
        (g) =>
          (g.rules === 'chess' || !g.rules) &&
          (g.time_class === 'rapid' || g.time_class === 'blitz'),
      );
      if (!pick) return null;
      const g = chessComGameToGame(pick, 'magnuscarlsen');
      g.id = 'shot-' + g.id;
      g.analysisStatus = 'pending';
      await db.games.put(g);
      return g.id;
    });
    expect(firstId, 'fetched a candidate game from Chess.com').toBeTruthy();

    // Wait for the queue to analyze the inserted game (up to 2 min).
    for (let i = 0; i < 120; i++) {
      const s = await page.evaluate(async (id) => {
        const { db } = await import('/src/db/schema.ts');
        return (await db.games.get(id))?.analysisStatus;
      }, firstId);
      if (s === 'done' || s === 'error') break;
      await page.waitForTimeout(1000);
    }

    // Navigate via hashchange — HashRouter listens to that event.
    await page.evaluate((id) => {
      window.location.hash = `#/review/${id}`;
    }, firstId);
    await page.waitForTimeout(3000);

    await page.screenshot({ path: '/tmp/review-start.png', fullPage: true });
    console.log('Saved /tmp/review-start.png');

    for (let i = 0; i < 6; i++) {
      await page.keyboard.press('ArrowRight');
      await page.waitForTimeout(150);
    }
    await page.screenshot({ path: '/tmp/review-mid.png', fullPage: true });
    console.log('Saved /tmp/review-mid.png');

    await page.keyboard.press('End');
    await page.waitForTimeout(300);
    await page.screenshot({ path: '/tmp/review-end.png', fullPage: true });
    console.log('Saved /tmp/review-end.png');

    const distribution = await page.evaluate(async (id) => {
      const { db } = await import('/src/db/schema.ts');
      const a = await db.analyses.get(id);
      const counts = {};
      for (const m of a.moves) counts[m.classification] = (counts[m.classification] ?? 0) + 1;
      return { total: a.moves.length, counts };
    }, firstId);
    console.log('Move distribution for current game:', JSON.stringify(distribution));
    expect(distribution.total, 'analysis has moves').toBeGreaterThan(0);
  },
});
