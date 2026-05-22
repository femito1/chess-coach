// Smoke test for the Chrome extension. Loads the unpacked extension
// into a persistent Chromium context and walks two scenarios:
//
//   (A) "Old" chess.com markup — `.game-over-modal-content` modal
//       on a `/game/live/<id>` URL. Ensures we haven't regressed
//       detection for users whose chess.com still serves this.
//
//   (B) "New" chess.com markup — only a bare `class="game-result"`
//       element on a `/game/<id>` URL (no `live/` segment, no
//       `game-over` ancestor anywhere). This is the markup the
//       user reported on 2026-05-08.
//
// Both must trigger the prompt with a structurally-correct deep link.
// The script also exercises the manual-trigger fallback (toolbar
// action → forcePrompt message). Captures a screenshot for visual
// confirmation.
//
// Run from the repo root:
//   node scripts/test/integration/extension.mjs
//
// NOT included in the manifest / default `npm test` run, because
// chrome extensions require a real Chrome head (headless: false in
// `chromium.launchPersistentContext`) which isn't available in the
// CI environment. Run on demand when the extension changes.
//
// Doesn't require `npm run dev` — the deep link is built but not
// followed.

import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const EXT_DIR = path.join(REPO_ROOT, 'extension');
const SCREENSHOT_DIR = REPO_ROOT;

/**
 * Synthetic-page templates. Each scenario serves an HTML doc that
 * mimics one of the chess.com finished-game markup styles closely
 * enough to trip a specific layer of the content-script detection
 * heuristic.
 */
const SCENARIOS = [
  {
    name: 'old-game-over-modal',
    url: 'https://www.chess.com/game/live/9999999',
    expectedDeepLinkId: '9999999',
    html: `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="user" content="HeroUser" />
    <title>Chess.com (synthetic — old modal)</title>
    <style>
      body { font-family: system-ui, sans-serif; background:#312e2b; color:#fff; padding:40px; }
      .game-over-modal-content { position: fixed; top:50%; left:50%; transform:translate(-50%,-50%); background:#262421; padding:32px 48px; border-radius:8px; text-align:center; min-width:360px; }
      .game-over-header-component { font-size: 28px; margin-bottom: 12px; }
    </style>
  </head>
  <body>
    <div>(synthetic chess.com — OLD markup)</div>
    <div class="game-over-modal-content" role="dialog">
      <div class="game-over-header-component">You Won!</div>
      <div>HeroUser vs Villain</div>
      <div class="game-over-review-button-component"><button>Game Review</button></div>
    </div>
  </body>
</html>`,
  },
  {
    name: 'new-bare-game-result',
    url: 'https://www.chess.com/game/168426791620',
    expectedDeepLinkId: '168426791620',
    html: `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="user" content="HeroUser" />
    <title>Chess.com (synthetic — new game-result)</title>
    <style>
      body { font-family: system-ui, sans-serif; background:#312e2b; color:#fff; padding:40px; }
      .game-result { display:inline-block; background:#262421; padding:12px 18px; border-radius:6px; }
    </style>
  </head>
  <body>
    <div>(synthetic chess.com — NEW markup, bare /game/ URL)</div>
    <div>
      <span class="game-result">1-0</span>
      <span> HeroUser vs Villain</span>
    </div>
  </body>
</html>`,
  },
];

