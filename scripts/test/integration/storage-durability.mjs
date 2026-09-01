// Pin that the app actually asks the browser to keep its data, and reports the
// answer.
//
// The bug this guards against is silent by construction. Everything the app
// owns lives in IndexedDB, which is *best-effort* storage unless the origin
// asks for a promise — and for the whole life of the app it never asked. An
// evicted origin comes back signed out with an empty library, which reads as
// data loss rather than as a browser reclaiming space.
//
// So the load-bearing assertion is not "a card renders" — a card would render
// just as happily over a `persist()` call that never happens. It is that the
// Storage API was *consulted during boot*, proven by instrumenting it before
// the app's own scripts run.

import { runBrowserTest, expect, appendBypass, DEFAULT_URL, pollUntil } from '../harness.mjs';

await runBrowserTest({
  name: 'storage-durability',
  viewport: { width: 1280, height: 1024 },
  skipInitialGoto: true,
  async run({ page }) {
    // Instrument before any app code exists in the page. Instance properties
    // shadow the StorageManager prototype, so the app's calls land here.
    await page.addInitScript(() => {
      const sm = navigator.storage;
      if (!sm) return;
      window.__durability = { persisted: 0, persist: 0 };
      const origPersisted = sm.persisted?.bind(sm);
      const origPersist = sm.persist?.bind(sm);
      if (origPersisted) {
        Object.defineProperty(sm, 'persisted', {
          configurable: true,
          value: async () => {
            window.__durability.persisted++;
            return origPersisted();
          },
        });
      }
      if (origPersist) {
        Object.defineProperty(sm, 'persist', {
          configurable: true,
          value: async () => {
            window.__durability.persist++;
            return origPersist();
          },
        });
      }
    });

    await page.goto(appendBypass(DEFAULT_URL), { waitUntil: 'networkidle' });

    // 1. The app consulted durability at boot. `persisted()` is always called;
    //    `persist()` only when the browser has not already granted, so assert
    //    on the former and merely report the latter.
    const calls = await pollUntil(
      async () => {
        const c = await page.evaluate(() => window.__durability ?? null);
        return {
          done: !!c && c.persisted >= 1,
          value: c,
          label: `durability calls: ${JSON.stringify(c)}`,
        };
      },
      { timeoutMs: 15_000 },
    );
    expect(calls.persisted >= 1, 'boot asks whether storage is durable').toBeTruthy();

    // 2. Asking exactly once per page load — the answer is memoised, and in
    //    browsers that prompt, asking twice means prompting twice.
    expect(calls.persisted, 'durability is consulted once, not per render').toBe(1);

    // 3. Settings reports the answer, whatever it is. Headless Chromium has no
    //    engagement signal so it will normally refuse, but the card must be
    //    truthful rather than absent either way.
    await page.goto(appendBypass(`${DEFAULT_URL}settings`), {
      waitUntil: 'networkidle',
    });
    const cardText = await pollUntil(
      async () => {
        const text = await page.evaluate(() => {
          const h = Array.from(document.querySelectorAll('h2')).find(
            (n) => n.textContent?.trim() === 'Browser storage',
          );
          const card = h?.closest('section');
          return card ? (card.textContent ?? '') : '';
        });
        return { done: text.length > 0, value: text, label: `card: ${text.slice(0, 130)}` };
      },
      { timeoutMs: 15_000 },
    );

    const saysSomething =
      cardText.includes('has promised to keep') ||
      cardText.includes('best-effort') ||
      cardText.includes("won't say") ||
      cardText.includes("Couldn't check");
    expect(saysSomething, 'the card states a durability verdict').toBeTruthy();
    // Raw i18n keys leaking through means a missing translation.
    expect(cardText.includes('settings.storage.'), 'no raw i18n keys').toBeFalsy();
    // The usage readout should carry real numbers, not NaN.
    expect(cardText.includes('NaN'), 'usage numbers are real').toBeFalsy();

    // 4. A collapsed quota must be reported, loudly. This is the state that
    //    actually loses data — Chromium derives quota from free disk, and below
    //    its floors it refuses writes regardless of any durability grant — and
    //    it is invisible everywhere else on the machine, so a banner is the
    //    whole point. Stub `estimate()` to the shape a nearly-full disk gives.
    await page.addInitScript(() => {
      const sm = navigator.storage;
      if (!sm?.estimate) return;
      Object.defineProperty(sm, 'estimate', {
        configurable: true,
        value: async () => ({ usage: 0, quota: 13_900_000 }),
      });
    });
    await page.goto(appendBypass(`${DEFAULT_URL}settings`), {
      waitUntil: 'networkidle',
    });

    const alert = await pollUntil(
      async () => {
        const text = await page.evaluate(() => {
          const el = document.querySelector('[role="alert"]');
          return el ? (el.textContent ?? '') : '';
        });
        return { done: text.length > 0, value: text, label: `alert: ${text.slice(0, 110)}` };
      },
      { timeoutMs: 15_000 },
    );
    expect(
      alert.includes('disk space'),
      'a nearly-full disk raises an app-wide banner, not just a Settings line',
    ).toBeTruthy();
  },
});
