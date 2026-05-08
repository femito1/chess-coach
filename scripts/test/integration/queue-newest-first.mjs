// Verify that the analysis queue serves pending games newest-first.
//
// Why: when a user imports a fresh batch, the games they care about
// most are the ones they just played. Walking the `endTime` index in
// reverse and short-circuiting on the first pending row means a freshly
// imported month comes off the queue ahead of any older backfill.
//
// We don't run real Stockfish here (we don't need to — `nextPendingGame`
// is the only thing under test). Instead we synthesise four pending
// games with strictly-ordered `endTime` values, then call the function
// and assert it returns the newest. After marking that game `'done'`,
// the next call should return the second-newest, and so on.

import { runBrowserTest, expect, DEFAULT_URL, appendBypass } from '../harness.mjs';

await runBrowserTest({
  name: 'queue-newest-first',
  async run({ page }) {
    await page.goto(appendBypass(DEFAULT_URL), { waitUntil: 'networkidle' });

    const result = await page.evaluate(async () => {
      const { db } = await import('/src/db/schema.ts');
      const { nextPendingGame } = await import('/src/db/queries.ts');

      // Wipe the games table so prior tests can't influence the order.
      await db.games.clear();

      const now = 1_700_000_000_000;
      const HOUR = 3600 * 1000;

      // Ages are spread across days so the test isn't sensitive to
      // sec-vs-ms drift; we use ms here directly.
      /** @type {Array<{id: string, endTime: number, status: string}>} */
      const seed = [
        { id: 'g-old',     endTime: now - 300 * HOUR, status: 'pending' },
        { id: 'g-newest',  endTime: now,              status: 'pending' },
        { id: 'g-middle',  endTime: now - 100 * HOUR, status: 'pending' },
        { id: 'g-second',  endTime: now -   1 * HOUR, status: 'pending' },
        // A non-pending row in the middle of the time range — must be
        // ignored even though its endTime would otherwise win.
        { id: 'g-running', endTime: now - 0.5 * HOUR, status: 'running' },
      ];

      for (const s of seed) {
        await db.games.put({
          id: s.id,
          url: `https://chess.com/${s.id}`,
          source: 'chesscom',
          username: 'newest-first-tester',
          userColor: 'white',
          opponent: 'opp',
          opponentRating: 1500,
          userRating: 1500,
          result: 'win',
          timeControl: '600',
          timeClass: 'rapid',
          endTime: s.endTime,
          opening: 'Italian Game',
          eco: 'C50',
          pgn: '1. e4 e5 *',
          importedAt: now,
          analysisStatus: s.status,
        });
      }

      // Repeatedly pull `nextPendingGame`, mark the result done, and
      // record the order. We expect newest-first.
      const order = [];
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const g = await nextPendingGame();
        if (!g) break;
        order.push(g.id);
        await db.games.update(g.id, { analysisStatus: 'done' });
        if (order.length > 10) break; // safety
      }

      return { order };
    });

    console.log('order:', JSON.stringify(result.order));

    expect(result.order.length, 'pending games drained').toBe(4);
    expect(result.order[0], 'newest first').toBe('g-newest');
    expect(result.order[1], 'second-newest second').toBe('g-second');
    expect(result.order[2], 'middle third').toBe('g-middle');
    expect(result.order[3], 'oldest last').toBe('g-old');
  },
});
