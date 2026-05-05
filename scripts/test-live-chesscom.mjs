// Ultimate test: import real games from Chess.com, let the queue analyze a few,
// confirm end-to-end success and catch any parsing edge cases.

import { chromium } from 'playwright';

const URL = process.env.URL || 'http://localhost:5173/';
const USERNAME = process.env.USER_CC || 'magnuscarlsen';

const browser = await chromium.launch({ headless: true });
const page = await (await browser.newContext()).newPage();

const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(`[console.error] ${m.text()}`);
});

await page.goto(URL, { waitUntil: 'networkidle' });

// Fetch latest archive, parse a handful of games, insert as pending.
const importResult = await page.evaluate(async (username) => {
  const { fetchArchives, fetchMonth } = await import('/src/api/chesscom.ts');
  const { chessComGameToGame } = await import('/src/import/importer.ts');
  const { upsertGames } = await import('/src/db/queries.ts');

  const archives = await fetchArchives(username);
  // Take the last (most recent) archive
  const lastUrl = archives[archives.length - 1];
  const raw = await fetchMonth(lastUrl);
  // Only keep first 3 standard rapid/blitz games to bound test runtime
  const subset = raw
    .filter((g) => g.rules === 'chess' || !g.rules)
    .filter((g) => g.time_class === 'rapid' || g.time_class === 'blitz')
    .slice(0, 3);

  const mapped = subset.map((g) => chessComGameToGame(g, username));
  // Force fresh IDs so queue picks them up
  for (const g of mapped) g.id = 'live-' + g.id;
  const result = await upsertGames(mapped);
  return {
    archives: archives.length,
    lastMonth: lastUrl,
    rawCount: raw.length,
    imported: mapped.length,
    result,
    ids: mapped.map((g) => g.id),
    pgnLens: mapped.map((g) => g.pgn.length),
  };
}, USERNAME);

console.log('Import:', importResult);
if (!importResult.imported) {
  console.log('No games imported, bailing.');
  await browser.close();
  process.exit(2);
}

// Poll until all imported games are done or errored (max 4 min).
const start = Date.now();
let lastSummary = null;
while (Date.now() - start < 240000) {
  const summary = await page.evaluate(async (ids) => {
    const { db } = await import('/src/db/schema.ts');
    const rows = await Promise.all(ids.map((id) => db.games.get(id)));
    return rows.map((g) => ({
      id: g?.id,
      status: g?.analysisStatus,
      error: g?.analysisError,
    }));
  }, importResult.ids);
  const key = JSON.stringify(summary.map((s) => s.status));
  if (key !== lastSummary) {
    console.log(new Date().toISOString(), JSON.stringify(summary));
    lastSummary = key;
  }
  if (summary.every((s) => s.status === 'done' || s.status === 'error')) break;
  await new Promise((r) => setTimeout(r, 2000));
}

const final = await page.evaluate(async (ids) => {
  const { db } = await import('/src/db/schema.ts');
  const out = [];
  for (const id of ids) {
    const g = await db.games.get(id);
    const a = await db.analyses.get(id);
    out.push({
      id,
      status: g?.analysisStatus,
      error: g?.analysisError,
      opponent: g?.opponent,
      result: g?.result,
      accuracy: g?.accuracy,
      moveCount: a?.moves?.length ?? 0,
    });
  }
  return out;
}, importResult.ids);

console.log('\n=== Final ===');
console.log(JSON.stringify(final, null, 2));

if (pageErrors.length) {
  console.log('\n=== Browser errors ===');
  pageErrors.forEach((e) => console.log(e));
}

const anyError = final.some((f) => f.status === 'error');
await browser.close();
process.exit(anyError ? 1 : 0);
