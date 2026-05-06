// Shared Playwright harness for browser-driven tests.
//
// Centralizes the boilerplate every `scripts/test-*.mjs` used to repeat
// (browser launch, console wiring, dev-server health check, status
// polling, structured assertions). New tests should `import` from this
// module; legacy scripts work unchanged because they all do their own
// thing on top of `chromium`.
//
// Usage (typical):
//
//   import { runBrowserTest, expect } from './harness.mjs';
//
//   await runBrowserTest({
//     name: 'eval-cache',
//     async run({ page }) {
//       const result = await page.evaluate(...);
//       expect(result.warmHitRatio).toBeAtLeast(0.99);
//     },
//   });
//
// `runBrowserTest` returns a Promise that resolves with a verdict
// object. When invoked directly (`node scripts/test/foo.mjs`) it also
// calls `process.exit(failed ? 1 : 0)` for compatibility with the
// existing test scripts.

import { chromium } from 'playwright';

export const DEFAULT_URL = process.env.URL || 'http://localhost:5173/';

/** Query-string flag the dev-only auth bypass watches for. Centralised
 *  here so test scripts importing `appendBypass` don't have to know the
 *  exact name. Mirrors `QUERY_FLAG` in `src/lib/testAuth.ts`. */
export const E2E_AUTH_BYPASS_QUERY = 'e2e_auth_bypass=1';

/**
 * Append the auth-bypass query flag to a URL, preserving existing query
 * strings and fragments. Idempotent — calling it on a URL that already
 * has the flag is a no-op.
 *
 * Test scripts that build their own URLs (`${DEFAULT_URL}review/${id}`)
 * use this helper to opt into the bypass. Scripts that rely on the
 * harness's initial `page.goto(url)` get the flag injected automatically
 * via `bypassAuth: true` on `runBrowserTest`.
 */
export function appendBypass(url) {
  if (url.includes(E2E_AUTH_BYPASS_QUERY)) return url;
  const [base, hash] = url.split('#');
  const sep = base.includes('?') ? '&' : '?';
  const withQuery = `${base}${sep}${E2E_AUTH_BYPASS_QUERY}`;
  return hash !== undefined ? `${withQuery}#${hash}` : withQuery;
}

/**
 * Verify the dev server responds on the configured URL before launching
 * a browser. Failing fast here saves ~3 s of confusing Chromium errors
 * when the user forgot to run `npm run dev`.
 */
export async function ensureDevServer(url = DEFAULT_URL) {
  try {
    const res = await fetch(url, { method: 'GET' });
    if (!res.ok && res.status !== 304) {
      throw new Error(`dev server at ${url} returned HTTP ${res.status}`);
    }
  } catch (err) {
    throw new Error(
      `Cannot reach dev server at ${url}. Run \`npm run dev\` in another terminal first. ` +
        `(Underlying error: ${err instanceof Error ? err.message : String(err)})`,
    );
  }
}

/**
 * Tiny chainable assertion API. We deliberately avoid pulling in a heavy
 * test runner (jest/vitest) here because these scripts already manage
 * their own browser lifecycle and we want a single `node scripts/...`
 * entry point with no extra dependencies.
 */
export class Expectation {
  constructor(actual, label) {
    this.actual = actual;
    this.label = label;
  }
  toBe(expected) {
    if (!Object.is(this.actual, expected)) {
      throw new AssertionError(
        `${this.label ?? 'value'}: expected ${fmt(expected)}, got ${fmt(this.actual)}`,
      );
    }
  }
  toEqual(expected) {
    if (JSON.stringify(this.actual) !== JSON.stringify(expected)) {
      throw new AssertionError(
        `${this.label ?? 'value'}: expected ${fmt(expected)}, got ${fmt(this.actual)}`,
      );
    }
  }
  toBeTruthy() {
    if (!this.actual) {
      throw new AssertionError(`${this.label ?? 'value'}: expected truthy, got ${fmt(this.actual)}`);
    }
  }
  toBeFalsy() {
    if (this.actual) {
      throw new AssertionError(`${this.label ?? 'value'}: expected falsy, got ${fmt(this.actual)}`);
    }
  }
  toBeAtLeast(n) {
    if (typeof this.actual !== 'number' || !(this.actual >= n)) {
      throw new AssertionError(
        `${this.label ?? 'value'}: expected ≥ ${n}, got ${fmt(this.actual)}`,
      );
    }
  }
  toBeAtMost(n) {
    if (typeof this.actual !== 'number' || !(this.actual <= n)) {
      throw new AssertionError(
        `${this.label ?? 'value'}: expected ≤ ${n}, got ${fmt(this.actual)}`,
      );
    }
  }
  toBeGreaterThan(n) {
    if (typeof this.actual !== 'number' || !(this.actual > n)) {
      throw new AssertionError(
        `${this.label ?? 'value'}: expected > ${n}, got ${fmt(this.actual)}`,
      );
    }
  }
  toBeLessThan(n) {
    if (typeof this.actual !== 'number' || !(this.actual < n)) {
      throw new AssertionError(
        `${this.label ?? 'value'}: expected < ${n}, got ${fmt(this.actual)}`,
      );
    }
  }
}

export class AssertionError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'AssertionError';
  }
}

function fmt(v) {
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number' || typeof v === 'boolean' || v === null || v === undefined) return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export function expect(actual, label) {
  return new Expectation(actual, label);
}

