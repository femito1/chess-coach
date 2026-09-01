// Verify the recompute version-skip fast path:
//   1. Empty DB → recompute does NOT stamp the version (so a later
//      import isn't skipped).
//   2. After a real recompute pass, the version IS stamped.
//   3. A subsequent boot with the same version short-circuits and
//      returns 0 (no work) without rewriting the row.
//   4. force=true bypasses the skip.
//   5. A DB stamped with a NEWER version than the code still skips.
//   6. An interrupted pass RESUMES from its cursor instead of restarting.
//
// Regression guard for the "lastRecomputeVersion locks in on empty DB"
// bug we hit while shipping the boot-time skip, and for the reload trap
// behind it: the pass stamps only after walking the whole library, so
// before the cursor existed a reload at minute 25 of a 30-minute pass
// started again at the first game — and a user staring at a frozen-looking
// app reloads, which made the reasonable reaction the thing that
// guaranteed it never finished.

import { runBrowserTest, expect } from '../harness.mjs';

await runBrowserTest({
  name: 'recompute-skip',
  async run({ page }) {
    page.on('console', (m) => {
      if (m.text().includes('[queue]')) console.log(m.text());
    });

    // Phase 1: clear DB, verify empty-boot does not stamp the version.
    const phase1 = await page.evaluate(async () => {
      const { db } = await import('/src/db/schema.ts');
      const { recomputeClassificationsAndAccuracies, RECOMPUTE_VERSION } = await import(
        '/src/db/queries.ts'
      );
      await db.games.clear();
      await db.analyses.clear();
      await db.settings.delete('main');

      const updated = await recomputeClassificationsAndAccuracies();
      const s = await db.settings.get('main');
      return {
        updated,
        stamped: s?.lastRecomputeVersion === RECOMPUTE_VERSION,
        lastVersion: s?.lastRecomputeVersion ?? null,
        currentVersion: RECOMPUTE_VERSION,
      };
    });
    console.log('Phase 1 (empty DB):', phase1);
    expect(phase1.stamped, 'phase 1: empty DB must NOT stamp the version').toBeFalsy();

    // Phase 2: insert a done game with a stale accuracy, run recompute,
    // expect: row updated + version stamped.
    const phase2 = await page.evaluate(async () => {
      const { db } = await import('/src/db/schema.ts');
      const { recomputeClassificationsAndAccuracies, RECOMPUTE_VERSION } = await import(
        '/src/db/queries.ts'
      );

      await db.games.put({
        id: 'rs-001',
        url: 'https://example.com/rs',
        source: 'chesscom',
        username: 'me',
        userColor: 'white',
        opponent: 'opp',
        result: 'loss',
        timeControl: '600',
        timeClass: 'rapid',
        endTime: Date.now(),
        opening: 'Test',
        eco: 'C00',
        pgn: '1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7# 1-0',
        importedAt: Date.now(),
        analysisStatus: 'done',
        accuracy: { white: 95.0, black: 95.0 },
      });
      await db.analyses.put({
        gameId: 'rs-001',
        depth: 16,
        analyzedAt: Date.now(),
        engine: 'stockfish-16',
        moves: [
          { ply: 1, san: 'e4', fenBefore: 'x', fenAfter: 'x', evalCpBefore: 20, evalCpAfter: 20,
            winrateBefore: 0.52, winrateAfter: 0.52, classification: 'best', depth: 16 },
          { ply: 2, san: 'Bluff', fenBefore: 'x', fenAfter: 'x', evalCpBefore: 50, evalCpAfter: -800,
            winrateBefore: 0.70, winrateAfter: 0.05, classification: 'blunder', depth: 16 },
        ],
      });

      const updated = await recomputeClassificationsAndAccuracies();
      const s = await db.settings.get('main');
      const g = await db.games.get('rs-001');
      return {
        updated,
        stamped: s?.lastRecomputeVersion === RECOMPUTE_VERSION,
        accuracy: g?.accuracy,
      };
    });
    console.log('Phase 2 (real work):', phase2);
    expect(phase2.updated, 'phase 2: should update at least one row').toBeAtLeast(1);
    expect(phase2.stamped, 'phase 2: should stamp the version').toBeTruthy();

    // Phase 3: re-run recompute, should short-circuit (returns 0) without
    // touching the row.
    const phase3 = await page.evaluate(async () => {
      const { db } = await import('/src/db/schema.ts');
      const { recomputeClassificationsAndAccuracies } = await import('/src/db/queries.ts');
      // Mutate the row's accuracy to a sentinel; if the skip works the sentinel survives.
      await db.games.update('rs-001', { accuracy: { white: 1.0, black: 1.0 } });
      const updated = await recomputeClassificationsAndAccuracies();
      const g = await db.games.get('rs-001');
      return { updated, accuracy: g?.accuracy };
    });
    console.log('Phase 3 (skip):', phase3);
    expect(phase3.updated, 'phase 3: should be a no-op').toBe(0);
    expect(phase3.accuracy.white, 'phase 3: sentinel survived (white)').toBe(1.0);
    expect(phase3.accuracy.black, 'phase 3: sentinel survived (black)').toBe(1.0);

    // Phase 4: force=true should bypass the skip.
    const phase4 = await page.evaluate(async () => {
      const { recomputeClassificationsAndAccuracies } = await import('/src/db/queries.ts');
      return { updated: await recomputeClassificationsAndAccuracies({ force: true }) };
    });
    console.log('Phase 4 (force):', phase4);
    expect(phase4.updated, 'phase 4: force=true must update').toBeAtLeast(1);

    // Phase 5: a DB stamped with a NEWER version than the code must skip.
    //
    // Regression guard for 2026-08-07: RECOMPUTE_VERSION was bumped 2→3
    // purely to stamp a cheap counting field, which froze the app on
    // reload, and was then reverted to 2. Under the original `===` check
    // every DB that had briefly seen v3 would run the full
    // re-classification one final time — re-freezing precisely the users
    // the rollback was meant to rescue. A newer stamp means the DB has
    // already been through at least as new a rule set, so skip.
    const phase5 = await page.evaluate(async () => {
      const { db } = await import('/src/db/schema.ts');
      const { recomputeClassificationsAndAccuracies, RECOMPUTE_VERSION } =
        await import('/src/db/queries.ts');
      await db.settings.update('main', {
        lastRecomputeVersion: RECOMPUTE_VERSION + 1,
      });
      await db.games.update('rs-001', { accuracy: { white: 2.0, black: 2.0 } });
      const updated = await recomputeClassificationsAndAccuracies();
      const g = await db.games.get('rs-001');
      return { updated, accuracy: g?.accuracy };
    });
    console.log('Phase 5 (rolled-back version):', phase5);
    expect(phase5.updated, 'phase 5: newer stamp must skip the pass').toBe(0);
    expect(
      phase5.accuracy.white,
      'phase 5: sentinel survived (no rewrite)',
    ).toBe(2.0);

    /* ---------------------------------------------------------------- */
    /*  Phase 6: resumption                                             */
    /* ---------------------------------------------------------------- */
    // Seed a spread of games so a cursor can sit in the middle of them, then
    // assert the pass only touches what comes *after* the cursor. Ids are
    // chosen so lexical order is obvious: rs-101 .. rs-106.
    const seedSpread = async () => {
      await page.evaluate(async () => {
        const { db } = await import('/src/db/schema.ts');
        await db.games.clear();
        await db.analyses.clear();
        await db.settings.update('main', {
          lastRecomputeVersion: undefined,
          recomputeCursor: undefined,
          recomputeCursorVersion: undefined,
        });
        for (let i = 1; i <= 6; i++) {
          const id = `rs-10${i}`;
          await db.games.put({
            id,
            url: `https://example.com/${id}`,
            source: 'chesscom',
            username: 'me',
            userColor: 'white',
            opponent: 'opp',
            result: 'loss',
            timeControl: '600',
            timeClass: 'rapid',
            endTime: Date.now(),
            opening: 'Test',
            eco: 'C00',
            pgn: '1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7# 1-0',
            importedAt: Date.now(),
            analysisStatus: 'done',
            // A sentinel the pass is guaranteed to overwrite if it runs.
            accuracy: { white: 3.0, black: 3.0 },
          });
          await db.analyses.put({
            gameId: id,
            depth: 16,
            analyzedAt: Date.now(),
            engine: 'stockfish-16',
            moves: [
              { ply: 1, san: 'e4', fenBefore: 'x', fenAfter: 'x', evalCpBefore: 20,
                evalCpAfter: 20, winrateBefore: 0.52, winrateAfter: 0.52,
                classification: 'best', depth: 16 },
              { ply: 2, san: 'Bluff', fenBefore: 'x', fenAfter: 'x', evalCpBefore: 50,
                evalCpAfter: -800, winrateBefore: 0.7, winrateAfter: 0.05,
                classification: 'blunder', depth: 16 },
            ],
          });
        }
      });
    };

    await seedSpread();
    const phase6 = await page.evaluate(async () => {
      const { db } = await import('/src/db/schema.ts');
      const { recomputeClassificationsAndAccuracies, RECOMPUTE_VERSION } = await import(
        '/src/db/queries.ts'
      );
      // Stand in for a pass that died after finishing rs-103.
      await db.settings.update('main', {
        recomputeCursor: 'rs-103',
        recomputeCursorVersion: RECOMPUTE_VERSION,
      });
      const updated = await recomputeClassificationsAndAccuracies();
      const rows = await db.games.bulkGet(['rs-101', 'rs-103', 'rs-104', 'rs-106']);
      const s = await db.settings.get('main');
      return {
        updated,
        // Sentinel intact => untouched; overwritten => the pass redid it.
        before: rows.slice(0, 2).map((g) => g?.accuracy?.white),
        after: rows.slice(2).map((g) => g?.accuracy?.white),
        cursorCleared: s?.recomputeCursor === undefined,
        stamped: s?.lastRecomputeVersion === RECOMPUTE_VERSION,
      };
    });
    console.log('Phase 6 (resume from cursor):', phase6);
    expect(phase6.updated, 'phase 6: only the three games after the cursor').toBe(3);
    expect(
      phase6.before.every((a) => a === 3.0),
      'phase 6: games at or before the cursor were not redone',
    ).toBeTruthy();
    expect(
      phase6.after.every((a) => a !== 3.0),
      'phase 6: games after the cursor were recomputed',
    ).toBeTruthy();
    expect(phase6.stamped, 'phase 6: completing the run stamps the version').toBeTruthy();
    expect(
      phase6.cursorCleared,
      'phase 6: a completed run clears the cursor, or the next bump resumes wrongly',
    ).toBeTruthy();

    // Phase 7: a cursor left by a DIFFERENT version must be ignored — that
    // prefix was classified under the old rules and has to be redone, which is
    // the entire point of bumping the version.
    await seedSpread();
    const phase7 = await page.evaluate(async () => {
      const { db } = await import('/src/db/schema.ts');
      const { recomputeClassificationsAndAccuracies, RECOMPUTE_VERSION } = await import(
        '/src/db/queries.ts'
      );
      await db.settings.update('main', {
        recomputeCursor: 'rs-105',
        recomputeCursorVersion: RECOMPUTE_VERSION - 1,
      });
      return { updated: await recomputeClassificationsAndAccuracies() };
    });
    console.log('Phase 7 (stale-version cursor ignored):', phase7);
    expect(phase7.updated, 'phase 7: a cursor from another version is ignored').toBe(6);

    // Phase 8: a cursor at or past the last id means the previous run got
    // everything and only the final stamp was lost. Stamp, do nothing else.
    await seedSpread();
    const phase8 = await page.evaluate(async () => {
      const { db } = await import('/src/db/schema.ts');
      const { recomputeClassificationsAndAccuracies, RECOMPUTE_VERSION } = await import(
        '/src/db/queries.ts'
      );
      await db.settings.update('main', {
        recomputeCursor: 'rs-999',
        recomputeCursorVersion: RECOMPUTE_VERSION,
      });
      const updated = await recomputeClassificationsAndAccuracies();
      const s = await db.settings.get('main');
      return { updated, stamped: s?.lastRecomputeVersion === RECOMPUTE_VERSION };
    });
    console.log('Phase 8 (cursor past the end):', phase8);
    expect(phase8.updated, 'phase 8: nothing left to do').toBe(0);
    expect(phase8.stamped, 'phase 8: still stamps, so it never runs again').toBeTruthy();

    console.log('PASS: empty-boot does not stamp; real pass stamps; same-version boot skips; force bypasses; newer stamp skips; interrupted pass resumes');
  },
});
