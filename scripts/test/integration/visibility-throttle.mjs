// Verify Pass 4.7: when the tab goes hidden, the engine pool's
// max-worker cap drops to 1 (so background-tab analysis stays cool /
// battery-friendly), and restores to its prior cap when the user
// returns.
//
// Drives visibility synthetically via `Object.defineProperty` +
// dispatching a `visibilitychange` event. The handler in queue.ts
// reads `document.hidden` directly, so the property override is
// enough to flip the branch.

import { runBrowserTest, expect } from '../harness.mjs';

await runBrowserTest({
  name: 'visibility-throttle',
  async run({ page }) {
    // The harness already navigated to `/` with the auth bypass on.
    // AppLayout's effect calls startAnalysisQueue(), which attaches
    // the visibilitychange listener. Give it a beat to settle.
    await page.waitForTimeout(300);

    const before = await page.evaluate(async () => {
      const { analysisPool } = await import('/src/engine/pool.ts');
      return analysisPool().capacity;
    });
    console.log('initial pool capacity:', before);
    expect(before, 'pool starts with default capacity').toBeAtLeast(1);

    // Hide the tab.
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', {
        value: 'hidden',
        configurable: true,
      });
      Object.defineProperty(document, 'hidden', {
        value: true,
        configurable: true,
      });
      document.dispatchEvent(
        new Event('visibilitychange', { bubbles: true, cancelable: false }),
      );
    });
    await page.waitForTimeout(150);

    const hidden = await page.evaluate(async () => {
      const { analysisPool } = await import('/src/engine/pool.ts');
      return analysisPool().capacity;
    });
    console.log('hidden capacity:', hidden);
    expect(hidden, 'pool dropped to 1 worker when hidden').toBe(1);

    // Bring the tab back.
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', {
        value: 'visible',
        configurable: true,
      });
      Object.defineProperty(document, 'hidden', {
        value: false,
        configurable: true,
      });
      document.dispatchEvent(
        new Event('visibilitychange', { bubbles: true, cancelable: false }),
      );
    });
    await page.waitForTimeout(150);

    const restored = await page.evaluate(async () => {
      const { analysisPool } = await import('/src/engine/pool.ts');
      return analysisPool().capacity;
    });
    console.log('restored capacity:', restored);
    expect(restored, 'pool capacity restored on visibility return').toBe(before);
  },
});
