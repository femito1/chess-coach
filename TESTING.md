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
| `src/engine/nnue.test.ts` | `resolveNetLocation()`: where the 38.3 MiB net is fetched from, and that a malformed `VITE_NNUE_NET_URL` falls back rather than throwing. Both failure modes are silent (every eval quietly goes classical), so the URL shapes are pinned here rather than in the browser tier. |
| `src/features/sync/diff.test.ts` | The sync conflict rules, including that the attempt merge is commutative and idempotent and that a pushed row round-trips as a fixed point. |
| `src/features/openings/difficulty.test.ts` | Tier scoring as properties (exposure lowers a tier, rarity raises one, tiers are family-relative) — never constant assertions on the weights. |
| `src/features/repertoire/pickerModel.test.ts` | The repertoire ∪ library merge, including the "leaf extends a library variation" match. |
| `src/app/routeHeaders.test.ts` | Every route in `routes.tsx` has a `no-store` entry in `public/_headers`. Guards the enumeration a wildcard can't replace — without it, a new route silently serves a cacheable document and deploys stop taking effect on a normal reload there. |
| `src/i18n/parity.test.ts` | Every locale carries exactly the English key set (keys aren't typed and `fallbackLng` hides omissions, so this is the only backstop). |

**integration** (`scripts/test/integration/`)
Real browser stack — Stockfish, IndexedDB, the analysis queue — driven with
synthetic data so results are deterministic. This is where engine pool, queue,
cache, migration, backfill and cloud-sync behaviour is pinned. `recompute-skip`
pins the boot-pass version gates (including that an empty DB must not stamp);
`cloud-sync` pins the three ordering rules in ARCHITECTURE.md § Cloud sync;
`puzzle-library` is the worked example of seeding synthetic analyses safely.

`sync-coalescing` pins that a sync request is never silently dropped — concurrent
triggers still coalesce onto one pass, but a request arriving on an already-aborted
pass queues behind it rather than adopting it, and the manual button always
produces a pass. It counts passes rather than comparing promise identity, because
`startSync` is `async` and so always returns a fresh wrapper; identity was never
the contract.

`analysis-priority` pins demand-driven queueing: that the game you are viewing is
analyzed ahead of newer pending ones, that re-requesting the in-flight game does
*not* abort it (which would livelock the review page), and that a preempted game
returns to `pending` rather than `error`. It drives the queue's own chooser through
a test seam rather than reimplementing "priority first, else newest" — a
hand-rolled copy would pass even if the pump ignored priority entirely.

`chart-opening-links` pins that a win-rate chart row keeps its library link when
the two opening datasets disagree on the *name* rather than the punctuation
(Chess.com's "King's Fianchetto Opening" vs the bundled "Hungarian Opening"). It
asserts the precondition first — that the name really is unresolvable — so the
test cannot quietly stop exercising the move-based fallback if
`resolveOpeningFamily` ever learns to bridge that pair, and it asserts the
link's *target*, since a link to the wrong family looks fine and selects
nothing.

`storage-durability` pins that the app asks the browser to keep its data. It
instruments `navigator.storage` through an init script *before* the app's own
scripts run, and asserts `persisted()` was consulted exactly once — asserting
that the Settings card renders would pass over a `persist()` call that never
happens, which is the bug that existed for the app's whole life. Headless
Chromium has no engagement signal and so normally refuses the grant; the card
must be truthful either way, which is what the wording assertions check.

`prep-gaps` pins the dashboard's prep-gap card end to end. Its seeded games
carry the hyphen-less `opening` string that `parseOpeningFromEcoUrl` really
emits ("Caro Kann Defense Advance Variation: 4.Nf3"), so the assertion that the
row reads "Caro-**K**ann" is what proves the label was resolved from the game's
*moves* rather than echoed from that string — the card would look correct in a
screenshot either way. The other load-bearing assertion is that adding the
variation to a repertoire retires the row with no reload: that is the difference
between reading the repertoire tree and merely checking whether a family
repertoire exists, which is the behaviour the feature was specified on.

`nnue-remote-net` pins the production NNUE deployment: it starts its own HTTP
server on an ephemeral port to play the part of the object store, with CORS and
CORP separately switchable, and asserts that the app loads the net cross-origin
with CORS alone and degrades to a correctly-labelled classical fallback without
it. **Read the worked example under § Traps that produce false passes before
touching it** — it is the clearest case in the suite of an assertion set that
looks thorough and proves nothing.

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
   manifest never runs.** The one deliberate exception is documented under
   § Run on demand below; anything else missing from the manifest is a mistake.
3. Mention it here under the right feature area.

The harness's `expect()` is deliberately minimal: `toBe`, `toEqual`,
`toBeTruthy`, `toBeFalsy`, `toBeAtLeast`, `toBeAtMost`. There is no `toContain` /
`toBeGreaterThan` — assert on a boolean instead.

## Seeding synthetic analyses

`recomputeClassificationsAndAccuracies` owns `MoveEval.classification`,
`.motifs` and `.accuracy` and re-derives them from stored FENs shortly after
page load, so it will overwrite whatever you seeded. **Stamp the version
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
- **`integration/puzzle-library`** is intermittent and predates any current
  work. It fails as `matched-to summary shown: expected true, got false`, with
  the log line above it reading `recommended chips: []` where a pass reads
  `["Walked into a fork…", …]` — so the flake is in the weakness-motif
  recommendation seeding, not in the puzzle rendering the test spends most of
  its assertions on. Re-run it in isolation before investigating; it usually
  passes there. Not root-caused.
- **`integration/cloud-sync`** was seen to fail once on CI (2026-09-01, run
  33500377379) as `game row byte-identical after round trip: expected true, got
  false`. Evidence that it is intermittent rather than a real regression: the
  same commit passed 11/11 locally and the failed job passed on a re-run with no
  code change. Note the test runs against an **in-page fake** Supabase, so real
  credentials and real cloud rows are not involved and the local/CI difference
  is unexplained — if you see this twice, it is worth chasing rather than
  re-running. One thing not yet ruled out: CI supplies real auth env from repo
  secrets, so the app's own `useCloudSync` is live in the page in a way it
  cannot be locally against `https://local.invalid`.
- **`waitUntil: 'networkidle'` is not a safe contract on the review or dashboard
  pages.** They start the engine pool, and each worker fetches the 38 MB NNUE
  net — Playwright contexts are throwaway and have no disk cache, so every one
  pays in full. `e2e/exploration-classification` timed out there at 40 s in CI
  (30 s `page.goto` budget) while passing locally in 16 s, and passed on a
  re-run with no code change; it now navigates with `domcontentloaded` and waits
  for the move list to be interactive instead. Several other e2e scripts still
  use `networkidle` and pass today — if one starts timing out in `page.goto`,
  this is the reason, and the fix is to wait for a UI signal rather than for the
  network to go quiet.
- **`e2e/mobile-audit`** fails on some local setups with
  `Page.captureScreenshot: Unable to capture screenshot` /
  `ERR_INSUFFICIENT_RESOURCES` — Chromium runs out of resources over ~45
  full-page screenshots of WASM-heavy pages. It passes in CI (~73 s); confirm
  against CI before chasing it.

## Run on demand

**`scripts/test/integration/extension.mjs`** — the Chrome extension smoke test.
Deliberately absent from `manifest.mjs`, so `npm test` never runs it: Chrome
extensions need a real browser head
(`chromium.launchPersistentContext({ headless: false })`), which CI does not
have. It does *not* need `npm run dev` — it builds the deep link without
following it.

```bash
node scripts/test/integration/extension.mjs
```

Run it whenever `extension/` changes. It covers the auto-prompt rules that are
easy to regress: an in-progress game at a numeric URL must NOT prompt, while
both old game-over and current game-result markup must; plus SPA navigation,
dismissal, the manual fallback and the deep-link shape.

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

  *Worked example — `nnue-remote-net`.* Its job is "the browser can load the NNUE
  net from another origin". The obvious assertions are the ones `engine-nnue`
  uses: after pointing the app at a foreign origin, does `evaluatorId()` read
  `stockfish-16-nnue`, does Stockfish print `NNUE evaluation enabled`, does the
  rook endgame come out at +377 rather than +53? All three pass **whether or not
  the cross-origin URL was used at all**, because dev also stages the net at
  `public/stockfish/`, so a bare-filename `EvalFile` finds a net next to the
  worker script on the app's own origin. Confirmed by reverting the `engine.ts`
  change the test exists to protect and watching it stay green.

  The fix was to stop asking the app and ask the server: the fake object store
  logs every request, and the test asserts it saw the engine's 38 MiB `GET`, not
  just the probe's `HEAD`. Reverted, the log reads `["HEAD … → 200"]` and the
  assertion fires naming the cause.

  Generalised: **when a test asserts a resource came from a new place, some
  assertion must be impossible to satisfy from the old place.** Evaluator ids,
  console strings and even eval numbers were all reachable from the fallback
  path; only the foreign server's access log was not. Same reason `engine-nnue`
  compares classical against NNUE numbers (no net loaded ⇒ two identical
  numbers), and `diff.test.ts` asserts a pushed row round-trips as a *fixed
  point* rather than that the push merely happened.

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
