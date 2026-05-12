// Catalog of every browser-driven test script and its category.
//
// Categories:
//   - 'integration' — synthetic data / local logic exercised via the
//                     real browser stack (Stockfish, IndexedDB, queue).
//                     Self-contained, deterministic (no external API).
//   - 'e2e'         — drives the real UI (review page, board, etc).
//   - 'live'        — depends on the live Chess.com API. Slow + flaky;
//                     run only on demand.
//
// To add a new browser-driven test:
//   1) Drop a file in scripts/test/<category>/<name>.mjs. Use
//      `runBrowserTest()` from harness.mjs so the boilerplate (browser,
//      console wiring, assertions, polling) is shared.
//   2) Add an entry below.
//   3) Mention it in TESTING.md under the right feature section.
//
// Layout: paths are relative to the repo root.

export const BROWSER_TESTS = [
  // --- Auth / test-mode infra -------------------------------------
  { name: 'auth-bypass',                file: 'scripts/test/integration/auth-bypass.mjs',                category: 'integration' },

  // --- Engine + queue + cache (core analysis pipeline) -------------
  { name: 'engine',                     file: 'scripts/test/integration/engine.mjs',                     category: 'integration' },
  { name: 'analyze',                    file: 'scripts/test/integration/analyze.mjs',                    category: 'integration' },
  { name: 'full-queue',                 file: 'scripts/test/integration/full-queue.mjs',                 category: 'integration' },
  { name: 'heal',                       file: 'scripts/test/integration/heal.mjs',                       category: 'integration' },
  { name: 'pool-idle-teardown',         file: 'scripts/test/integration/pool-idle-teardown.mjs',         category: 'integration' },
  { name: 'eval-cache',                 file: 'scripts/test/integration/eval-cache.mjs',                 category: 'integration' },
  { name: 'queue-newest-first',         file: 'scripts/test/integration/queue-newest-first.mjs',         category: 'integration' },
  { name: 'device-probe',               file: 'scripts/test/integration/device-probe.mjs',               category: 'integration' },
  { name: 'visibility-throttle',        file: 'scripts/test/integration/visibility-throttle.mjs',        category: 'integration' },

  // --- Classification + accuracy + recompute -----------------------
  { name: 'recompute',                  file: 'scripts/test/integration/recompute.mjs',                  category: 'integration' },
  { name: 'recompute-skip',             file: 'scripts/test/integration/recompute-skip.mjs',             category: 'integration' },
  { name: 'recompute-all',              file: 'scripts/test/integration/recompute-all.mjs',              category: 'integration' },
  { name: 'user-time-backfill',         file: 'scripts/test/integration/user-time-backfill.mjs',         category: 'integration' },
  { name: 'classifications',            file: 'scripts/test/live/classifications.mjs',                   category: 'live' },
  { name: 'accuracy',                   file: 'scripts/test/live/accuracy.mjs',                          category: 'live' },
  { name: 'accuracy-low',               file: 'scripts/test/live/accuracy-low.mjs',                      category: 'live' },

  // --- Importing + persistence ------------------------------------
  { name: 'dexie-v10-wipe',             file: 'scripts/test/integration/dexie-v10-wipe.mjs',             category: 'integration' },
  { name: 'repertoire-practice',        file: 'scripts/test/integration/repertoire-practice.mjs',        category: 'integration' },
  { name: 'repertoire-bulk-add-stamp',  file: 'scripts/test/integration/repertoire-bulk-add-stamp.mjs',  category: 'integration' },
  { name: 'backup',                     file: 'scripts/test/integration/backup.mjs',                     category: 'integration' },
  { name: 'phase2',                     file: 'scripts/test/integration/phase2.mjs',                     category: 'integration' },
  { name: 'auto-import',                file: 'scripts/test/integration/auto-import.mjs',                category: 'integration' },
  { name: 'live-chesscom',              file: 'scripts/test/live/live-chesscom.mjs',                     category: 'live' },

  // --- UI / review page -------------------------------------------
  { name: 'review-ui',                  file: 'scripts/test/e2e/review-ui.mjs',                          category: 'e2e' },
  { name: 'review-screenshot',          file: 'scripts/test/e2e/review-screenshot.mjs',                  category: 'e2e' },
  { name: 'exploration',                file: 'scripts/test/e2e/exploration.mjs',                        category: 'e2e' },
  { name: 'exploration-classification', file: 'scripts/test/e2e/exploration-classification.mjs',         category: 'e2e' },
  { name: 'knight-arrow-toggle',        file: 'scripts/test/e2e/knight-arrow-toggle.mjs',                category: 'e2e' },
  { name: 'mobile-audit',               file: 'scripts/test/e2e/mobile-audit.mjs',                       category: 'e2e' },
  { name: 'mobile-review',              file: 'scripts/test/e2e/mobile-review.mjs',                      category: 'e2e' },
  { name: 'touch-longpress-arrow',      file: 'scripts/test/e2e/touch-longpress-arrow.mjs',              category: 'e2e' },
];

export const CATEGORIES = ['unit', 'integration', 'e2e', 'live'];

export function pickBrowserTests(category) {
  return BROWSER_TESTS.filter((t) => t.category === category);
}
