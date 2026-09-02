import { runBrowserTest, expect, DEFAULT_URL, appendBypass } from '../harness.mjs';

/**
 * The light projections' read contracts — `listGamesLight`,
 * `listAllGamesLight`, `listAnalysesLight`, `bulkGetAnalysisLight` and
 * `listTimeClasses`.
 *
 * These exist to keep whole tables out of JS heap (ARCHITECTURE.md § Memory on
 * mobile), and they were rewritten from `toArray().map(strip)` to a cursor for
 * exactly that reason. The rewrite is only worth anything if the *output* is
 * unchanged, and the two ways it could quietly stop being unchanged are both
 * invisible to a type checker:
 *
 *  1. **Dropped rows.** A cursor that ends early returns a short list, and
 *     every caller — the dashboard, the games list, cloud sync's diff — would
 *     read that as "the library is smaller than it is". Cloud sync would then
 *     push or pull based on it. So every projection is asserted against the
 *     row count and id set it is projecting from, not just spot-checked.
 *
 *  2. **Reordered rows.** `bulkGetAnalysisLight` no longer uses `bulkGet`; it
 *     walks `anyOf`, which visits the primary-key index in KEY order regardless
 *     of the order the ids were asked for, and re-emits from a map. The ids
 *     below are therefore requested in descending order — the one order a
 *     forgotten re-emit step would silently "fix" into ascending.
 *
 * Also pins what the projections must NOT carry: no `pgn` on a light game, no
 * `moves` on a light analysis. That half is checked at compile time too, but
 * only for code that reads the field — a row that still *carries* it costs the
 * memory whether or not anyone reads it, and only a runtime key check sees that.
 */
