// Open the Review page for the first analyzed game and take screenshots of
// the board + move list for visual inspection.
//
// Output goes to /tmp/review-*.png.
//
// Run: URL=http://localhost:5176/ node scripts/test-review-screenshot.mjs

import { chromium } from 'playwright';

const URL = process.env.URL || 'http://localhost:5176/';

const browser = await chromium.launch({ headless: true });
const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('console', (m) => {
  if (m.type() === 'error') console.log('[console.error]', m.text());
});

await page.goto(URL, { waitUntil: 'networkidle' });

// Import + analyze a single game inline so the screenshot session has data.
const firstId = await page.evaluate(async () => {
  const { fetchMonth } = await import('/src/api/chesscom.ts');
  const { chessComGameToGame } = await import('/src/import/importer.ts');
  const { db } = await import('/src/db/schema.ts');
  const raw = await fetchMonth('https://api.chess.com/pub/player/magnuscarlsen/games/2024/01');
  const pick = raw.find((g) => (g.rules === 'chess' || !g.rules) && (g.time_class === 'rapid' || g.time_class === 'blitz'));
  if (!pick) return null;
  const g = chessComGameToGame(pick, 'magnuscarlsen');
  g.id = 'shot-' + g.id;
  g.analysisStatus = 'pending';
  await db.games.put(g);
  return g.id;
});
if (!firstId) {
  console.error('No candidate game found.');
  await browser.close();
  process.exit(1);
}
// Wait for the queue to analyze it.
for (let i = 0; i < 120; i++) {
  const s = await page.evaluate(async (id) => {
    const { db } = await import('/src/db/schema.ts');
    return (await db.games.get(id))?.analysisStatus;
  }, firstId);
  if (s === 'done' || s === 'error') break;
  await page.waitForTimeout(1000);
}

// Navigate via history.pushState / hash change — HashRouter listens to
// `hashchange`, so we set the hash manually.
await page.evaluate((id) => {
  window.location.hash = `#/review/${id}`;
}, firstId);
await page.waitForTimeout(3000);

await page.screenshot({ path: '/tmp/review-start.png', fullPage: true });
console.log('Saved /tmp/review-start.png');

// Advance through several moves to see badges.
for (let i = 0; i < 6; i++) {
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(150);
}
await page.screenshot({ path: '/tmp/review-mid.png', fullPage: true });
console.log('Saved /tmp/review-mid.png');

// Jump to end.
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

await browser.close();
