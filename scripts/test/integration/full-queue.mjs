// Reproduce the user's reported flow: start the app, import a synthetic
// game, let the queue process it, and verify analysis lands.

import { runBrowserTest, expect, pollUntil } from '../harness.mjs';

await runBrowserTest({
  name: 'full-queue',
  async run({ page, errors }) {
    const inserted = await page.evaluate(async () => {
  const { db } = await import('/src/db/schema.ts');
  const game = {
    id: 'queue-test-001',
    url: 'https://example.com/queue',
    source: 'chesscom',
    username: 'me',
    userColor: 'white',
    opponent: 'opp',
    result: 'win',
    timeControl: '600',
    timeClass: 'rapid',
    endTime: Date.now(),
    opening: "King's Pawn",
    eco: 'C20',
    pgn: '1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7# 1-0',
    importedAt: Date.now(),
    analysisStatus: 'pending',
  };
  await db.games.put(game);
  return true;
});

    console.log('Game inserted:', inserted);

    // Poll the queue until the game is done or 60 s elapse.
    await pollUntil(
      async () => {
        const snap = await page.evaluate(async () => {
          const { db } = await import('/src/db/schema.ts');
          const g = await db.games.get('queue-test-001');
          const a = await db.analyses.get('queue-test-001');
          return {
            status: g?.analysisStatus,
            error: g?.analysisError,
            accuracy: g?.accuracy,
            moves: a?.moves?.length ?? 0,
          };
        });
        return {
          done: snap.status === 'done' || snap.status === 'error',
          value: snap,
          label: JSON.stringify(snap),
        };
      },
      { timeoutMs: 60_000, intervalMs: 500 },
    );

    const final = await page.evaluate(async () => {
      const { db } = await import('/src/db/schema.ts');
      const g = await db.games.get('queue-test-001');
      const a = await db.analyses.get('queue-test-001');
      return {
        game: g
          ? { status: g.analysisStatus, error: g.analysisError, accuracy: g.accuracy }
          : null,
        moveCount: a?.moves?.length ?? 0,
        firstMove: a?.moves?.[0],
      };
    });

    console.log('\n=== Final ===');
    console.log(JSON.stringify(final, null, 2));

    if (errors.length) {
      console.log('\n=== Console errors/warnings ===');
      for (const e of errors) console.log(e);
    }

    expect(final.game?.status, 'final.game.status').toBe('done');
    expect(final.moveCount, 'final.moveCount').toBeGreaterThan(0);
  },
});
