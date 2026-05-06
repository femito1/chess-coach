// Verify the EnginePool's lazy spin-up + idle teardown:
//   1) A fresh pool starts with size 0 (no workers yet).
//   2) After analyze(), the pool grows up to its capacity on demand.
//   3) terminateIfIdle() releases workers when the pool is idle.
//   4) A subsequent analyze() rehydrates the pool transparently and
//      returns a correct result (proving the freed workers were
//      successfully respawned).

import { runBrowserTest, expect } from '../harness.mjs';

await runBrowserTest({
  name: 'pool-idle-teardown',
  async run({ page }) {
    const result = await page.evaluate(async () => {
      const { EnginePool } = await import('/src/engine/pool.ts');
      const pool = new EnginePool(2);
      const log = [];
      log.push({ step: 'fresh pool', size: pool.size, capacity: pool.capacity, idle: pool.isIdle() });

      const startFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
      const r1 = await pool.analyze(startFen, 6);
      log.push({
        step: 'after first analyze',
        size: pool.size,
        idle: pool.isIdle(),
        bestMoveUci: r1.bestMoveUci,
      });

      const freed = pool.terminateIfIdle();
      log.push({ step: 'after terminateIfIdle', freed, size: pool.size, idle: pool.isIdle() });

      const r2 = await pool.analyze(startFen, 6);
      log.push({
        step: 'after second analyze (post-teardown)',
        size: pool.size,
        bestMoveUci: r2.bestMoveUci,
      });

      pool.terminate();
      log.push({ step: 'after explicit terminate', size: pool.size, idle: pool.isIdle() });

      return { log };
    });

    console.log('=== Pool idle teardown log ===');
    console.log(JSON.stringify(result.log, null, 2));

    const [fresh, afterFirst, afterTeardown, afterSecond, afterTerm] = result.log;

    expect(fresh.size, 'fresh pool size').toBe(0);
    expect(fresh.capacity, 'fresh pool capacity').toBe(2);
    expect(fresh.idle, 'fresh pool idle').toBeTruthy();

    expect(afterFirst.size, 'pool size after first analyze').toBeAtLeast(1);
    expect(afterFirst.bestMoveUci, 'first analyze bestMoveUci').toBeTruthy();
    expect(afterFirst.idle, 'pool idle after analyze resolves').toBeTruthy();

    expect(afterTeardown.freed, 'terminateIfIdle freed workers').toBeTruthy();
    expect(afterTeardown.size, 'pool size after teardown').toBe(0);

    expect(afterSecond.size, 'pool size after rehydrate').toBeAtLeast(1);
    expect(afterSecond.bestMoveUci, 'second analyze bestMoveUci').toBeTruthy();

    expect(afterTerm.size, 'pool size after terminate()').toBe(0);

    console.log('PASS: pool starts empty, grows on demand, frees on idle, rehydrates on next analyze');
  },
});