async function runScenario(ctx, svcWorker, scenario) {
  const consoleLines = [];

  const page = await ctx.newPage();
  page.on('console', (m) => consoleLines.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => consoleLines.push(`[pageerror] ${e.message}`));

  await page.route('https://www.chess.com/**', async (route) => {
    const req = route.request();
    if (req.resourceType() === 'document') {
      return route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: scenario.html,
      });
    }
    // Stub everything else (favicons, fonts, etc.)
    return route.fulfill({ status: 204, body: '' });
  });

  await page.goto(scenario.url, { waitUntil: 'domcontentloaded' });

  // Auto-detection — heartbeat is 1.5 s, give it 8 s.
  let auto = false;
  try {
    await page.waitForSelector('#chess-coach-prompt', { timeout: 8000 });
    auto = true;
  } catch {
    auto = false;
  }

  const screenshotPath = path.join(
    SCREENSHOT_DIR,
    `extension-test-${scenario.name}.png`,
  );
  // Screenshots are diagnostic, not a correctness signal — they let
  // a failing run leave a visual breadcrumb. On WSL/headless Chrome
  // builds, `Page.captureScreenshot` is intermittently flaky after
  // the page paints icons (manifest `action.default_icon`). Don't
  // fail the run on a screenshot error; retry once with a brief
  // settle delay, then move on.
  let screenshotOk = false;
  for (const delay of [0, 250]) {
    if (delay) await page.waitForTimeout(delay);
    try {
      await page.screenshot({ path: screenshotPath, fullPage: false });
      screenshotOk = true;
      break;
    } catch (_e) {
      // try again or give up
    }
  }

  // Confirm the deep link the panel will open is structurally correct.
  // The script logs `showing prompt for X → Y`; pull Y out.
  const showingLine = consoleLines.find((l) =>
    l.includes('[chess-coach] showing prompt for'),
  );
  let deepLink = null;
  if (showingLine) {
    const m = showingLine.match(/→ (.+)$/);
    if (m) deepLink = m[1].trim();
  }

  // Manual-trigger fallback: dismiss the panel, then send a
  // forcePrompt message via the service worker.
  await page.evaluate(() => {
    document.querySelector('#chess-coach-prompt')?.remove();
  });

  const tabs = await svcWorker.evaluate(async () => {
    // eslint-disable-next-line no-undef
    const all = await chrome.tabs.query({});
    return all.map((t) => ({ id: t.id, url: t.url }));
  });
  const tab = tabs.find((t) => (t.url ?? '') === scenario.url);
  let manual = false;
  if (tab) {
    try {
      await svcWorker.evaluate(async (tabId) => {
        // eslint-disable-next-line no-undef
        await chrome.tabs.sendMessage(tabId, { type: 'forcePrompt' });
      }, tab.id);
      await page.waitForSelector('#chess-coach-prompt', { timeout: 5000 });
      manual = true;
    } catch {
      manual = false;
    }
  }

  await page.close();

  return {
    auto,
    manual,
    deepLink,
    screenshotPath: screenshotOk ? screenshotPath : null,
    consoleLines: consoleLines.filter((l) => l.includes('[chess-coach]')),
    errorLines: consoleLines.filter(
      (l) => l.includes('[pageerror]') || /^\[error\]/.test(l),
    ),
  };
}

/**
 * Cross-navigation contract test (added 2026-05-21).
 *
 * Drives the content script through a sequence of SPA navigations
 * inside a single tab to verify the user-visible behaviours added in
 * the URL-based-detection rewrite:
 *
 *   1. Hide-on-new-game — finishing a game then starting a new one
 *      (URL transitions away from a game id) tears down the panel.
 *   2. Re-prompt-after-dismiss — dismissing the panel for game A and
 *      then SPA-navigating to a different finished game (game B)
 *      shows the panel again. This is the "I closed it, finish next
 *      game, it should pop again" behaviour the user asked for.
 */
async function runNavigationContracts(ctx) {
  const consoleLines = [];

  const stubHtml = `<!DOCTYPE html>
<html>
  <head><meta charset="utf-8" /><meta name="user" content="HeroUser" /></head>
  <body><div id="stub">stub page (URL-based detection — no DOM heuristic needed)</div></body>
</html>`;

  const page = await ctx.newPage();
  page.on('console', (m) => consoleLines.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => consoleLines.push(`[pageerror] ${e.message}`));

  await page.route('https://www.chess.com/**', (route) => {
    return route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: stubHtml,
    });
  });

  await page.goto('https://www.chess.com/game/1111111', { waitUntil: 'domcontentloaded' });
  try {
    await page.waitForSelector('#chess-coach-prompt', { timeout: 5000 });
  } catch {
    await page.close();
    return {
      passed: false,
      failure: 'panel did not appear on initial load of /game/1111111',
      consoleLines: consoleLines.filter((l) => l.includes('[chess-coach]')),
    };
  }

  await page.evaluate(() => {
    history.pushState({}, '', '/play/online');
  });
  let panelHidAfterNav = false;
  for (let i = 0; i < 15; i++) {
    await page.waitForTimeout(200);
    const present = await page.locator('#chess-coach-prompt').count();
    if (present === 0) {
      panelHidAfterNav = true;
      break;
    }
  }
  if (!panelHidAfterNav) {
    await page.close();
    return {
      passed: false,
      failure: 'panel did not disappear after URL changed to /play/online',
      consoleLines: consoleLines.filter((l) => l.includes('[chess-coach]')),
    };
  }

  await page.evaluate(() => {
    history.pushState({}, '', '/game/2222222');
  });
  try {
    await page.waitForSelector('#chess-coach-prompt', { timeout: 5000 });
  } catch {
    await page.close();
    return {
      passed: false,
      failure: 'panel did not reappear on SPA nav to /game/2222222',
      consoleLines: consoleLines.filter((l) => l.includes('[chess-coach]')),
    };
  }

  await page.locator('#chess-coach-prompt .cc-secondary').click();
  await page.waitForTimeout(1500);
  const stillDismissedB = (await page.locator('#chess-coach-prompt').count()) === 0;
  if (!stillDismissedB) {
    await page.close();
    return {
      passed: false,
      failure:
        'panel re-injected for game B after dismissal (should respect dismissal until URL change)',
      consoleLines: consoleLines.filter((l) => l.includes('[chess-coach]')),
    };
  }

  await page.evaluate(() => {
    history.pushState({}, '', '/game/3333333');
  });
  try {
    await page.waitForSelector('#chess-coach-prompt', { timeout: 5000 });
  } catch {
    await page.close();
    return {
      passed: false,
      failure: 'panel did not re-appear for game C after dismissing on game B',
      consoleLines: consoleLines.filter((l) => l.includes('[chess-coach]')),
    };
  }

  await page.close();
  return {
    passed: true,
    consoleLines: consoleLines.filter((l) => l.includes('[chess-coach]')),
  };
}