/**
 * Poll a function until it returns a "done" signal or a timeout elapses.
 *
 * @param {() => Promise<{ done: boolean, value?: any, label?: string }>} probe
 * @param {object} opts
 * @param {number} [opts.timeoutMs] default 60s
 * @param {number} [opts.intervalMs] default 500ms
 * @param {boolean} [opts.logOnChange] default true — print every time the label changes.
 */
export async function pollUntil(probe, opts = {}) {
  const { timeoutMs = 60_000, intervalMs = 500, logOnChange = true } = opts;
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeoutMs) {
    const r = await probe();
    if (logOnChange && r?.label && r.label !== last) {
      console.log(`  ${new Date().toISOString()}  ${r.label}`);
      last = r.label;
    }
    if (r?.done) return r.value ?? r;
    await sleep(intervalMs);
  }
  throw new AssertionError(`pollUntil timed out after ${timeoutMs}ms (last: ${last ?? '?'})`);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Spin up Chromium, open the dev server, run the supplied test function,
 * tear everything down. Console errors in the page are collected and
 * printed at the end (and counted toward failure when `failOnPageErrors`
 * is true — default false because the page may legitimately log warnings).
 *
 * @param {object} opts
 * @param {string} opts.name human-readable test name (used in logs).
 * @param {(ctx: { page: import('playwright').Page, browser: import('playwright').Browser, errors: string[], logs: string[] }) => Promise<void>} opts.run
 * @param {string} [opts.url] override the URL (defaults to `process.env.URL` then `http://localhost:5173/`).
 * @param {{ width: number, height: number }} [opts.viewport]
 * @param {'load' | 'domcontentloaded' | 'networkidle' | 'commit'} [opts.waitUntil] default 'networkidle'. Use 'domcontentloaded' for tests that boot Web Workers (networkidle never settles).
 * @param {boolean} [opts.captureRequestFailed] default false. When true, request-failed events are appended to `logs` (also surfaced in the failure tail).
 * @param {boolean} [opts.captureAllConsole] default false. When true, every console message is appended to `logs` (not just errors). Errors always go to `errors`.
 * @param {boolean} [opts.failOnPageErrors] default false.
 * @param {boolean} [opts.skipDevServerCheck] default false.
 * @param {boolean} [opts.skipInitialGoto] default false. Useful when the test needs to navigate to a non-root URL itself.
 * @param {boolean} [opts.exitOnFinish] default true (process.exit(0|1) at end). Set false from runners.
 * @param {boolean} [opts.bypassAuth] default true. When true, the dev-only auth bypass query flag is appended to the initial `page.goto`, so the page boots into a synthetic signed-in session that satisfies `<AuthGate>` without a real Clerk OAuth round-trip. Test scripts that build their own URLs should also call `appendBypass(url)` before passing them to `page.goto`.
 */
export async function runBrowserTest(opts) {
  const rawUrl = opts.url ?? DEFAULT_URL;
  const bypassAuth = opts.bypassAuth ?? true;
  const url = bypassAuth ? appendBypass(rawUrl) : rawUrl;
  const waitUntil = opts.waitUntil ?? 'networkidle';
  const failOnPageErrors = opts.failOnPageErrors ?? false;
  const exitOnFinish = opts.exitOnFinish ?? true;

  if (!opts.skipDevServerCheck) {
    await ensureDevServer(url);
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext(
    opts.viewport ? { viewport: opts.viewport } : undefined,
  );
  const page = await context.newPage();

  const errors = [];
  const logs = [];
  page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
  page.on('console', (m) => {
    const text = `[${m.type()}] ${m.text()}`;
    if (m.type() === 'error') errors.push(`[console.error] ${m.text()}`);
    if (opts.captureAllConsole) logs.push(text);
  });
  if (opts.captureRequestFailed) {
    page.on('requestfailed', (req) => {
      logs.push(`[requestfailed] ${req.url()} :: ${req.failure()?.errorText}`);
    });
  }

  console.log(`▶ ${opts.name}  (URL=${url})`);
  const t0 = Date.now();
  let failure = null;
  try {
    if (!opts.skipInitialGoto) {
      await page.goto(url, { waitUntil });
    }
    await opts.run({ page, browser, errors, logs });
  } catch (err) {
    failure = err;
  } finally {
    await browser.close().catch(() => {});
  }

  const elapsed = Date.now() - t0;
  if (failure) {
    console.error(`✗ ${opts.name}  (${elapsed}ms)`);
    console.error(failure instanceof Error ? failure.stack ?? failure.message : String(failure));
    if (errors.length) {
      console.error('--- page errors ---');
      for (const e of errors) console.error(e);
    }
    if (exitOnFinish) process.exit(1);
    return { ok: false, error: failure, errors, elapsed };
  }

  if (failOnPageErrors && errors.length) {
    console.error(`✗ ${opts.name}  (${elapsed}ms) — page produced ${errors.length} error(s):`);
    for (const e of errors) console.error('  ' + e);
    if (exitOnFinish) process.exit(1);
    return { ok: false, errors, elapsed };
  }

  console.log(`✓ ${opts.name}  (${elapsed}ms)`);
  if (errors.length) {
    console.log(`  (note: ${errors.length} non-fatal page log(s))`);
  }
  if (exitOnFinish) process.exit(0);
  return { ok: true, errors, elapsed };
}
