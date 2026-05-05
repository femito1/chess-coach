// Force recompute of all accuracies in the test DB and print comparisons.
import { chromium } from 'playwright';

const URL = process.env.URL || 'http://localhost:5174/';

const browser = await chromium.launch({ headless: true });
const page = await (await browser.newContext()).newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('console', (m) => {
  if (m.text().includes('[queue]')) console.log(m.text());
});

await page.goto(URL, { waitUntil: 'networkidle' });

// Wait for boot-time recompute.
await new Promise((r) => setTimeout(r, 3000));

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
  console.log(`\nMAE:  white=${(tW / results.length).toFixed(2)}  black=${(tB / results.length).toFixed(2)}  n=${results.length}`);
}
await browser.close();
