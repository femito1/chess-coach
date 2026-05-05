// Quick diagnostic: connect to a running Chrome via Playwright, snapshot the
// IndexedDB games, and report status counts + a sample of error messages.
//
//   URL=http://localhost:5173/ node scripts/check-errors.mjs

import { chromium } from 'playwright';

const URL = process.env.URL || 'http://localhost:5173/';

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext();
const page = await ctx.newPage();

const consoleErrors = [];
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text());
});
page.on('pageerror', (e) => consoleErrors.push(`[pageerror] ${e.message}`));

await page.goto(URL, { waitUntil: 'networkidle' });

const report = await page.evaluate(async () => {
  const { db } = await import('/src/db/schema.ts');
  const all = await db.games.toArray();
  const counts = { pending: 0, running: 0, done: 0, error: 0 };
  const errorGroups = new Map();
  for (const g of all) {
    counts[g.analysisStatus] = (counts[g.analysisStatus] ?? 0) + 1;
    if (g.analysisStatus === 'error') {
      const key = (g.analysisError ?? '<no message>').slice(0, 200);
      const arr = errorGroups.get(key) ?? [];
      arr.push({ id: g.id, opponent: g.opponent, endTime: g.endTime });
      errorGroups.set(key, arr);
    }
  }
  const groups = [...errorGroups.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([msg, items]) => ({ msg, count: items.length, sample: items.slice(0, 3) }));
  return { total: all.length, counts, errorGroups: groups };
});

console.log(JSON.stringify(report, null, 2));

if (consoleErrors.length) {
  console.log('\n=== Live console errors during page load ===');
  for (const e of consoleErrors) console.log(e);
}

await browser.close();
