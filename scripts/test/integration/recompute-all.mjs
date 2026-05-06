// Force recompute of all accuracies in the test DB and print comparisons.
// Reports MAE vs. Chess.com's accuracy on whichever games have it stored.
// This is a smoke / observation test — it never asserts because the DB
// contents vary per machine. Useful as a manual diagnostic.

import { runBrowserTest, sleep } from '../harness.mjs';

await runBrowserTest({
  name: 'recompute-all',
  async run({ page }) {
    page.on('console', (m) => {
      if (m.text().includes('[queue]')) console.log(m.text());
    });

    // Give the boot-time recompute pass a chance to fire.
    await sleep(3000);

    const results = await page.evaluate(async () => {
      const { db } = await import('/src/db/schema.ts');
      const games = await db.games.where('analysisStatus').equals('done').toArray();
      const out = [];
      for (const g of games) {
        if (!g.chessComAccuracy) continue;
        out.push({
          id: g.id,
          ours: g.accuracy,
          cc: g.chessComAccuracy,
          diffW: g.accuracy ? +(g.accuracy.white - g.chessComAccuracy.white).toFixed(1) : null,
          diffB: g.accuracy ? +(g.accuracy.black - g.chessComAccuracy.black).toFixed(1) : null,
        });
      }
      return out;
    });

    let tW = 0, tB = 0;
    for (const r of results) {
      console.log(
        `${r.id.padEnd(18)} ours=${r.ours?.white.toString().padStart(5)}/${r.ours?.black.toString().padStart(5)}  cc=${r.cc.white.toFixed(1).padStart(5)}/${r.cc.black.toFixed(1).padStart(5)}  diff=${String(r.diffW).padStart(6)}/${String(r.diffB).padStart(6)}`,
      );
      tW += Math.abs(r.diffW);
      tB += Math.abs(r.diffB);
    }
    if (results.length) {
      console.log(
        `\nMAE:  white=${(tW / results.length).toFixed(2)}  black=${(tB / results.length).toFixed(2)}  n=${results.length}`,
      );
    } else {
      console.log('No games with stored chessComAccuracy found in DB — skipping comparison.');
    }
  },
});
