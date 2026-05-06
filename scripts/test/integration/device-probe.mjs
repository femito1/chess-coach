// Verify the device probe (`src/engine/probe.ts`):
//
//   - First call runs Stockfish on the PROBE_FEN, returns a sane
//     msPerGame, persists Settings.deviceAnalysisMsPerGame.
//   - Second call short-circuits to the cached value (no engine work,
//     fromCache: true).
//   - Force re-probe via `{ force: true }` re-runs the engine and
//     overwrites the cache.
//
// We rely on the auth bypass so the page boots into a signed-in state
// without redirecting to /sign-in (otherwise the harness lands on the
// sign-in page where our test shim can't reach Stockfish).

import { runBrowserTest, expect } from '../harness.mjs';

await runBrowserTest({
  name: 'device-probe',
  // The probe needs Stockfish to actually run; networkidle is fine
  // because the worker is created on-demand via page.evaluate, not
  // during the initial navigation.
  async run({ page }) {
    // Reset any pre-existing probe value so the first call we make
    // here is guaranteed to be a cold run. The test must work even
    // when other tests have run before us (manifest order isn't
    // stable across `--only` invocations).
    await page.evaluate(async () => {
      const { db } = await import('/src/db/schema.ts');
      const s = await db.settings.get('main');
      if (s) {
        await db.settings.put({ ...s, deviceAnalysisMsPerGame: undefined });
      }
    });

    // Cold run.
    const cold = await page.evaluate(async () => {
      const { probeDevice } = await import('/src/engine/probe.ts');
      const t0 = performance.now();
      const r = await probeDevice();
      const elapsed = performance.now() - t0;
      return { result: r, elapsed };
    });
    console.log('cold probe:', cold);

    expect(cold.result.fromCache, 'cold probe fromCache').toBe(false);
    expect(
      cold.result.msPerGame,
      'cold msPerGame is in a sane range',
    ).toBeAtLeast(100);
    expect(
      cold.result.msPerGame,
      'cold msPerGame is in a sane range',
    ).toBeAtMost(60_000);

    // Sanity: the cached value should be persisted.
    const persisted = await page.evaluate(async () => {
      const { getSettings } = await import('/src/db/schema.ts');
      return (await getSettings()).deviceAnalysisMsPerGame;
    });
    expect(persisted, 'persisted deviceAnalysisMsPerGame').toBeAtLeast(100);

    // Warm run — must be near-instant and report fromCache.
    const warm = await page.evaluate(async () => {
      const { probeDevice } = await import('/src/engine/probe.ts');
      const t0 = performance.now();
      const r = await probeDevice();
      const elapsed = performance.now() - t0;
      return { result: r, elapsed };
    });
    console.log('warm probe:', warm);

    expect(warm.result.fromCache, 'warm probe fromCache').toBe(true);
    expect(warm.result.msPerGame, 'warm probe msPerGame matches cache').toBe(
      cold.result.msPerGame,
    );
    // "Near-instant" — Dexie roundtrip + a couple of awaits is well
    // under 200ms in our test environment. Anything north of 1s would
    // mean the cache short-circuit isn't actually short-circuiting.
    expect(warm.elapsed, 'warm probe is near-instant').toBeAtMost(500);

    // Forced re-probe — no fromCache, recomputes.
    const forced = await page.evaluate(async () => {
      const { probeDevice } = await import('/src/engine/probe.ts');
      return await probeDevice({ force: true });
    });
    expect(forced.fromCache, 'forced re-probe fromCache').toBe(false);
    expect(forced.msPerGame, 'forced re-probe msPerGame is sane').toBeAtLeast(
      100,
    );
  },
});
