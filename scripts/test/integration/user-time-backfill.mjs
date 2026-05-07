// Verify the user-time-stats backfill (`backfillUserTimeStats`):
//   1. Empty DB → backfill does NOT stamp the version (so a later
//      import isn't silently skipped forever).
//   2. With games staged WITHOUT `userTimeSec`, real backfill populates
//      the cached fields and stamps the version.
//   3. Subsequent boots short-circuit (return 0, no row mutations).
//   4. force=true bypasses the skip.
//   5. Daily games get `userTimeSec === undefined` (excluded), but
//      still get `userPlyCount` populated.
//
// Mirrors `recompute-skip.mjs` exactly because the version-stamp
// pattern is the same and we want the regression guard to be the same
// shape (a future "stamp on empty DB" bug here would silently lock
// dashboards onto stale time stats).

import { runBrowserTest, expect } from '../harness.mjs';

const CLOCKED_PGN = `[Event "Live Chess"]
[Site "Chess.com"]
[White "alice"]
[Black "bob"]
[Result "1-0"]
[TimeControl "600"]

1. e4 {[%clk 0:09:55]} e5 {[%clk 0:09:50]} 2. Nf3 {[%clk 0:09:50]} Nc6 {[%clk 0:09:45]} 3. Bc4 {[%clk 0:09:40]} Bc5 {[%clk 0:09:30]} 1-0
`;

const DAILY_PGN = `[Event "Daily"]
[White "alice"]
[Black "bob"]
[Result "*"]
[TimeControl "1/86400"]

1. e4 e5 2. Nf3 Nc6 *
`;

await runBrowserTest({
  name: 'user-time-backfill',
  async run({ page }) {
    page.on('console', (m) => {
      if (m.text().includes('[queue]')) console.log(m.text());
    });

    // Phase 1: empty DB → no version stamp.
    const phase1 = await page.evaluate(async () => {
      const { db } = await import('/src/db/schema.ts');
      const { backfillUserTimeStats, USER_TIME_BACKFILL_VERSION } = await import(
        '/src/db/queries.ts'
      );
      await db.games.clear();
      await db.analyses.clear();
      await db.settings.delete('main');

      const updated = await backfillUserTimeStats();
      const s = await db.settings.get('main');
      return {
        updated,
        stamped: s?.lastUserTimeBackfillVersion === USER_TIME_BACKFILL_VERSION,
        currentVersion: USER_TIME_BACKFILL_VERSION,
      };
    });
    console.log('Phase 1 (empty DB):', phase1);
    expect(phase1.updated, 'phase 1: nothing to update').toBe(0);
    expect(phase1.stamped, 'phase 1: empty DB must NOT stamp').toBeFalsy();

    // Phase 2: stage a clocked rapid game + a daily game without
    // userTimeSec, run backfill, expect both rows updated and version
    // stamped.
    const phase2 = await page.evaluate(
      async ({ CLOCKED_PGN, DAILY_PGN }) => {
        const { db } = await import('/src/db/schema.ts');
        const { backfillUserTimeStats, USER_TIME_BACKFILL_VERSION } = await import(
          '/src/db/queries.ts'
        );

        await db.games.put({
          id: 'utb-clocked',
          url: 'https://example.com/clocked',
          source: 'chesscom',
          username: 'me',
          userColor: 'white',
          opponent: 'opp',
          result: 'win',
          timeControl: '600',
          timeClass: 'rapid',
          endTime: Date.now(),
          pgn: CLOCKED_PGN,
          importedAt: Date.now(),
          analysisStatus: 'done',
          // Deliberately omit userTimeSec / userPlyCount — that's the
          // pre-backfill state.
        });
        await db.games.put({
          id: 'utb-daily',
          url: 'https://example.com/daily',
          source: 'chesscom',
          username: 'me',
          userColor: 'white',
          opponent: 'opp',
          result: 'draw',
          timeControl: '1/86400',
          timeClass: 'daily',
          endTime: Date.now(),
          pgn: DAILY_PGN,
          importedAt: Date.now(),
          analysisStatus: 'done',
        });

        const updated = await backfillUserTimeStats();
        const s = await db.settings.get('main');
        const clocked = await db.games.get('utb-clocked');
        const daily = await db.games.get('utb-daily');
        return {
          updated,
          stamped: s?.lastUserTimeBackfillVersion === USER_TIME_BACKFILL_VERSION,
          clockedUserTimeSec: clocked?.userTimeSec,
          clockedUserPlyCount: clocked?.userPlyCount,
          dailyUserTimeSec: daily?.userTimeSec,
          dailyUserPlyCount: daily?.userPlyCount,
        };
      },
      { CLOCKED_PGN, DAILY_PGN },
    );
    console.log('Phase 2 (real work):', phase2);
    expect(phase2.updated, 'phase 2: should update both rows').toBe(2);
    expect(phase2.stamped, 'phase 2: should stamp version').toBeTruthy();
    expect(
      phase2.clockedUserTimeSec,
      'phase 2: clocked game gets a positive userTimeSec',
    ).toBeAtLeast(1);
    expect(
      phase2.clockedUserPlyCount,
      'phase 2: clocked game ply count is 6',
    ).toBe(6);
    expect(
      phase2.dailyUserTimeSec,
      'phase 2: daily game userTimeSec is undefined',
    ).toBe(undefined);
    expect(
      phase2.dailyUserPlyCount,
      'phase 2: daily game still gets ply count',
    ).toBe(4);

    // Phase 3: re-run, expect short-circuit + no row mutations.
    const phase3 = await page.evaluate(async () => {
      const { db } = await import('/src/db/schema.ts');
      const { backfillUserTimeStats } = await import('/src/db/queries.ts');
      // Sentinel: mutate the cached value; if skip works it survives.
      await db.games.update('utb-clocked', { userTimeSec: 99999 });
      const updated = await backfillUserTimeStats();
      const g = await db.games.get('utb-clocked');
      return { updated, sentinel: g?.userTimeSec };
    });
    console.log('Phase 3 (skip):', phase3);
    expect(phase3.updated, 'phase 3: skip pass returns 0').toBe(0);
    expect(phase3.sentinel, 'phase 3: sentinel survived skip').toBe(99999);

    // Phase 4: force=true bypasses the skip and overwrites the sentinel.
    const phase4 = await page.evaluate(async () => {
      const { db } = await import('/src/db/schema.ts');
      const { backfillUserTimeStats } = await import('/src/db/queries.ts');
      const updated = await backfillUserTimeStats({ force: true });
      const g = await db.games.get('utb-clocked');
      return { updated, userTimeSec: g?.userTimeSec };
    });
    console.log('Phase 4 (force):', phase4);
    expect(phase4.updated, 'phase 4: force re-runs').toBeAtLeast(1);
    // Sentinel was 99999; the real cached value should be a small
    // positive number (~20 s for the fixture), so a `toBeLessThan(60)`
    // check is the cleanest expression of "sentinel was replaced".
    expect(
      phase4.userTimeSec,
      'phase 4: real cached value is sane (a few seconds, replacing the 99999 sentinel)',
    ).toBeAtLeast(1);
    expect(
      phase4.userTimeSec,
      'phase 4: real cached value is below 60s (replaces the 99999 sentinel)',
    ).toBeLessThan(60);

    console.log(
      'PASS: empty-boot does not stamp; real pass stamps + caches; same-version boot skips; force bypasses',
    );
  },
});
