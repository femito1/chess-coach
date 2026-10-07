// Verify `updateSettings` (`src/db/schema.ts`) never loses a concurrent patch.
//
// The `settings` table is one row, and many writers patch different fields of
// it: every boot pass stamps its own version marker, the Settings page saves the
// user's toggles, new-games checks record their timestamps. `updateSettings` was
// a bare read-then-put — two calls in flight both read the same row, and the
// second put wrote the first one's field back to its old value.
//
// Found through `auto-analyze`, which went red in CI only: it turns
// `autoAnalyze` off while the live app's boot passes are stamping the same row,
// and a pass that had read the row first put `autoAnalyze: true` back. The same
// race reverts a real user's toggle if they flip it while a pass is running.
//
// Deterministic, unlike the CI flake: N writers are started together, each
// patching a different field, so a lost update is not a timing accident here.

import { runBrowserTest, expect, DEFAULT_URL, appendBypass } from '../harness.mjs';

await runBrowserTest({
  name: 'settings-concurrent-update',
  waitUntil: 'domcontentloaded',
  skipInitialGoto: true,
  async run({ page }) {
    await page.goto(appendBypass(DEFAULT_URL), { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('a[href="/puzzles"]', { timeout: 15_000 });

    const result = await page.evaluate(async () => {
      const { updateSettings, getSettings } = await import('/src/db/schema.ts');
      const N = 12;
      // Distinct fields per writer so every patch is independently checkable.
      // Unknown keys are fine — the row is schemaless to Dexie.
      await Promise.all(
        Array.from({ length: N }, (_, i) =>
          updateSettings({ [`__concurrent_probe_${i}`]: i }),
        ),
      );
      const s = await getSettings();
      const survived = Array.from({ length: N }, (_, i) => s[`__concurrent_probe_${i}`] === i);
      return { n: N, survived: survived.filter(Boolean).length };
    });

    expect(
      result.survived,
      `all ${result.n} concurrent updateSettings patches survive (a lost update drops some)`,
    ).toBe(result.n);
  },
});
