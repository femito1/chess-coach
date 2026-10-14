import { runBrowserTest, expect, DEFAULT_URL, appendBypass } from '../harness.mjs';

/**
 * `Game.accuracy` boot backfill — how a recalibrated accuracy model reaches
 * games analysed under the old one.
 *
 * Accuracy is cached on the game row (the dashboard and Games table read it
 * without loading move lists), so a new `CURRENT_ACCURACY_MODEL` changes
 * nothing on screen until something re-derives it. `backfillAccuracies` does,
 * gated by `ACCURACY_BACKFILL_VERSION`. Properties pinned:
 *
 *  1. A stale cached accuracy is replaced by `computeAccuracy` of the stored
 *     moves — the exact value the queue would write today.
 *  2. A row already holding the current value is not written (counted as 0
 *     updated), so a re-stamped DB doesn't rewrite the whole library.
 *  3. It is CHEAP, like `backfillBrilliantCounts`: the expensive
 *     re-classification stays skipped, and `analyses` is never written.
 *  4. It is idempotent: a second run reports zero changes.
 *
 * Run: node scripts/run-tests.mjs --only=accuracy-backfill
 */
await runBrowserTest({
  name: 'accuracy-backfill',
  async run({ page }) {
    await page.goto(appendBypass(`${DEFAULT_URL}games`), { waitUntil: 'networkidle' });

    const seeded = await page.evaluate(async () => {
      const { db, updateSettings } = await import('/src/db/schema.ts');
      const { computeAccuracy } = await import('/src/engine/analyzer.ts');
      const q = await import('/src/db/queries.ts');
      await db.games.clear();
      await db.analyses.clear();

      const mv = (ply, winrateBefore, winrateAfter, classification) => ({
        ply,
        san: 'e4',
        uci: 'e2e4',
        fenBefore: '8/8/8/8/8/8/8/8 w - - 0 1',
        fenAfter: '8/8/8/8/8/8/8/8 b - - 0 1',
        evalCpBefore: 0,
        evalCpAfter: 0,
        winrateBefore,
        winrateAfter,
        classification,
        depth: 18,
      });
      // A book ply, a clean move, a mistake and a blunder per side — enough
      // that the old and new models give clearly different numbers.
      const moves = [
        mv(1, 0.5, 0.5, 'book'),
        mv(2, 0.5, 0.5, 'book'),
        mv(3, 0.55, 0.55, 'best'),
        mv(4, 0.5, 0.42, 'mistake'),
        mv(5, 0.6, 0.35, 'blunder'),
        mv(6, 0.65, 0.65, 'best'),
      ];
      const current = computeAccuracy(moves);
      const game = (id, accuracy) => ({
        id,
        url: `u/${id}`,
        source: 'chesscom',
        username: 't',
        userColor: 'white',
        opponent: 'someone',
        result: 'win',
        timeControl: '600',
        timeClass: 'rapid',
        endTime: Date.now(),
        pgn: '1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5',
        importedAt: Date.now(),
        analysisStatus: 'done',
        accuracy,
      });
      await db.games.bulkPut([
        game('stale', { white: 12.3, black: 45.6 }),
        game('fresh', current),
      ]);
      const analysis = (gameId) => ({
        gameId,
        depth: 18,
        analyzedAt: Date.now(),
        engine: 'stockfish-16-nnue',
        recomputeVersion: q.RECOMPUTE_VERSION,
        moves,
      });
      await db.analyses.bulkPut([analysis('stale'), analysis('fresh')]);

      // An upgrading user: everything else current, accuracy backfill not run.
      await updateSettings({
        lastRecomputeVersion: q.RECOMPUTE_VERSION,
        lastAccuracyBackfillVersion: undefined,
      });
      return { current };
    });

    const expensive = await page.evaluate(async () => {
      const q = await import('/src/db/queries.ts');
      return q.recomputeClassificationsAndAccuracies();
    });
    expect(expensive, 'full re-classification stays skipped for an up-to-date DB').toBe(0);

    const after = await page.evaluate(async () => {
      const { db } = await import('/src/db/schema.ts');
      const q = await import('/src/db/queries.ts');
      const analysesBefore = JSON.stringify(await db.analyses.toArray());
      const updated = await q.backfillAccuracies();
      return {
        updated,
        stale: (await db.games.get('stale')).accuracy,
        fresh: (await db.games.get('fresh')).accuracy,
        analysesUnchanged: analysesBefore === JSON.stringify(await db.analyses.toArray()),
        stamped: (await (await import('/src/db/schema.ts')).getSettings())
          .lastAccuracyBackfillVersion,
        version: q.ACCURACY_BACKFILL_VERSION,
      };
    });
    console.log('accuracy-backfill:', JSON.stringify({ seeded, after }));

    expect(JSON.stringify(after.stale), 'stale accuracy re-derived with the current model').toBe(
      JSON.stringify(seeded.current),
    );
    expect(JSON.stringify(after.fresh), 'an up-to-date row keeps its value').toBe(
      JSON.stringify(seeded.current),
    );
    expect(after.updated, 'only the stale row was written').toBe(1);
    expect(after.analysesUnchanged, 'the cheap pass never writes analyses').toBe(true);
    expect(after.stamped, 'the pass stamps its version').toBe(after.version);

    const second = await page.evaluate(async () => {
      const q = await import('/src/db/queries.ts');
      return q.backfillAccuracies({ force: true });
    });
    expect(second, 'a second pass changes nothing (idempotent)').toBe(0);
  },
});
