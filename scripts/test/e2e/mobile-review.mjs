// Mobile-viewport audit for the data-rich pages (review, weaknesses,
// puzzles). These need a real analyzed game in the DB to render
// anything interesting, so we pull a synthetic PGN through the
// analyzer end-to-end and then walk the relevant routes.
//
// Output: /tmp/mobile-review-*.png + /tmp/mobile-weaknesses-loaded.png.

import { runBrowserTest, expect, sleep, pollUntil, appendBypass, DEFAULT_URL } from '../harness.mjs';

const VIEWPORT = { width: 390, height: 844 };

// Short rapid game with at least one obvious blunder so the weaknesses
// page has motifs to show.
const SAMPLE_PGN = `[Event "Casual rapid"]
[Site "?"]
[Date "2026.05.12"]
[White "me"]
[Black "opp"]
[Result "0-1"]
[TimeControl "600"]
[Termination "opp won by checkmate"]

1. e4 e5 2. Nf3 Nc6 3. Bc4 Nf6 4. Ng5 d5 5. exd5 Nxd5 6. Nxf7 Kxf7 7. Qf3+ Ke6 8. Nc3 Ncb4 9. O-O c6 10. d4 Bd6 11. Bxd5+ cxd5 12. Re1+ Kd7 13. Nxd5 Nxd5 14. Qxd5 Bb4 15. Re3 Re8 16. Rb3 a5 17. d5 Bd6 0-1`;

await runBrowserTest({
  name: 'mobile-review',
  viewport: VIEWPORT,
  failOnPageErrors: false,
  async run({ page }) {
    // Seed a synthetic game and run it through the analyzer.
    const gameId = await page.evaluate(async (pgn) => {
      const { db } = await import('/src/db/schema.ts');
      const id = 'mobile-review-game';
      const now = Date.now();
      await db.games.put({
        id,
        source: 'pgn',
        username: 'me',
        opponent: 'opp',
        userColor: 'white',
        result: 'loss',
        endTime: now,
        timeControl: '600',
        timeClass: 'rapid',
        eco: 'C50',
        opening: 'Italian Game',
        url: 'https://example.com/game',
        pgn,
        analysisStatus: 'pending',
      });
      return id;
    }, SAMPLE_PGN);
    expect(gameId, 'seeded game id').toBeTruthy();

    // Wait for the queue to analyze it.
    await pollUntil(
      async () => {
        const s = await page.evaluate(async (id) => {
          const { db } = await import('/src/db/schema.ts');
          return (await db.games.get(id))?.analysisStatus;
        }, gameId);
        return { done: s === 'done' || s === 'error', value: s, label: s };
      },
      { timeoutMs: 180_000, intervalMs: 1000 },
    );

    // Review page on mobile.
    await page.goto(appendBypass(`${DEFAULT_URL}review/${gameId}`), {
      waitUntil: 'domcontentloaded',
    });
    await sleep(2000);
    await page.screenshot({
      path: '/tmp/mobile-review-start.png',
      fullPage: true,
    });

    // Click forward a few moves so a classification badge renders.
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await sleep(500);
    await page.screenshot({
      path: '/tmp/mobile-review-midgame.png',
      fullPage: true,
    });

    // Page-overflow check — same canonical "broken on mobile" signal.
    const m = await page.evaluate(() => ({
      docW: document.documentElement.scrollWidth,
      winW: window.innerWidth,
    }));
    console.log(`  review page: doc=${m.docW}px win=${m.winW}px overflow=${m.docW - m.winW}px`);
    expect(m.docW - m.winW, 'review page horizontal overflow').toBeAtMost(1);

    // Weaknesses with content.
    await page.goto(appendBypass(`${DEFAULT_URL}weaknesses`), {
      waitUntil: 'domcontentloaded',
    });
    await sleep(1500);
    await page.screenshot({
      path: '/tmp/mobile-weaknesses-loaded.png',
      fullPage: true,
    });
    const w = await page.evaluate(() => ({
      docW: document.documentElement.scrollWidth,
      winW: window.innerWidth,
    }));
    console.log(`  weaknesses page: doc=${w.docW}px win=${w.winW}px overflow=${w.docW - w.winW}px`);
    expect(w.docW - w.winW, 'weaknesses page horizontal overflow').toBeAtMost(1);

    // Games page with one row.
    await page.goto(appendBypass(`${DEFAULT_URL}games`), {
      waitUntil: 'domcontentloaded',
    });
    await sleep(1000);
    await page.screenshot({
      path: '/tmp/mobile-games-loaded.png',
      fullPage: true,
    });
  },
});
