# Testing

Four tiers, cheapest first. `scripts/test/manifest.mjs` is the single catalog of
every browser-driven test; `scripts/run-tests.mjs` reads it.

```bash
npm test                  # unit + integration (the default gate)
npm run test:unit         # vitest only — pure logic, no browser
npm run test:integration  # browser, synthetic data, deterministic
npm run test:e2e          # browser, drives the real UI
npm run test:live         # hits the live Chess.com API — slow, flaky, on demand
npm run test:all          # everything including live
npm run typecheck         # tsc -b --noEmit
```

Single browser test by manifest name, and fail-fast:

```bash
node scripts/run-tests.mjs --only=eval-cache
node scripts/run-tests.mjs --bail
```

## Running the browser tiers

**A dev server must already be up. The runner does not start one** — it pings
`http://localhost:5173/` once up front and exits 1 with
`Cannot reach dev server at …` if nothing answers. Override the target with
`URL=http://localhost:5174/` (note a few scripts hard-code :5173, so a
non-default port is not universally honoured). Live tests take `USER_CC=` for
the Chess.com username. One-time: `npx playwright install chromium`.

`npm run dev` needs the three auth env vars or the app throws at module load.
With no `.env.local`, pass structurally-valid fakes — the Clerk key must decode,
or `ClerkProvider` throws and error-boundaries the whole router:

```bash
VITE_CLERK_PUBLISHABLE_KEY=pk_test_bG9jYWwuY2xlcmsuYWNjb3VudHMuZGV2JA== \
VITE_SUPABASE_URL=https://local.invalid \
VITE_SUPABASE_ANON_KEY=sb_publishable_local_verify \
VITE_E2E_AUTH_BYPASS=true npx vite --port 5173 --strictPort
```

Two things to know about that command. `npx vite` skips npm lifecycle scripts,
so it does not stage the NNUE network — run `npm run nnue:stage` first if the
test cares about the evaluator. And the placeholder key's Clerk host does not
exist, so every page logs a couple of `ERR_CONNECTION_REFUSED` console errors
for `clerk.*/clerk.browser.js`; the harness reports them as "non-fatal page
logs".

Auth is bypassed with the `e2e_auth_bypass=1` query flag
(`src/lib/testAuth.ts`); `appendBypass()` adds it to a URL you build yourself,
and `runBrowserTest` injects it into the initial navigation. The bypass is
**dev-only** (`import.meta.env.MODE !== 'development'` disables it), so a
production build cannot be driven this way — verifying `dist/` end-to-end needs
real Clerk credentials. The bypass also stubs Supabase: it answers every table
in `CLOUD_SYNC_TABLES` as empty rather than throwing, because cloud sync is
mounted in `AppLayout` and therefore runs in every browser test. **A new cloud
table must be added to that set.**

The harness launches an ephemeral Chromium context, so a test that calls
`db.*.clear()` cannot touch your real browser data. It also means no disk cache:
each context re-fetches the 40 MB NNUE network if the engine wants it.

## Tiers

**unit** (`src/**/*.test.ts`, vitest, `environment: 'node'`)
Pure logic. These must NOT import anything touching Dexie, IndexedDB, Web
Workers, chessground, or Stockfish — see the conventions comment in
`vitest.config.ts`. Anything that does belongs in the browser tiers. Guards
worth knowing before you touch their area:

| test | pins |
|---|---|
| `src/data/openings.generated.test.ts` | The openings coherence guard: rebuilds the bundle from the committed TSVs and fails if the committed file differs. **Fix: `npm run openings:build`**, never a hand edit. |
| `src/data/puzzles.corpus.test.ts` | The shipped puzzle shards against the manifest, and replays solution lines so an off-by-one-ply corpus cannot ship. `PUZZLE_CORPUS_FULL=1` walks all 191,250 instead of a 1-in-20 sample (~78 s vs ~4 s). |
| `src/features/puzzles/motifThemes.test.ts` | Every mapped Lichess theme still exists in the corpus vocabulary — the guard for a corpus refresh. |
| `src/features/sync/diff.test.ts` | The sync conflict rules, including that the attempt merge is commutative and idempotent and that a pushed row round-trips as a fixed point. |
| `src/features/openings/difficulty.test.ts` | Tier scoring as properties (exposure lowers a tier, rarity raises one, tiers are family-relative) — never constant assertions on the weights. |
| `src/features/repertoire/pickerModel.test.ts` | The repertoire ∪ library merge, including the "leaf extends a library variation" match. |
| `src/i18n/parity.test.ts` | Every locale carries exactly the English key set (keys aren't typed and `fallbackLng` hides omissions, so this is the only backstop). |

**integration** (`scripts/test/integration/`)
Real browser stack — Stockfish, IndexedDB, the analysis queue — driven with
synthetic data so results are deterministic. This is where engine pool, queue,
cache, migration, backfill and cloud-sync behaviour is pinned. `recompute-skip`
pins the boot-pass version gates (including that an empty DB must not stamp);
`cloud-sync` pins the three ordering rules in ARCHITECTURE.md § Cloud sync;
`puzzle-library` is the worked example of seeding synthetic analyses safely.

**e2e** (`scripts/test/e2e/`)
Drives the actual UI: clicks, boards, navigation.

**live** (`scripts/test/live/`)
Depends on the live Chess.com API. Excluded from `npm test` on purpose; runs
daily in `live.yml` with `continue-on-error` so a Chess.com outage never blocks
a PR.

CI (`.github/workflows/ci.yml`, Node 20) runs typecheck → `npm run build` →
unit → integration, then e2e as a second job. The live tier is not in CI.

## Adding a browser test

1. Drop a file in `scripts/test/<category>/<name>.mjs` and use `runBrowserTest()`
   from `scripts/test/harness.mjs` so browser launch, console wiring, assertions
   and polling stay shared.
2. Add an entry to `scripts/test/manifest.mjs`. **A script that is not in the
   manifest never runs** — `scripts/test/integration/extension.mjs` is currently
   in exactly that state.
3. Mention it here under the right feature area.

The harness's `expect()` is deliberately minimal: `toBe`, `toEqual`,
`toBeTruthy`, `toBeFalsy`, `toBeAtLeast`, `toBeAtMost`. There is no `toContain` /
`toBeGreaterThan` — assert on a boolean instead.

## Seeding synthetic analyses

`recomputeClassificationsAndAccuracies` owns `MoveEval.classification`,
`.motifs` and `.accuracy` and re-derives them from stored FENs about a second
after page load, so it will overwrite whatever you seeded. **Stamp the version
markers while `games` is empty, navigate to a fresh document, and only then
seed** — stamping after seeding does not work. See ARCHITECTURE.md § Boot-time
passes for why, and `scripts/test/integration/puzzle-library.mjs` for the
working sequence:

```js
const { updateSettings } = await import('/src/db/schema.ts');
const q = await import('/src/db/queries.ts');
await updateSettings({
  lastRecomputeVersion: q.RECOMPUTE_VERSION,
  lastOpeningRefreshVersion: q.OPENING_REFRESH_VERSION,
  lastUserTimeBackfillVersion: q.USER_TIME_BACKFILL_VERSION,
  lastBrilliantBackfillVersion: q.BRILLIANT_BACKFILL_VERSION,
});
```

Keep an explicit assertion that the seeded motifs survived, so a regression
names its own cause instead of surfacing as a confusing empty result.

## Known-failing

Treat any red as yours, with these exceptions:

- **`src/features/auth/useProfileSync.test.ts`** fails (collects 0 tests)
  without the three `VITE_*` auth vars, because it transitively imports
  `lib/supabase.ts` → `lib/env.ts`, which throws at module load. There is no
  committed `.env.local`; CI supplies the values from repo secrets. On a machine
  without them, this **one** failing file is expected and everything else passes.
- **`e2e/mobile-audit`** fails on some local setups with
  `Page.captureScreenshot: Unable to capture screenshot` /
  `ERR_INSUFFICIENT_RESOURCES` — Chromium runs out of resources over ~45
  full-page screenshots of WASM-heavy pages. It passes in CI (~73 s); confirm
  against CI before chasing it.

## Not covered by automation

- **Touch long-press → annotation arrow** (`Board.tsx`, `LONG_PRESS_MS`).
  Drawing an arrow by holding a finger on a square and dragging has no automated
  guard: the gesture depends on real touch timing and on the board's on-screen
  geometry, and in an emulated mobile viewport the board can render partly above
  the fold, so a synthesized sequence lands nowhere useful and reports a failure
  that says nothing about the feature. Check it by hand on a real touch device
  when changing the touch handlers or the board's layout/sizing.

## Traps that produce false passes

Every one of these yields a *green* check over broken code, so a passing test
here proves nothing unless you've ruled them out.

- **A test can pass for the wrong reason.** Asserting "a board rendered" or
  "some element exists" stays green when the feature is broken and the page
  merely fell back to something else. Assert on the *identity* of what you
  expect — this line, this variation, this count — not on the existence of a
  generic element. **Prove a new assertion by breaking the code on purpose and
  watching it fail** (revert the fix, run the test, restore); an assertion never
  observed failing is not yet a guard.

- **`classifyMove` re-derives, it does not trust stored values.** The recompute
  pass recomputes every classification, so a fixture asserting on a stored
  `classification` proves nothing. It also short-circuits to `'book'` when both
  sides of a move are in the openings library, which silently defeats a
  `brilliant` fixture built from a mainline position. Use a verified non-book
  position (see `brilliant-backfill.mjs`).

- **The eval cache makes repeat analysis near-instant.** Tests that need an
  analysis to still be in flight must use uncached positions. The cache key
  includes the evaluator, so switching NNUE on or off is also a cache miss.

- **Small fixtures hide superlinear costs.** A 300-game fixture can show a 2×
  page-nav regression that is 27× at 2 500 games. Size perf fixtures to the top
  of the realistic range.

- **Hand-written PGNs.** An illegal move makes every game error for the wrong
  reason and looks like a queue bug. Generate long fixtures with chess.js
  (`await import('/node_modules/chess.js/dist/esm/chess.js')` inside
  `page.evaluate`).

- **Headless Chromium overlays scrollbars.** It renders no scrollbar gutter at
  all, even with `--disable-features=OverlayScrollbar`, so a mis-styled page
  scrollbar is invisible to a screenshot check while being obvious in a real
  browser. Verify native-chrome styling via computed style and by grepping the
  built CSS, and say plainly when only a human can confirm.

- **`ERR_CONNECTION_REFUSED` in a browser-tier failure is the dev server, not
  your code.** Check the server is still up before reading anything into the
  assertion that failed.
