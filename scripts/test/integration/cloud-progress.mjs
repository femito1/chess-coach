// Does the Settings card's cloud-analysis readout stay cheap, and does it render?
//
// `cloudProgress.test.ts` pins the arithmetic. What it cannot see is the thing
// that actually matters about this feature: the SHAPE of the requests. The whole
// design rests on counting without transferring rows — the card polls, and a
// library of 1 800 analyses is tens of megabytes of `data`. A refactor that
// dropped `head: true`, or reached for `.select('engine')` to tally NNUE
// client-side, would still render the right number and would still pass a unit
// test. So this drives the real `fetchCloudCounts` against a fake PostgREST that
// records how it was asked, and fails if any row payload is requested.
//
// It also mounts the card, because two things there are only observable in a
// browser: that the E2E bypass stub answers count queries at all (cloud sync is
// mounted in `AppLayout`, so a throw would break EVERY browser test), and that
// the readout renders instead of crashing the Settings page.
//
// Run: node scripts/run-tests.mjs --only=cloud-progress

import { runBrowserTest, expect, appendBypass, sleep } from '../harness.mjs';

const USER = 'user_cloudprogress_test';

await runBrowserTest({
  name: 'cloud-progress',
  waitUntil: 'domcontentloaded',
  skipInitialGoto: true,
  async run({ page }) {
    await page.goto(appendBypass('http://localhost:5173/settings'), {
      waitUntil: 'domcontentloaded',
    });
    await page.waitForSelector('a[href="/puzzles"]', { timeout: 15_000 });

    /* ------------------------------------------------------------------ */
    /*  Request shape + summary, against a recording fake                 */
    /* ------------------------------------------------------------------ */
    const out = await page.evaluate(async (userId) => {
      const { fetchCloudCounts, summarizeCloudProgress, NNUE_ENGINE_PATTERN } =
        await import('/src/features/sync/cloudProgress.ts');

      /** Every query the module issued, as the fake saw it. */
      const calls = [];

      // Stand-in row counts. NNUE < analyses < games, so a bug that returns the
      // wrong query's count is visible rather than coincidentally right.
      const totals = { cloud_games: 1783, cloud_analyses: 1204, nnue: 900 };

      const supabase = {
        from(table) {
          const call = { table, columns: null, options: null, filters: [] };
          calls.push(call);
          const builder = {
            select(columns, options) {
              call.columns = columns;
              call.options = options ?? null;
              return builder;
            },
            eq(column, value) {
              call.filters.push([column, value]);
              return builder;
            },
            like(column, pattern) {
              call.filters.push(['like:' + column, pattern]);
              return builder;
            },
            // PostgREST builders are thenables; the module awaits them directly.
            then(onFulfilled, onRejected) {
              const isNnueQuery = call.filters.some((f) => f[0] === 'like:engine');
              const count =
                table === 'cloud_games'
                  ? totals.cloud_games
                  : isNnueQuery
                    ? totals.nnue
                    : totals.cloud_analyses;
              // `head: true` means PostgREST sends no body at all. Model that
              // literally: `data` is null, so any consumer that tried to read
              // rows would break here exactly as it would in production.
              const payload = call.options?.head
                ? { data: null, count, error: null }
                : { data: [], count, error: null };
              return Promise.resolve(payload).then(onFulfilled, onRejected);
            },
          };
          return builder;
        },
      };

      const { counts, error } = await fetchCloudCounts(supabase, userId);
      const summary = counts ? summarizeCloudProgress(counts) : null;

      /* ---- and the failure path: an errored count must not throw ------ */
      const failing = {
        from: () => ({
          select: () => ({
            eq: () => ({
              like: () => failing.from().select().eq(),
              then: (f, r) =>
                Promise.resolve({
                  data: null,
                  count: null,
                  error: { message: 'permission denied' },
                }).then(f, r),
            }),
          }),
        }),
      };
      const failed = await fetchCloudCounts(failing, userId);

      /* ---- and a client that throws synchronously from `.from()` ------ */
      // The E2E bypass stub does this for tables it doesn't model, and cloud
      // sync runs app-wide, so an escaping throw would be a page error
      // everywhere.
      const thrower = {
        from: () => {
          throw new Error('no such table');
        },
      };
      const threw = await fetchCloudCounts(thrower, userId);

      return {
        error: error ?? null,
        counts,
        summary,
        pattern: NNUE_ENGINE_PATTERN,
        calls,
        failed: { counts: failed.counts, error: failed.error ?? null },
        threw: { counts: threw.counts, error: threw.error ?? null },
      };
    }, USER);

    console.log(JSON.stringify(out, null, 1));

    expect(out.error, 'no error from the happy path').toBe(null);
    expect(out.counts.games, 'games counted').toBe(1783);
    expect(out.counts.analyses, 'analyses counted').toBe(1204);
    expect(out.counts.nnueAnalyses, 'NNUE analyses counted').toBe(900);
    expect(out.summary.percent, 'percent derived').toBe(68);
    expect(out.summary.complete, 'not complete').toBe(false);
    expect(out.summary.allNnue, 'not all NNUE').toBe(false);
    expect(out.summary.classicalAnalyses, 'classical remainder').toBe(304);

    /* ---- the assertion this test exists for -------------------------- */
    expect(out.calls.length, 'exactly three queries').toBe(3);
    for (const call of out.calls) {
      expect(call.options?.count, `${call.table}: exact count requested`).toBe('exact');
      // `head: true` is the line that keeps this affordable to poll. Without it
      // PostgREST returns every row alongside the count.
      expect(call.options?.head, `${call.table}: head-only (no row payload)`).toBe(true);
      expect(
        call.columns,
        `${call.table}: must not name columns — that would select row data`,
      ).toBe('*');
      expect(
        JSON.stringify(call.filters).includes('user_id'),
        `${call.table}: scoped to the user`,
      ).toBe(true);
    }

    const tables = out.calls.map((c) => c.table).sort();
    expect(JSON.stringify(tables), 'tables queried').toBe(
      JSON.stringify(['cloud_analyses', 'cloud_analyses', 'cloud_games']),
    );
    const nnueCall = out.calls.find((c) =>
      c.filters.some((f) => f[0] === 'like:engine'),
    );
    expect(Boolean(nnueCall), 'one query filters on the engine column').toBe(true);
    expect(nnueCall.filters.find((f) => f[0] === 'like:engine')[1], 'NNUE pattern').toBe(
      out.pattern,
    );

    /* ---- failures degrade quietly ------------------------------------ */
    expect(out.failed.counts, 'an errored count yields no counts').toBe(null);
    expect(Boolean(out.failed.error), 'an errored count reports an error').toBe(true);
    expect(out.threw.counts, 'a throwing client yields no counts').toBe(null);
    expect(out.threw.error, 'a throwing client is caught, not propagated').toBe(
      'no such table',
    );

    /* ------------------------------------------------------------------ */
    /*  The card renders                                                  */
    /* ------------------------------------------------------------------ */
    // The bypass stub reports this synthetic identity as NOT allowlisted, so the
    // card is hidden by design. Force the store into `ready` — the same state a
    // real enrolled account lands in — so the readout actually mounts. This also
    // exercises the stub's own count answers, which is what proves cloud sync
    // can't throw in every other browser test.
    // Look for the card's own <h2>, not for the words anywhere on the page.
    // A body-text regex also matches any *prose* that mentions cloud sync —
    // the storage-durability card names it as the mitigation for evicted
    // local data — which made this read "card visible" with no card mounted.
    const hiddenFirst = await page.evaluate(() => ({
      cardVisible: Array.from(document.querySelectorAll('h2')).some(
        (h) => h.textContent?.trim() === 'Cloud sync',
      ),
    }));
    expect(hiddenFirst.cardVisible, 'card hidden for a non-allowlisted account').toBe(
      false,
    );

    await page.evaluate(async () => {
      const { useSyncStore } = await import('/src/features/sync/useCloudSync.ts');
      useSyncStore.getState().setPhase({ kind: 'ready' });
    });
    await page.waitForFunction(
      () =>
        Array.from(document.querySelectorAll('h2')).some(
          (h) => h.textContent?.trim() === 'Cloud sync',
        ),
      undefined,
      { timeout: 10_000 },
    );
    // Let the hook's first count read land.
    await sleep(800);

    const rendered = await page.evaluate(() => {
      const text = document.body.innerText;
      return {
        hasCloudBlock: /In the cloud/i.test(text),
        hasRefresh: Boolean(
          Array.from(document.querySelectorAll('button')).find((b) =>
            /^Refresh$/i.test(b.innerText.trim()),
          ),
        ),
        // The stub answers every count as 0, which is the `empty` branch.
        saysEmpty: /Nothing uploaded yet/i.test(text),
        // Nothing may be left untranslated.
        rawKeys: /sync\.cloud\./.test(text),
        hint: /Counts only/i.test(text),
      };
    });
    console.log('rendered:', JSON.stringify(rendered));

    expect(rendered.hasCloudBlock, 'cloud progress block rendered').toBe(true);
    expect(rendered.hasRefresh, 'manual refresh button rendered').toBe(true);
    expect(rendered.saysEmpty, 'empty cloud reported as empty, not as 0%').toBe(true);
    expect(rendered.rawKeys, 'no untranslated i18n keys leaked into the DOM').toBe(false);
    expect(rendered.hint, 'cost hint rendered').toBe(true);

    // Manual refresh must not throw or blank the block.
    await page.locator('button', { hasText: /^Refresh$/ }).first().click();
    await sleep(600);
    const afterRefresh = await page.evaluate(() => ({
      stillThere: /In the cloud/i.test(document.body.innerText),
    }));
    expect(afterRefresh.stillThere, 'block survives a manual refresh').toBe(true);
  },
});
