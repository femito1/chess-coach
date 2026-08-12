import { runBrowserTest, expect } from '../harness.mjs';

// Prove the index desync in EnginePool.
//
// `pump()` captures a worker *index* and clears `busy[idx]` when the task
// settles. `setMaxWorkers()` SPLICES the workers/busy arrays, which shifts
// the index of every worker above a removed slot. So if an idle worker
// sits below a busy one when the pool shrinks (tab goes hidden mid-
// analysis), the in-flight task's captured index no longer points at its
// own worker.
await runBrowserTest({
  name: 'pool-index-desync',
  async run({ page }) {
    const out = await page.evaluate(async () => {
      const { EnginePool } = await import('/src/engine/pool.ts');
      const pool = new EnginePool(4);
      const raw = () => ({
        workers: pool.workers.length,
        busy: pool.busy.slice(),
      });

      const FEN = 'r1bq1rk1/pp2ppbp/2np1np1/2p5/2P1P3/2N2N2/PP1BBPPP/R2Q1RK1 w - - 0 9';

      // Two shallow tasks (finish fast) + one deep task (stays running).
      // pump assigns lowest index first: w0, w1 shallow; w2 deep.
      const fast1 = pool.analyze(FEN, 4);
      const fast2 = pool.analyze(FEN, 4);
      const slow = pool.analyze(FEN, 24);

      await new Promise((r) => setTimeout(r, 300));
      const afterDispatch = raw();

      // Wait for the two shallow ones so w0/w1 go idle, w2 still busy.
      await Promise.all([fast1, fast2]);
      await new Promise((r) => setTimeout(r, 150));
      const beforeShrink = raw();

      // Tab goes hidden mid-analysis.
      pool.setMaxWorkers(1);
      const afterShrink = raw();

      // Let the deep task land; its callback clears the STALE index.
      await slow.catch(() => {});
      await new Promise((r) => setTimeout(r, 300));
      const afterSettle = raw();

      return {
        afterDispatch,
        beforeShrink,
        afterShrink,
        afterSettle,
        isIdle: pool.isIdle(),
        // The tell: busy longer than workers, or a stuck `true`.
        desynced:
          pool.busy.length !== pool.workers.length ||
          pool.busy.some((b) => b === true),
      };
    });
    console.log('pool state:', JSON.stringify(out));

    // The shrink itself must drop the idle worker and keep the busy one.
    expect(out.beforeShrink.workers, 'three workers before shrink').toBe(3);
    expect(out.afterShrink.workers, 'shrink removed the idle worker').toBe(2);

    // The regression: busy must stay the same length as workers, and the
    // in-flight task must free its OWN slot when it lands.
    expect(
      out.afterSettle.busy.length,
      'busy array stays in sync with workers (no stale-index write)',
    ).toBe(out.afterSettle.workers);
    expect(out.desynced, 'no leaked busy slot').toBe(false);
    expect(out.isIdle, 'pool can go idle again so teardown can free workers').toBe(true);
  },
});
