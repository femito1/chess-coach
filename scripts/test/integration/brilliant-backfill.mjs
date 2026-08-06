import { runBrowserTest, expect, DEFAULT_URL, appendBypass } from '../harness.mjs';

/**
 * `Game.brilliantCount` boot backfill.
 *
 * The Games table badges games where the user played a brilliancy, reading
 * a denormalized count off the game row (the classifications themselves
 * live in the separate `analyses` table, and reading those per render is
 * the cost `listGamesLight` exists to avoid). Games analyzed before the
 * field existed have to be stamped by the boot recompute pass.
 *
 * Three properties, all of which broke a naive implementation:
 *
 *  1. The user's OWN brilliancies count. A brilliancy played by the
 *     opponent must not earn the user a badge — hence the two fixtures
 *     below differ only in `userColor` while sharing an identical move
 *     list.
 *  2. `0` gets written, not left undefined. "Analyzed, none found" has to
 *     be distinguishable from "never counted", or the badge column can't
 *     be trusted.
 *  3. The pass is idempotent. A second run must report zero changes, or
 *     every boot re-writes the whole library and thrashes `useLiveQuery`.
 *
 *  4. It is CHEAP. `backfillBrilliantCounts` reads the classifications
 *     already stored in `analyses` — it must not re-derive them and must
 *     not rewrite the `analyses` table. Shipping this as a
 *     `RECOMPUTE_VERSION` bump instead (2026-08-07) dragged the full
 *     re-classification along and froze the app on reload; the assertion
 *     that `analyses` is untouched is what pins the distinction.
 */
await runBrowserTest({
  name: 'brilliant-backfill',
  async run({ page }) {
    await page.goto(appendBypass(`${DEFAULT_URL}games`), {
      waitUntil: 'networkidle',
    });

    const before = await page.evaluate(async () => {
      const { db, updateSettings } = await import('/src/db/schema.ts');
      await db.games.clear();
      await db.analyses.clear();

      // 8.Bxf7+ in a quiet Italian-ish middlegame: bishop takes a
      // king-defended pawn, so SEE reads it as a real piece sacrifice.
      const SAC_BEFORE =
        'r1bqk2r/1pp2pp1/p1np1n1p/2b1p3/2B1P3/P1PP1N1P/1P3PP1/RNBQK2R w KQkq - 1 8';
      const SAC_AFTER =
        'r1bqk2r/1pp2Bp1/p1np1n1p/2b1p3/4P3/P1PP1N1P/1P3PP1/RNBQK2R b KQkq - 0 8';
      const mk = (ply, cls, sac) =>
        sac
          ? {
              ply,
              san: 'Bxf7+',
              uci: 'c4f7',
              fenBefore: SAC_BEFORE,
              fenAfter: SAC_AFTER,
              bestMoveUci: 'c4f7', // isBest — required for brilliant
              evalCpBefore: 20,
              evalCpAfter: 60,
              winrateBefore: 0.55,
              winrateAfter: 0.62,
              classification: cls,
              depth: 16,
            }
          : {
              ply,
              san: 'e4',
              uci: 'e2e4',
              fenBefore: SAC_BEFORE,
              fenAfter: SAC_AFTER,
              evalCpBefore: 20,
              evalCpAfter: 25,
              winrateBefore: 0.55,
              winrateAfter: 0.55,
              classification: cls,
              depth: 16,
            };

      const game = (id, userColor, result) => ({
        id,
        url: `u/${id}`,
        source: 'chesscom',
        username: 't',
        userColor,
        opponent: 'someone',
        result,
        timeControl: '300',
        timeClass: 'blitz',
        endTime: Date.now(),
        // No eco/opening: `hasOpening` feeds the legacy engine-based book
        // gate (isBest && ply <= 10), which we want out of the way.
        opening: undefined,
        eco: undefined,
        pgn: '1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 1-0',
        importedAt: Date.now(),
        analysisStatus: 'done',
      });

      await db.games.bulkPut([
        game('g1', 'white', 'win'),
        game('g2', 'black', 'loss'),
      ]);

      // Identical move lists. Ply 15 is odd → White played the brilliancy,
      // so g1's user earns it and g2's user must not.
      const moves = [
        mk(13, 'good'),
        mk(14, 'good'),
        mk(15, 'brilliant', true),
        mk(16, 'good'),
      ];
      await db.analyses.bulkPut([
        { gameId: 'g1', depth: 16, analyzedAt: Date.now(), engine: 'sf', moves },
        { gameId: 'g2', depth: 16, analyzedAt: Date.now(), engine: 'sf', moves },
      ]);

      // A real upgrading user: already at the current recompute version
      // (so the expensive pass is skipped), brilliant backfill never run.
      const { RECOMPUTE_VERSION } = await import('/src/db/queries.ts');
      await updateSettings({
        lastRecomputeVersion: RECOMPUTE_VERSION,
        lastBrilliantBackfillVersion: undefined,
      });
      const rows = await db.games.toArray();
      return rows.map((r) => ({ id: r.id, bc: r.brilliantCount ?? null }));
    });

    expect(
      before.every((r) => r.bc === null),
      'fixture starts with no brilliantCount stamped',
    ).toBe(true);

    // The expensive re-classification must NOT be what stamps this.
    const expensive = await page.evaluate(async () => {
      const { recomputeClassificationsAndAccuracies } = await import(
        '/src/db/queries.ts'
      );
      return recomputeClassificationsAndAccuracies();
    });
    expect(
      expensive,
      'full re-classification stays skipped for an up-to-date DB',
    ).toBe(0);

    const after = await page.evaluate(async () => {
      const { backfillBrilliantCounts } = await import('/src/db/queries.ts');
      const { db } = await import('/src/db/schema.ts');
      const before = await db.analyses.toArray();
      const updated = await backfillBrilliantCounts();
      const rows = await db.games.toArray();
      const analysesAfter = await db.analyses.toArray();
      return {
        updated,
        rows: rows.map((r) => ({ id: r.id, bc: r.brilliantCount ?? null })),
        // The cheap pass reads `analyses`; it must never write to it.
        analysesUnchanged:
          JSON.stringify(before) === JSON.stringify(analysesAfter),
      };
    });

    const g1 = after.rows.find((r) => r.id === 'g1');
    const g2 = after.rows.find((r) => r.id === 'g2');
    expect(g1.bc, 'white user is credited for their own brilliancy').toBe(1);
    expect(g2.bc, "black user is NOT credited for white's brilliancy").toBe(0);
    expect(
      after.analysesUnchanged,
      'cheap pass does not rewrite the analyses table',
    ).toBe(true);

    const second = await page.evaluate(async () => {
      const { backfillBrilliantCounts } = await import('/src/db/queries.ts');
      return backfillBrilliantCounts();
    });
    expect(second, 'a second pass changes nothing (idempotent)').toBe(0);
  },
});