async function main() {
  // Each run gets a fresh Chrome profile so configured options /
  // storage state don't leak across runs.
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'chess-coach-ext-'));
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: false, // extensions require a real Chrome head per Playwright docs
    args: [
      `--disable-extensions-except=${EXT_DIR}`,
      `--load-extension=${EXT_DIR}`,
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });

  // Pre-seed the extension's options storage so the content script
  // doesn't have to hand-fill the username field. Done through the
  // extension's service worker.
  const svcWorker =
    ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'));
  await svcWorker.evaluate(async () => {
    return new Promise((resolve) => {
      // eslint-disable-next-line no-undef
      chrome.storage.sync.set(
        {
          coachOrigin: 'http://localhost:5173',
          chesscomUsername: 'HeroUser',
          enabled: true,
        },
        () => resolve(),
      );
    });
  });

  const results = [];
  for (const scenario of SCENARIOS) {
    const r = await runScenario(ctx, svcWorker, scenario);
    results.push({ scenario, ...r });
  }

  // Cross-navigation contracts (added 2026-05-21):
  //   1. Hide-on-new-game     — finish game A, start a new game
  //                             (URL → /play/online with no game id),
  //                             panel disappears.
  //   2. Re-prompt-after-dismiss — finish game A, dismiss the panel,
  //                                finish game B (SPA pushState),
  //                                panel re-appears for B.
  const navResult = await runNavigationContracts(ctx);
  if (!navResult.passed) {
    results.push({
      scenario: { name: 'navigation-contracts' },
      auto: false,
      manual: false,
      deepLink: null,
      screenshotPath: null,
      consoleLines: navResult.consoleLines,
      errorLines: [navResult.failure ?? 'unknown failure'],
    });
  } else {
    results.push({
      scenario: { name: 'navigation-contracts' },
      auto: true,
      manual: true,
      deepLink: 'n/a',
      screenshotPath: null,
      consoleLines: navResult.consoleLines,
      errorLines: [],
      isNav: true,
    });
  }

  await ctx.close();
  await fs.rm(userDataDir, { recursive: true, force: true });

  // Print verdict.
  console.log('\n══ Extension smoke test ══');
  let allPassed = true;
  for (const r of results) {
    console.log(`\n  scenario: ${r.scenario.name}`);
    if (r.isNav) {
      const ok = r.auto && r.manual && r.errorLines.length === 0;
      if (!ok) allPassed = false;
      console.log(`    hide-on-new-game:        ${r.auto ? 'PASS' : 'FAIL'}`);
      console.log(`    re-prompt-after-dismiss: ${r.manual ? 'PASS' : 'FAIL'}`);
    } else {
      const okAuto = r.auto;
      const okManual = r.manual;
      const okLink =
        typeof r.deepLink === 'string' &&
        r.deepLink.includes(`url=https%3A%2F%2Fwww.chess.com%2F`) &&
        r.deepLink.includes(r.scenario.expectedDeepLinkId);
      const allOk = okAuto && okManual && okLink;
      if (!allOk) allPassed = false;
      console.log(`    auto-detection: ${okAuto ? 'PASS' : 'FAIL'}`);
      console.log(`    manual-trigger: ${okManual ? 'PASS' : 'FAIL'}`);
      console.log(
        `    deep link OK:   ${okLink ? 'PASS' : 'FAIL'} ${
          r.deepLink ? `(${r.deepLink})` : '(no link captured)'
        }`,
      );
      console.log(
        `    screenshot:     ${r.screenshotPath ?? '(skipped — capture failed, see notes in script)'}`,
      );
    }
    if (r.errorLines.length > 0) {
      console.log('    errors:');
      for (const line of r.errorLines) console.log('      ' + line);
    }
    if (process.env.VERBOSE) {
      console.log('    log:');
      for (const line of r.consoleLines) console.log('      ' + line);
    }
  }

  console.log(`\n${allPassed ? '✓ all scenarios PASSED' : '✗ at least one scenario FAILED'}\n`);
  process.exit(allPassed ? 0 : 1);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(2);
});
