// Verify `importLastNMonths` (`src/features/import/auto.ts`):
//
//   - Sorts archives newest-first and slices to `n` months.
//   - For each archive: fetches, maps via importer, upserts to Dexie,
//     records an ImportRecord.
//   - Calls onProgress once per archive with the cumulative counters.
//   - Returns a summary that matches what hit the DB.
//
// We stub chess.com via Playwright's `page.route` so the test is fast
// and deterministic (no live API). The fixture archives + games are
// inlined below.

import { runBrowserTest, expect, DEFAULT_URL, appendBypass } from '../harness.mjs';

// Three synthetic archive URLs. The function under test must sort them
// newest-first and slice to N. Order returned by the chess.com API is
// chronological (oldest-first) so we emit them in that order; the
// production code is responsible for the reorder.
const ARCHIVES = [
  'https://api.chess.com/pub/player/auto-import-tester/games/2025/01',
  'https://api.chess.com/pub/player/auto-import-tester/games/2025/02',
  'https://api.chess.com/pub/player/auto-import-tester/games/2025/03',
];

/** Return a chess.com-shaped game for a given month. */
function fakeGame(year, month, idx) {
  const endTime = Math.floor(new Date(`${year}-${String(month).padStart(2, '0')}-15T12:00:00Z`).getTime() / 1000);
  return {
    url: `https://chess.com/game/live/${year}-${month}-${idx}`,
    pgn: `[Event "Live Chess"]\n[Site "Chess.com"]\n[Date "${year}.${String(month).padStart(2, '0')}.15"]\n[White "auto-import-tester"]\n[Black "opp${idx}"]\n[Result "1-0"]\n[ECO "C50"]\n[Opening "Italian Game"]\n[TimeControl "600"]\n[EndTime "12:00:00 PST"]\n\n1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 1-0`,
    time_control: '600',
    time_class: 'rapid',
    end_time: endTime,
    rated: true,
    fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    white: { username: 'auto-import-tester', rating: 1500, result: 'win', '@id': 'auto-import-tester' },
    black: { username: `opp${idx}`, rating: 1480, result: 'lose', '@id': `opp${idx}` },
    eco: 'C50',
    opening: 'Italian Game',
  };
}

await runBrowserTest({
  name: 'auto-import',
  async run({ page }) {
    // Wipe any previous state so we get a clean run regardless of
    // sibling tests' side effects.
    await page.evaluate(async () => {
      const { db } = await import('/src/db/schema.ts');
      await db.games.clear();
      await db.importRecords.clear();
    });

    // Intercept the two chess.com endpoints. Playwright's `page.route`
    // pattern matching is glob-on-URL; the archives endpoint matches a
    // distinct path so we register two routes.
    await page.route('**/pub/player/auto-import-tester/games/archives', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ archives: ARCHIVES }),
      });
    });
    await page.route('**/pub/player/auto-import-tester/games/*/*', (route) => {
      const url = route.request().url();
      const match = url.match(/\/(\d{4})\/(\d{2})$/);
      if (!match) {
        route.fulfill({ status: 404, body: 'no match' });
        return;
      }
      const year = Number(match[1]);
      const month = Number(match[2]);
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          games: [fakeGame(year, month, 1), fakeGame(year, month, 2)],
        }),
      });
    });

    // The harness already navigated with the bypass on, but we re-goto
    // explicitly so we have a stable baseline (the routing rules above
    // are page-context-scoped and applied before the import call).
    await page.goto(appendBypass(DEFAULT_URL), { waitUntil: 'networkidle' });

    // Pull only the last 2 months. Expect: 2025/03 and 2025/02 land,
    // 2025/01 does NOT (it's the oldest, and we sliced to n=2).
    const result = await page.evaluate(async () => {
      const { importLastNMonths } = await import('/src/features/import/auto.ts');
      const progressEvents = [];
      const summary = await importLastNMonths(
        'auto-import-tester',
        2,
        { onProgress: (p) => progressEvents.push(p) },
      );

      const { db } = await import('/src/db/schema.ts');
      const allGames = await db.games.toArray();
      const allRecords = await db.importRecords.toArray();

      return {
        summary,
        progressEvents,
        gamesInDb: allGames.length,
        recordCount: allRecords.length,
        recordYears: allRecords.map((r) => `${r.year}-${r.month}`).sort(),
        gameIds: allGames.map((g) => g.id).sort(),
      };
    });

    console.log('result:', JSON.stringify(result, null, 2));

    expect(result.summary.monthsImported, 'monthsImported').toBe(2);
    expect(result.summary.added, 'summary.added (2 months × 2 games)').toBe(4);
    expect(result.summary.skipped, 'summary.skipped (cleared first)').toBe(0);
    expect(result.summary.archives.length, 'summary.archives length').toBe(2);

    // Newest-first: 03 comes before 02.
    expect(result.summary.archives[0], 'first archive is newest').toBe(
      'https://api.chess.com/pub/player/auto-import-tester/games/2025/03',
    );
    expect(result.summary.archives[1], 'second archive is feb').toBe(
      'https://api.chess.com/pub/player/auto-import-tester/games/2025/02',
    );

    // We did NOT import January.
    expect(
      result.recordYears.includes('2025-1'),
      'January 2025 not touched (was sliced off)',
    ).toBe(false);

    expect(result.gamesInDb, 'games landed in IndexedDB').toBe(4);
    expect(result.recordCount, 'one record per archive').toBe(2);
    expect(result.progressEvents.length, 'two progress events').toBe(2);

    // Cumulative counters should accumulate across archives.
    expect(result.progressEvents[0].added, 'progress[0].added (after first)').toBe(2);
    expect(result.progressEvents[1].added, 'progress[1].added (after second)').toBe(4);
    expect(result.progressEvents[1].done, 'progress[1].done').toBe(2);
    expect(result.progressEvents[1].total, 'progress[1].total').toBe(2);

    // Idempotent re-run: do it again, expect 0 added / 4 skipped.
    const second = await page.evaluate(async () => {
      const { importLastNMonths } = await import('/src/features/import/auto.ts');
      return await importLastNMonths('auto-import-tester', 2);
    });
    console.log('second run:', second);
    expect(second.added, 'second-run added (all dupes)').toBe(0);
    expect(second.skipped, 'second-run skipped').toBe(4);
  },
});
