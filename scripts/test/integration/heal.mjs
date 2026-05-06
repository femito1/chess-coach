// Insert a row simulating the user's stuck "worker error" state, reload the
// page, and verify the queue auto-heals it and analysis eventually completes.

import { runBrowserTest, expect, pollUntil } from '../harness.mjs';

await runBrowserTest({
  name: 'heal',
  async run({ page }) {
    // Surface queue logs from the page so a hang is debuggable.
    page.on('console', (m) => {
      if (m.text().includes('[queue]')) console.log(`[${m.type()}]`, m.text());
    });

    // Simulate a pre-existing stuck-error game as the user sees.
    await page.evaluate(async () => {
      const { db } = await import('/src/db/schema.ts');
      await db.games.put({
        id: 'stale-heal-001',
        url: 'https://example.com/stale',
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
        pgn: '1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. O-O Nf6 5. d3 d6 1-0',
        importedAt: Date.now(),
        analysisStatus: 'error',
        analysisError: 'worker error',
      });
    });
    console.log('Stuck error row inserted.');

    // Reload so startAnalysisQueue runs fresh against the seeded row.
    await page.reload({ waitUntil: 'networkidle' });
    console.log('Page reloaded.');

    await pollUntil(
      async () => {
        const snap = await page.evaluate(async () => {
          const { db } = await import('/src/db/schema.ts');
          const g = await db.games.get('stale-heal-001');
          const a = await db.analyses.get('stale-heal-001');
          return {
            status: g?.analysisStatus,
            error: g?.analysisError,
            moves: a?.moves?.length ?? 0,
          };
        });
        const settled =
          snap.status === 'done' ||
          (snap.status === 'error' && snap.error !== 'worker error');
        return { done: settled, value: snap, label: JSON.stringify(snap) };
      },
      { timeoutMs: 60_000, intervalMs: 500 },
    );

    const final = await page.evaluate(async () => {
      const { db } = await import('/src/db/schema.ts');
      const g = await db.games.get('stale-heal-001');
      const a = await db.analyses.get('stale-heal-001');
      return {
        status: g?.analysisStatus,
        error: g?.analysisError,
        accuracy: g?.accuracy,
        moves: a?.moves?.length ?? 0,
      };
    });
    console.log('\n=== Final ===');
    console.log(JSON.stringify(final, null, 2));

    expect(final.status, 'final.status').toBe('done');
    expect(final.moves, 'final.moves').toBeGreaterThan(0);
  },
});