await runBrowserTest({
  name: 'light-projections',
  async run({ page }) {
    await page.goto(appendBypass(`${DEFAULT_URL}games`), {
      waitUntil: 'networkidle',
    });

    const seeded = await page.evaluate(async () => {
      const { db, updateSettings } = await import('/src/db/schema.ts');
      const {
        RECOMPUTE_VERSION,
        OPENING_REFRESH_VERSION,
        USER_TIME_BACKFILL_VERSION,
        BRILLIANT_BACKFILL_VERSION,
      } = await import('/src/db/queries.ts');

      // Insulate from the live app (TESTING.md § Tests race the live app):
      // stamp every boot-pass gate and seed rows already at the current
      // recompute vintage, so no pass has anything to write to the tables this
      // test is about to count. Nothing is left `pending`, so the analyzer has
      // nothing to claim either.
      await db.games.clear();
      await db.analyses.clear();

      const game = (id, endTime, timeClass) => ({
        id,
        url: `u/${id}`,
        source: 'chesscom',
        username: 't',
        userColor: 'white',
        opponent: 'someone',
        result: 'win',
        timeControl: '300',
        timeClass,
        endTime,
        pgn: `1. e4 e5 2. Nf3 Nc6 ${'{[%clk 0:04:59]} '.repeat(40)}1-0`,
        importedAt: Date.now(),
        analysisStatus: 'done',
      });

      // Ascending endTime, so "newest first" is the reverse of the id order and
      // a projection that forgot to reverse is visible. `g4` carries no
      // `timeClass` at all: IndexedDB does not index undefined, so it must be
      // absent from `listTimeClasses` while still being present in every
      // row-returning projection.
      await db.games.bulkPut([
        game('g1', 1_000, 'blitz'),
        game('g2', 2_000, 'rapid'),
        game('g3', 3_000, 'blitz'),
        game('g4', 4_000, undefined),
      ]);

      const mv = (ply) => ({
        ply,
        san: 'e4',
        uci: 'e2e4',
        fenBefore: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
        fenAfter: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
        evalCpBefore: 20,
        evalCpAfter: 25,
        winrateBefore: 0.55,
        winrateAfter: 0.55,
        classification: 'good',
        depth: 16,
      });
      const analysis = (gameId, n) => ({
        gameId,
        depth: 16,
        analyzedAt: Date.now(),
        engine: 'sf',
        moves: Array.from({ length: n }, (_, i) => mv(i + 1)),
        recomputeVersion: RECOMPUTE_VERSION,
      });

      // g4 deliberately has NO analysis row, so the "missing ids are dropped"
      // arm of `bulkGetAnalysisLight` has something real to drop.
      await db.analyses.bulkPut([
        analysis('g1', 3),
        analysis('g2', 5),
        analysis('g3', 7),
      ]);

      await updateSettings({
        lastRecomputeVersion: RECOMPUTE_VERSION,
        lastOpeningRefreshVersion: OPENING_REFRESH_VERSION,
        lastUserTimeBackfillVersion: USER_TIME_BACKFILL_VERSION,
        lastBrilliantBackfillVersion: BRILLIANT_BACKFILL_VERSION,
      });

      return {
        games: await db.games.count(),
        analyses: await db.analyses.count(),
      };
    });

    expect(seeded.games, 'fixture seeded 4 games').toBe(4);
    expect(seeded.analyses, 'fixture seeded 3 analyses').toBe(3);

    const out = await page.evaluate(async () => {
      const {
        listGames,
        listGamesLight,
        listAllGamesLight,
        listAnalysesLight,
        bulkGetAnalysisLight,
        listTimeClasses,
      } = await import('/src/db/queries.ts');
      const { db } = await import('/src/db/schema.ts');

      const ordered = await listGamesLight();
      const all = await listAllGamesLight();
      const analyses = await listAnalysesLight();

      // Descending — the order `anyOf`'s key walk does not produce — plus a
      // repeated id and one that has no analysis row.
      const asked = ['g3', 'g1', 'gZZ', 'g1'];
      const bulk = await bulkGetAnalysisLight(asked);

      return {
        // Reference orders read the un-projected way, so the assertions
        // compare the cursor against the table rather than against a
        // hard-coded list that could drift with the fixture.
        referenceOrdered: (await listGames()).map((g) => g.id),
        referenceAll: (await db.games.toArray()).map((g) => g.id),
        orderedIds: ordered.map((g) => g.id),
        allIds: all.map((g) => g.id),
        lightGameKeysHavePgn: ordered.some((g) =>
          Object.prototype.hasOwnProperty.call(g, 'pgn'),
        ),
        // A field other than the stripped one, to prove the projection drops
        // exactly one field rather than narrowing the row generally.
        keepsEndTime: ordered.every((g) => typeof g.endTime === 'number'),

        analysisIds: analyses.map((a) => a.gameId).sort(),
        analysisCounts: Object.fromEntries(
          analyses.map((a) => [a.gameId, a.moveCount]),
        ),
        lightAnalysisKeysHaveMoves: analyses.some((a) =>
          Object.prototype.hasOwnProperty.call(a, 'moves'),
        ),
        keepsVintage: analyses.every((a) => typeof a.recomputeVersion === 'number'),

        bulkIds: bulk.map((a) => a.gameId),
        bulkCounts: bulk.map((a) => a.moveCount),
        bulkEmpty: (await bulkGetAnalysisLight([])).length,

        timeClasses: (await listTimeClasses()).sort(),
      };
    });

    // --- no rows dropped, order preserved --------------------------------
    expect(
      out.orderedIds.join(','),
      'listGamesLight matches listGames row-for-row, newest first',
    ).toBe(out.referenceOrdered.join(','));
    expect(out.orderedIds.join(','), 'newest-first is g4,g3,g2,g1').toBe(
      'g4,g3,g2,g1',
    );
    expect(
      out.allIds.join(','),
      'listAllGamesLight matches db.games.toArray() row-for-row',
    ).toBe(out.referenceAll.join(','));

    expect(out.analysisIds.join(','), 'listAnalysesLight returns every analysis').toBe(
      'g1,g2,g3',
    );
    expect(
      JSON.stringify(out.analysisCounts),
      'moveCount is the real move-list length per row',
    ).toBe(JSON.stringify({ g1: 3, g2: 5, g3: 7 }));

    // --- the heavy fields are actually gone ------------------------------
    expect(out.lightGameKeysHavePgn, 'no light game row carries pgn').toBe(false);
    expect(
      out.lightAnalysisKeysHaveMoves,
      'no light analysis row carries moves',
    ).toBe(false);
    expect(out.keepsEndTime, 'light game keeps its non-stripped fields').toBe(true);
    expect(
      out.keepsVintage,
      'light analysis keeps recomputeVersion — the recompute gate reads it',
    ).toBe(true);

    // --- bulkGetAnalysisLight's argument-order contract ------------------
    expect(
      out.bulkIds.join(','),
      'bulkGetAnalysisLight answers in ASKED order, drops unknown ids, repeats a repeat',
    ).toBe('g3,g1,g1');
    expect(
      out.bulkCounts.join(','),
      'each answered row carries its own moveCount',
    ).toBe('7,3,3');
    expect(out.bulkEmpty, 'no ids asked, no rows read').toBe(0);

    // --- listTimeClasses reads the index, not the rows -------------------
    expect(
      out.timeClasses.join(','),
      'distinct classes present, one entry each',
    ).toBe('blitz,rapid');
  },
});
