// Does a sync request ever get silently dropped?
//
// `startSync` coalesces concurrent triggers onto one pass, which is right — the
// hook fires on sign-in and again whenever the analysis queue goes idle, and those
// land together. But coalescing onto a pass that is ALREADY ABORTED drops the
// request entirely, and does it invisibly: the aborted pass resolves, `isAbort`
// maps it to `phase: 'ready'` — indistinguishable from a clean no-op sync — and
// nothing was transferred.
//
// That is not hypothetical. Clerk resolves `isLoaded` / `userId` in stages, so the
// first effect run starts a sync and the second aborts it and retries; the retry
// used to receive the dying promise instead of starting its own pass. And a "Sync
// now" click landing in that window was swallowed too — at exactly the moment a
// user reaches for the button, because something looks wrong. The failure depends
// on network timing, which makes it read as random flakiness.
//
// Pinned here rather than as a unit test because it is about the real module's
// singleton state machine, which resets per page load in the browser tier.
//
// Run: node scripts/run-tests.mjs --only=sync-coalescing

import { runBrowserTest, expect, appendBypass } from '../harness.mjs';

await runBrowserTest({
  name: 'sync-coalescing',
  waitUntil: 'domcontentloaded',
  skipInitialGoto: true,
  async run({ page }) {
    await page.goto(appendBypass('http://localhost:5173/dashboard'), {
      waitUntil: 'domcontentloaded',
    });
    await page.waitForSelector('a[href="/puzzles"]', { timeout: 15_000 });

    const out = await page.evaluate(async () => {
      const { startSync } = await import('/src/features/sync/useCloudSync.ts');

      // Counting PASSES, not promise identity: `startSync` is `async`, so it always
      // hands back a fresh wrapper even when it coalesces. How many passes actually
      // begin is the behaviour that matters.
      //
      // `cloud_puzzle_attempts` is the counter because `runCloudSync` fetches it
      // exactly once per pass (in the manifest `Promise.all`) and, with no data,
      // never touches it again. Holding its `range()` parks the pass at the manifest
      // stage, so overlapping triggers can be arranged deterministically instead of
      // raced.
      let passes = 0;
      let waiting = [];
      const hold = () => new Promise((r) => waiting.push(r));
      const releaseAll = async () => {
        const w = waiting;
        waiting = [];
        for (const r of w) r();
        // Let the released passes run to completion before inspecting counters.
        await new Promise((r) => setTimeout(r, 60));
      };

      const supabase = {
        from(table) {
          const api = {
            select: () => api,
            eq: () => api,
            in: () => api,
            upsert: async () => ({ error: null }),
            range: async () => {
              if (table === 'cloud_puzzle_attempts') {
                passes++;
                await hold();
              }
              return { data: [], error: null };
            },
          };
          return api;
        },
      };

      const settle = () => new Promise((r) => setTimeout(r, 30));
      const results = {};

      /* --- 1. two concurrent triggers coalesce onto ONE pass --------------- */
      passes = 0;
      const a = startSync({ supabase, userId: 'u1' });
      const b = startSync({ supabase, userId: 'u1' });
      await settle();
      results.passesWhileBothPending = passes;
      await releaseAll();
      await Promise.all([a, b]);
      results.passesForTwoTriggers = passes;

      /* --- 2. a request arriving on an ABORTED pass must NOT be dropped ---- */
      passes = 0;
      const signal = { aborted: false };
      const aborted = startSync({ supabase, userId: 'u1', signal });
      await settle();
      signal.aborted = true; // exactly what the hook's effect cleanup does
      const retry = startSync({ supabase, userId: 'u1' });
      await releaseAll(); // lets the aborted pass reach checkAbort and throw
      await aborted;
      await releaseAll(); // lets the chained retry through its own manifest
      await retry;
      results.passesAfterAbortedRetry = passes;

      /* --- 3. a forced (manual) click always runs -------------------------- */
      passes = 0;
      const running = startSync({ supabase, userId: 'u1' });
      await settle();
      const forced = startSync({ supabase, userId: 'u1', force: true });
      await releaseAll();
      await running;
      await releaseAll();
      await forced;
      results.passesWithForce = passes;

      return results;
    });

    console.log('coalescing:', JSON.stringify(out));

    // 1. Coalescing still works — the behaviour worth keeping.
    expect(
      out.passesWhileBothPending,
      'two concurrent triggers start only one pass',
    ).toBe(1);
    expect(out.passesForTwoTriggers, 'and no extra pass afterwards').toBe(1);

    // 2. THE bug. Before the fix this was 1: the retry adopted the dying promise,
    //    no second pass ever ran, and the phase still went to `ready` — a sync
    //    that reported success while transferring nothing.
    expect(
      out.passesAfterAbortedRetry,
      'a retry after an abort runs its own pass (1 means it was swallowed)',
    ).toBe(2);

    // 3. The button.
    expect(
      out.passesWithForce,
      'clicking Sync now while a sync is running still syncs',
    ).toBe(2);
  },
});
