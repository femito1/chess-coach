// Live test: import real games from Chess.com, let the queue analyze a few,
// confirm end-to-end success and catch any parsing edge cases.

import { runBrowserTest, expect, sleep } from '../harness.mjs';

const USERNAME = process.env.USER_CC || 'magnuscarlsen';

await runBrowserTest({
  name: 'live-chesscom',
  async run({ page, errors }) {
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
    expect(importResult.imported, 'at least one game imported').toBeGreaterThan(0);

    // Poll until all imported games are done or errored (max 4 min).
    const start = Date.now();
    let lastSummary = null;
    while (Date.now() - start < 240_000) {
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
      await sleep(2000);
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

    if (errors.length) {
      console.log('\n=== Browser errors ===');
      for (const e of errors) console.log(e);
    }

    const anyError = final.some((f) => f.status === 'error');
    expect(!anyError, 'no game ended with status=error').toBeTruthy();
    expect(
      final.every((f) => f.moveCount > 0),
      'every imported game produced at least one analyzed move',
    ).toBeTruthy();
  },
});
