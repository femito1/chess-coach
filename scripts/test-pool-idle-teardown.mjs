// Verify the EnginePool's lazy spin-up + idle teardown:
//   1) A fresh pool starts with size 0 (no workers yet).
//   2) After analyze(), the pool grows up to its capacity on demand.
//   3) terminateIfIdle() releases workers when the pool is idle.
//   4) A subsequent analyze() rehydrates the pool transparently and
//      returns a correct result (proving the freed workers were
//      successfully respawned).
//
// Run: URL=http://localhost:5173/ node scripts/test-pool-idle-teardown.mjs

import { chromium } from 'playwright';

const URL = process.env.URL || 'http://localhost:5173/';

const browser = await chromium.launch({ headless: true });
const page = await (await browser.newContext()).newPage();

page.on('pageerror', (e) => console.error('[pageerror]', e.message));
page.on('console', (m) => {
  if (m.type() === 'error') console.error('[console.error]', m.text());
});

await page.goto(URL, { waitUntil: 'networkidle' });

const result = await page.evaluate(async () => {
  const { EnginePool } = await import('/src/engine/pool.ts');
  const pool = new EnginePool(2);
  const log = [];
  log.push({ step: 'fresh pool', size: pool.size, capacity: pool.capacity, idle: pool.isIdle() });

  // Run a quick analyze so the pool has to spawn at least one worker.
  const startFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  const r1 = await pool.analyze(startFen, 6);
  log.push({
    step: 'after first analyze',
    size: pool.size,
    idle: pool.isIdle(),
    bestMoveUci: r1.bestMoveUci,
  });

  // Tear down idle pool.
  const freed = pool.terminateIfIdle();
  log.push({ step: 'after terminateIfIdle', freed, size: pool.size, idle: pool.isIdle() });

  // Re-run analyze; pool should rehydrate transparently.
  const r2 = await pool.analyze(startFen, 6);
  log.push({
    step: 'after second analyze (post-teardown)',
    size: pool.size,
    bestMoveUci: r2.bestMoveUci,
  });

  // Final teardown via terminate().
  pool.terminate();
  log.push({ step: 'after explicit terminate', size: pool.size, idle: pool.isIdle() });

  return { log };
});

console.log('=== Pool idle teardown log ===');
console.log(JSON.stringify(result.log, null, 2));

let failed = false;
const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  failed = true;
};

const [fresh, afterFirst, afterTeardown, afterSecond, afterTerm] = result.log;

if (fresh.size !== 0) fail(`fresh pool should have size 0, got ${fresh.size}`);
if (fresh.capacity !== 2) fail(`fresh pool capacity should be 2, got ${fresh.capacity}`);
if (!fresh.idle) fail('fresh pool should be idle');

if (afterFirst.size < 1) fail('after first analyze, pool should have spawned at least 1 worker');
if (!afterFirst.bestMoveUci) fail('first analyze did not return a best move');
if (!afterFirst.idle) fail('pool should be idle after analyze resolves');

if (!afterTeardown.freed) fail('terminateIfIdle should have freed workers');
if (afterTeardown.size !== 0) fail(`pool size after teardown should be 0, got ${afterTeardown.size}`);

if (afterSecond.size < 1) fail('pool should have rehydrated on second analyze');
if (!afterSecond.bestMoveUci) fail('second analyze did not return a best move (pool failed to rehydrate)');

if (afterTerm.size !== 0) fail('terminate() did not zero pool size');

await browser.close();

if (failed) process.exit(1);
console.log('PASS: pool starts empty, grows on demand, frees on idle, rehydrates on next analyze');
process.exit(0);
