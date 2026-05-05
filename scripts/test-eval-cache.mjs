// Test the persistent FEN→eval cache + book-skip fast path.
//
// Strategy:
//   1) Load the dev server and clear any pre-existing evalCache rows.
//   2) Analyze a small synthetic game once at depth 8. Record wall time
//      and Stockfish miss count.
//   3) Re-analyze the same game. Wall time should drop substantially
//      and the cache hit count should equal the number of unique FENs
//      we enqueued (i.e. zero misses on the second run).
//   4) Analyze a *different* game whose opening overlaps the first
//      (1.e4 e5). Verify cache hits cover the shared prefix.
//
// Also exercises the book-skip path: fully-in-book moves at the start
// of each game should not show up as engine misses on the FIRST run
// either, because they never call cachedAnalyze for that FEN.
//
// Run with the dev server up:
//   URL=http://localhost:5173/ node scripts/test-eval-cache.mjs

import { chromium } from 'playwright';

const URL = process.env.URL || 'http://localhost:5173/';

// Game 1: short Italian-flavored game. Opening prefix is in book.
const PGN_A = `[Event "Test A"]
[Site "?"]
[Date "2024.01.01"]
[Round "?"]
[White "me"]
[Black "opp"]
[Result "1-0"]
[TimeControl "600"]
[ECO "C50"]
[Opening "Italian Game"]

1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. d3 Nf6 5. O-O O-O 6. Nc3 d6 7. h3 h6 8. a3 a6 1-0
`;

// Game 2: shares 1.e4 e5 prefix with game A; otherwise different.
const PGN_B = `[Event "Test B"]
[Site "?"]
[Date "2024.01.02"]
[Round "?"]
[White "me"]
[Black "opp"]
[Result "0-1"]
[TimeControl "600"]
[ECO "C40"]
[Opening "King's Knight Opening"]

1. e4 e5 2. Nf3 d6 3. Bc4 Nf6 4. d3 Be7 5. O-O O-O 0-1
`;

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext();
const page = await ctx.newPage();

const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

console.log(`-> Loading ${URL}`);
await page.goto(URL, { waitUntil: 'networkidle' });

const result = await page.evaluate(
  async ({ pgnA, pgnB }) => {
    const out = { steps: [] };
    const log = (s) => out.steps.push(s);
    try {
      const { db } = await import('/src/db/schema.ts');
      const { analyzeGamePgn } = await import('/src/engine/analyzer.ts');
      const { cacheStats } = await import('/src/engine/cache.ts');

      // Clean slate for the cache so timings are reproducible.
      await db.evalCache.clear();
      cacheStats.reset();
      log(`cleared evalCache, stats reset`);

      const time = async (label, fn) => {
        const t0 = performance.now();
        const r = await fn();
        const dt = performance.now() - t0;
        log(`${label}: ${dt.toFixed(0)}ms`);
        return { r, dt };
      };

      cacheStats.reset();
      const first = await time('analyze A (cold)', () =>
        analyzeGamePgn('cache-test-a', pgnA, 8, undefined, undefined, {
          hasOpening: true,
          timeControl: '600',
        }),
      );
      const coldStats = { ...cacheStats };
      log(`cold A stats: ${JSON.stringify(coldStats)}`);

      cacheStats.reset();
      const second = await time('analyze A (warm)', () =>
        analyzeGamePgn('cache-test-a', pgnA, 8, undefined, undefined, {
          hasOpening: true,
          timeControl: '600',
        }),
      );
      const warmStats = { ...cacheStats };
      log(`warm A stats: ${JSON.stringify(warmStats)}`);

      cacheStats.reset();
      const overlap = await time('analyze B (overlapping prefix)', () =>
        analyzeGamePgn('cache-test-b', pgnB, 8, undefined, undefined, {
          hasOpening: true,
          timeControl: '600',
        }),
      );
      const overlapStats = { ...cacheStats };
      log(`overlap B stats: ${JSON.stringify(overlapStats)}`);

      // Sanity: warm run hit ratio should be 100%.
      const warmHitRatio =
        warmStats.hits / Math.max(1, warmStats.hits + warmStats.misses);

      // Sanity: cold A had >0 book skips since the opening is in book.
      const bookSkippedA = coldStats.bookSkips > 0;

      // Sanity: cold A wrote rows to evalCache.
      const evalCacheRowCount = await db.evalCache.count();

      return {
        ok: true,
        coldMs: first.dt,
        warmMs: second.dt,
        overlapMs: overlap.dt,
        coldStats,
        warmStats,
        overlapStats,
        warmHitRatio,
        bookSkippedA,
        evalCacheRowCount,
        movesA: first.r.moves.length,
        movesB: overlap.r.moves.length,
        bookMovesA: first.r.moves.filter((m) => m.classification === 'book')
          .length,
        bookMovesB: overlap.r.moves.filter((m) => m.classification === 'book')
          .length,
        steps: out.steps,
      };
    } catch (e) {
      return {
        ok: false,
        error: e?.message || String(e),
        stack: e?.stack,
        steps: out.steps,
      };
    }
  },
  { pgnA: PGN_A, pgnB: PGN_B },
);

console.log('\n=== Result ===');
console.log(JSON.stringify(result, null, 2));

console.log('\n=== Console (last 40) ===');
for (const l of logs.slice(-40)) console.log(l);

await browser.close();

if (!result?.ok) {
  process.exit(1);
}

// Assertions.
let failed = false;
const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  failed = true;
};

if (result.warmHitRatio < 0.99) {
  fail(`warm-run hit ratio ${result.warmHitRatio.toFixed(2)} < 0.99`);
}
if (result.warmStats.misses !== 0) {
  fail(`warm-run had ${result.warmStats.misses} engine misses (expected 0)`);
}
if (result.warmMs >= result.coldMs) {
  fail(
    `warm run (${result.warmMs.toFixed(0)}ms) was not faster than cold (${result.coldMs.toFixed(0)}ms)`,
  );
}
if (!result.bookSkippedA) {
  fail(`expected at least one book-skip on cold run of game A`);
}
if (result.bookMovesA === 0) {
  fail(`game A had no moves classified as "book"`);
}
// Game B's overlap with game A is *all in book* in our test PGNs (both
// stay in book through 1.e4 e5), so the shared prefix hits the book-skip
// path rather than the cache. We assert the book-skip path fired
// instead.
if (result.overlapStats.bookSkips === 0) {
  fail(`overlapping game B had 0 book skips — expected ≥ shared book prefix`);
}
if (result.evalCacheRowCount === 0) {
  fail(`evalCache table is empty after analysis — writes failed`);
}

if (failed) {
  process.exit(1);
}
console.log(
  `\nPASS: cold=${result.coldMs.toFixed(0)}ms warm=${result.warmMs.toFixed(0)}ms ` +
    `(speedup ${(result.coldMs / Math.max(1, result.warmMs)).toFixed(1)}x), ` +
    `warm hits=${result.warmStats.hits}/0 misses, ` +
    `book skips on cold=${result.coldStats.bookSkips}, ` +
    `overlap B hits=${result.overlapStats.hits}/${result.overlapStats.misses}`,
);
process.exit(0);
