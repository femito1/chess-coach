# Architecture notes

Load-bearing invariants: the rules this codebase breaks quietly rather than
loudly if you violate them, and enough reasoning to know when a change is about
to violate one. Read the relevant entry before touching its area; the code
comments at each site are the detailed version, this is the map.

Contents: [Data model](#data-model) ·
[Boot-time passes](#boot-time-passes-and-version-stamps) · [Engine](#engine) ·
[NNUE](#nnue) · [Puzzles](#puzzles) · [Openings](#openings) ·
[Openings data refresh](#openings-data-refresh) · [Cloud sync](#cloud-sync) ·
[Off-laptop analysis worker](#off-laptop-analysis-worker) ·
[UI conventions](#ui-conventions) · [Deployment](#deployment)

## Data model

Everything is client-side: Dexie over IndexedDB (`src/db/schema.ts`, DB name
`chess-coach`), no application server. **Current schema version: 12.**

| table | key | holds |
|---|---|---|
| `games` | `id` | Game metadata + PGN, plus denormalized fields (below). |
| `analyses` | `gameId` | Per-move evals, classifications, motifs. |
| `puzzleAttempts` | `puzzleId` | Progress against the Lichess corpus (v12). |
| `repertoires` / `repertoireNodes` / `repertoireCards` / `repertoireLineStats` | `id` | Repertoire trees, SM-2 cards, per-line practice stats. |
| `evalCache` | `key` | Stockfish results, keyed by position **and evaluator**. |
| `importRecords` | `id` | Which Chess.com archives have been imported. |
| `settings` | `key` (always `main`) | Single row: username, boot-pass stamps, prefs. |
| `puzzles`, `notes` | `id` / `fenKey` | **Dead stores.** Nothing in `src/` reads or writes them. |

Two schema rules:

- **A version bump is only needed to change stores or indexes.** Adding a field
  to `Settings` or `Game` needs no bump — many current fields shipped without
  one, `Game.requeuedAt` most recently. Bump only for a new store, a new index,
  or an `upgrade()` hook. (`v11` bumped for an optional `Settings` field anyway,
  purely so the addition showed up in the schema history. Don't read that as the
  rule; it isn't.)
- **Never drop a store to tidy up.** Dexie destroys its rows irreversibly. The
  two dead stores above are kept for exactly that reason. `v10` is the worked
  example of a deliberate wipe: its `upgrade()` clears the four repertoire
  tables and nothing else.

**`games` carries denormalized fields derived from `analyses`.** Move
classifications live in `analyses`, keyed by game id. The Games table and
dashboard must not read that table per render — a 1 k-game library is ~2 MB of
PGN and per-move data. So these are cached on the `Game` row:

| field | written by |
|---|---|
| `accuracy` | queue on analysis · recompute pass |
| `userTimeSec` / `userPlyCount` | queue on analysis · `backfillUserTimeStats` |
| `brilliantCount` | queue on analysis · recompute pass · `backfillBrilliantCounts` |

Adding another cached field means touching all of its writers, plus a backfill
for already-analyzed games. Distinguish `undefined` ("never computed") from `0`
("computed, found none") — that difference is what makes a backfill idempotent
and a UI badge trustworthy.

**Read projections.** `listGamesLight()` strips `pgn`; `AnalysisLight` strips
`moves`. Pages over the `games` table should use them, plus
`useThrottledLiveQuery` — an un-throttled `useLiveQuery` refires on every
analyzer write, which both re-renders and busts downstream `useMemo`s.

## Boot-time passes and version stamps

`startAnalysisQueue()` (`src/engine/queue.ts`) runs housekeeping on
`AppLayout` mount, once per document. Each pass is wrapped in `bootStep()` so
one failure logs and continues, and each yields to the browser between chunks
of 60 games.

| order | pass | gate | constant (value) |
|---|---|---|---|
| 1 | `resetRunningToPending()` — **awaited, blocking**; recovers games left `running` by an unclean unload | every boot | — |
| 2 | `requeueStaleErrors()` — requeues games whose `analysisError` matches a known-transient pattern | every boot | — |
| 3 | `refreshOpeningMetadata()` — re-parses `opening`/`eco` from PGN | `lastOpeningRefreshVersion` | `OPENING_REFRESH_VERSION` (1) |
| 4 | `recomputeClassificationsAndAccuracies()` | `lastRecomputeVersion` | `RECOMPUTE_VERSION` (2) |
| 5 | `backfillUserTimeStats()` | `lastUserTimeBackfillVersion` | `USER_TIME_BACKFILL_VERSION` (1) |
| 6 | `backfillBrilliantCounts()` | `lastBrilliantBackfillVersion` | `BRILLIANT_BACKFILL_VERSION` (1) |
| 7 | `backfillRecomputeVersion()` — copies the DB-wide recompute stamp onto rows that predate `Analysis.recomputeVersion` | `lastRecomputeStampBackfillVersion` | `RECOMPUTE_STAMP_BACKFILL_VERSION` (1) |

The analyzer run loop starts *before* passes 2-6, so a fresh import is never
held up by housekeeping. `BootBanner` only renders if the passes are still
running 400 ms in, so a warm boot shows nothing.

**Never bump `RECOMPUTE_VERSION` just to stamp a new field.** Pass 4 re-runs
`classifyMove` + `detectMotifs` + `detectPhase` over every move of every
analyzed game and rewrites `analyses`. That is seconds-to-minutes of blocking
main-thread work; bumping it to add a cheap counter froze the app on reload. A
field derivable from data already in `analyses` gets its own pass with its own
stamp — `backfillBrilliantCounts` (~10 ms for 40 games) is the worked example.
The expensive pass may *refresh* such a field as a rider, but must never be the
reason it runs.

**The pass is resumable, and has to be.** It stamps `lastRecomputeVersion` only
after walking the *whole* library, so for a large library a reload part-way
through used to start again at the first game. That is a trap with teeth: the
pass takes minutes on a couple of thousand games and blocks the main thread
between chunks, so the app looks frozen, and the natural response — reload —
was precisely what guaranteed it could never finish. One user sat through
20–30 minutes of it after a cloud restore.

So each chunk now writes `recomputeCursor` / `recomputeCursorVersion` to
settings, and a run resumes after the cursor instead of from zero; a reload
costs at most one chunk of redone work. Three rules the cursor carries, all
pinned in `recompute-skip.mjs` phases 6–8:

- **It is only honoured for the version that wrote it.** After a rules change
  the old prefix was classified under the old rules and must be redone — which
  is the entire point of the bump. `force` ignores it for the same reason.
- **A completed run clears it**, or the next version bump would resume from a
  stale point and skip everything before it.
- **`doneIds` is sorted** so "everything up to the cursor" is a well-defined
  prefix. `primaryKeys()` off an index is already ordered, but the resume
  contract should not rest on that staying true.

A game imported *after* a partial run that sorts before the cursor is skipped —
but that was already true without resumption, because `doneIds` is snapshotted
at the start and the completion stamp suppresses later boots. Freshly analyzed
games get their classification from the analyzer; this pass exists only to
re-derive *old* rows under new rules.

**The pass skips rows that are already current, which is what makes a restore
cheap.** `Analysis.recomputeVersion` records the rules vintage of a row's
derived fields, and the pass reprocesses only rows below the current version.
This matters because the mirror stores whole `Analysis` blobs: pulled rows
already carry correct `classification` / `motifs` / `accuracy`, yet an evicted
device loses its settings row too, so the DB-wide stamp is gone and without the
per-row check the pass re-derived a library that was already right — minutes of
blocked main thread for no change at all.

Three parts make that work, and all three are needed:

- **`saveAnalysis` stamps.** The analyzer runs the same `classifyMove` /
  `detectMotifs` / `detectPhase`, so its output is current by construction.
  Cloud *pulls* write `db.analyses` directly and must never stamp — they carry
  whatever vintage the producing device recorded.
- **The pass stamps even when nothing changed.** A restored row recomputes to
  identical values, so a changed-only write would leave every one of them
  unstamped and the next restore would redo the library again. Recording "these
  rules have been applied" is the point, not the diff.
- **`recompute_version` is a decision column on `cloud_analyses`**, ranked in
  `isBetter` below evaluator and depth and *above* recency. Rewriting derived
  fields deliberately leaves `analyzedAt` alone, so recency cannot see the
  difference; without that rung a stamped local row and an un-stamped cloud row
  tie forever, the cloud keeps rows of unknown vintage, and every restore pays
  full price. Pinned in `diff.test.ts` — including that a stamped row
  round-trips as a *fixed point*, because a dropped column would re-push the
  entire library on every sync.

`backfillRecomputeVersion` (boot pass 7) exists for libraries that predate the
field: a DB carrying `lastRecomputeVersion` has already been through that pass,
so the claim can simply be copied onto its rows — one write per 60 rows and no
classification. It claims nothing when there is no DB-wide stamp, since there
would be no basis for it.

**Version gates compare `>=`, not `===`.** A rolled-back version would
otherwise re-trigger the expensive pass on every DB that briefly saw the higher
number — re-freezing exactly the users a rollback is meant to rescue. A DB
carrying a newer stamp has already been through at least as new a rule set.
Pinned by `recompute-skip.mjs` phase 5.

**A pass that found nothing to do must not stamp.** Otherwise a first boot on
an empty DB marks the work done and the pass never runs on the data that
arrives afterwards. All of passes 3-7 hold this now; `backfillBrilliantCounts`
used to stamp unconditionally, which cloud restore turned from a latent bug into
a live one — a wiped device boots empty, stamps, and then never counts
brilliancies on the library that arrives seconds later.

**The recompute pass OWNS `MoveEval.classification`, `.motifs`, `.accuracy`.**
It re-derives them from each move's *stored FENs* on every boot where the stamp
is behind — it is not a one-time backfill. Consequences:

- A test or script that seeds synthetic `analyses` rows will have its motifs
  overwritten (placeholder FENs reclassify to something else, and a move that
  reclassifies as good has `motifs` set to `undefined` outright). The symptom is
  a UI that renders correctly and goes empty a moment later, which reads like a
  race in your own code.
- The fix is to stamp the version markers **while `games` is empty**, then
  navigate to a fresh document, and only then seed. Stamping after seeding does
  not work: the pass reads settings at mount and then walks whatever appears in
  `games`. `scripts/test/integration/puzzle-library.mjs` is the live example,
  and it keeps an explicit assertion that the seeded motifs survived so a
  regression names its own cause.
- A fixture must never assert on a stored `classification` as though it were
  input data.

## Engine

`EngineWorker` (`src/engine/engine.ts`) wraps one Stockfish WASM worker;
`EnginePool` runs several. The singleton `engine` export is for single-position
consumers (live eval) and is refcounted by `useLiveEval`; `analysisPool()` is
for whole-game analysis. Free-play uses its own separate worker so the opponent
search doesn't fight live eval.

**Pool slots are released by worker identity, never by captured index.**
`setMaxWorkers()` splices `workers`/`busy` (the visibility throttle calls it
when the tab hides), which renumbers every worker above a removed slot. A task
holding an index across a shrink therefore clears the wrong slot — or one past
the end of the array — stranding its own slot as permanently busy. That leaks a
worker, pins `isIdle()` false so the WASM heap is never freed, and eventually
has `pump()` call `.analyze()` on `undefined`, which surfaces as a game erroring
for no visible reason. Pinned by `pool-shrink-desync.mjs`.

**`cancelAnalysis()` on the shared singleton kills whatever is running, whoever
started it.** `useLiveEval` only calls it once its consumer refcount hits zero,
so one idle consumer can't kill another's search.

**Pausing the queue does not abort the in-flight game.** The `paused` check
sits at the top of the run loop, so the current analysis finishes and only the
*next* game is withheld. The store still reports `running: true` with a
`currentGameId` while paused.

**A cloud analysis for a game this device never analyzed must still pull.** The
requeue guard in `diffAnalyses` originally suppressed any pull while the local game
was `pending` or `running`, because `requeueGame` deletes the local analysis and
sets `pending` — and pulling would undo that. That was sound while every writer
analyzed its own games. The off-laptop worker broke it completely: a
never-analyzed game is *also* `pending`, and once a server analyzes games the
laptop never touched that is the normal case. Observed in production — 1 785 games
analyzed at depth 18 in the cloud, all `pending` locally, **zero** analyses pulled,
while the laptop re-analyzed the whole library. `Game.requeuedAt` is the
discriminator: no stamp means nothing to protect, a stamp older than the remote
analysis means someone did the work better elsewhere.

**Pulling an analysis also settles the game row.** Writing the analysis alone left
`analysisStatus: 'pending'`, so the local queue re-analyzed a game whose analysis
had just arrived and clobbered depth-18 NNUE with a shallower local pass — which
the next sync then pulled back. `accuracy` and `brilliantCount` are recomputed from
the pulled analysis because `cloud_games` is only fetched when the *game* is a pull
candidate, which it usually isn't. Both halves pinned separately by
`cloud-sync.mjs` § 5b.

**Opening a review preempts the queue.** `requestAnalysisNow(gameId)` in
`queue.ts` puts a game at the front and aborts whatever is running; the review
page calls it whenever it lands on a game with no analysis row. Without it the
queue is strictly newest-first (`nextPendingGame` walks `endTime` in reverse), so
opening an *older* unanalyzed game means waiting behind every newer pending one —
minutes after a fresh import, for a review that takes ~10 s on its own.

Preempting is nearly free, and that is the whole reason it is allowed:
`cachedAnalyze` persists each finished position to `evalCache` as it completes, so
an abandoned game keeps its evaluated positions and resumes from them later. The
loss is one position per worker.

Two invariants that are easy to break:

- **Re-requesting the in-flight game must be a no-op.** The review page's effect
  re-runs on re-render; if that preempted the game it is waiting for, the analysis
  would abort and restart forever and never finish. `requestAnalysisNow` checks
  `inFlight?.gameId` *before* it aborts anything.
- **A preempted game goes back to `pending`, never `error`.** `analyzeGamePgn`
  throws `aborted` when its signal trips, and the queue's catch would otherwise
  record a scary "analysis failed" on a game we cancelled deliberately —
  which `requeueStaleErrors` would then have to undo.

Both pinned by `analysis-priority.mjs`.

**Worker count is a per-device setting, not a smarter heuristic.** Measured on a
12-core / 7.7 GB laptop, one 59-ply game at depth 18 NNUE through the real
analyzer: **4 workers 11.2 s, 6 workers 7.7 s, 8 workers ~122 s** — the last
because it starts swapping. The curve has a cliff, and where the cliff sits
depends on *free* memory, which the browser will not report:
`navigator.deviceMemory` gives total memory rounded to a power of two and capped
at 8. So `defaultPoolSize()` stays conservative and
`preferredWorkerCount()` (localStorage, like the NNUE toggle) lets a human who
knows their machine take the 31%. `effectivePoolSize()` is the one answer both the
pool and the Settings UI read.

**The single-threaded fallback is an 11× cliff, so it is surfaced.** Measured on
the same game at depth 18: `stockfish-nnue-16.js` 9.7 s versus
`stockfish-nnue-16-single.js` 110 s. The threaded build needs `SharedArrayBuffer`,
which needs cross-origin isolation, so anything that strips COOP/COEP silently
makes analysis eleven times slower — which users experience as "the app is
broken" with nothing saying why. `activeEngineBuild()` records which build booted,
`canUseThreadedEngine()` answers before one has, and Settings shows a warning.
`vite.config.ts` sets the headers on the **preview** server too, so
`npm run preview` doesn't misrepresent production.

**`analyzeGamePgn` takes an injectable `EngineBackend`** (`src/engine/analyzer.ts`)
so the same analysis code runs under Node for the off-laptop worker. The browser
default backend is resolved by **dynamic** import:

```ts
const [cache, pool] = await Promise.all([import('./cache'), import('./pool')]);
```

Do not turn those into static imports. `./pool` reaches `./engine`, which calls
`new Worker` and reads `import.meta.env.BASE_URL`; `./cache` reaches
`@/db/schema`, which imports Dexie. Either one makes `analyzer.ts` unloadable
in Node and breaks the worker.

### NNUE

NNUE is **on by default** in the browser, and the difference is not cosmetic:
classical and NNUE agree on forced tactics but diverge badly in quiet and
endgame positions — which is where a coaching app draws its conclusions.

| piece | where |
|---|---|
| Net filename, toggle, `nnueActive()`, `nnueNetAvailable()`, `resolveNetLocation()` | `src/engine/nnue.ts` |
| Staging the net into `public/stockfish/` | `scripts/copy-nnue.mjs` (`prebuild`, `predev`, `npm run nnue:stage`) |
| Standing up the R2 bucket end to end via `wrangler` | `scripts/setup-r2-nnue.mjs` (`npm run nnue:setup`) |
| Uploading the net + verifying the browser can load it | `scripts/upload-nnue.mjs` (`npm run nnue:upload`) |
| Last-resort check that no over-cap net reaches `dist/` | `nnueNetBuildGuard` in `vite.config.ts` |
| Build-side "which net, served from where" — shared by all of the above | `scripts/nnue-net-config.mjs` |
| Evaluator ids | `NNUE_EVALUATOR_ID = 'stockfish-16-nnue'`, `CLASSICAL_EVALUATOR_ID = 'stockfish-16-classical'` |

**The 40 MB net is gitignored and staged at build time.** It ships inside the
`stockfish` npm package, so `npm ci` always supplies it; committing it would add
40 MB to every clone forever. `copy-nnue.mjs` parses `NNUE_NET_FILE` out of
`src/engine/nnue.ts` rather than repeating it, and **exits non-zero if the
installed package ships a different net** — otherwise a Stockfish upgrade would
leave the app asking for a file nobody copies and every eval would quietly go
classical. Starting Vite directly (`npx vite`) skips npm lifecycle scripts and
therefore skips staging.

**The net is served from two different places, decided at build time by
`VITE_NNUE_NET_URL`.** Cloudflare Pages caps a single asset at 25 MiB and the net
is 38.3 MiB (40,119,326 bytes), so production cannot serve it from the app's own
origin at all:

| `VITE_NNUE_NET_URL` | where the net comes from | `EvalFile` value |
|---|---|---|
| unset (dev default) | `public/stockfish/`, staged by `copy-nnue.mjs` | bare filename |
| set (production) | that URL + the net filename | absolute URL |

The production value lives in a **committed `.env.production`**, not in the Pages
dashboard: it is not a secret (every `VITE_*` is inlined into the client bundle),
`wrangler pages` has no build-variable command anyway, and a committed file is
reviewable and picked up by CI. A real environment variable still outranks it, so
per-environment overrides remain possible.

**Vite's mode is load-bearing here.** `.env.production` is read for `vite build`
and *not* for `npm run dev`, which is what keeps dev on the locally staged net —
offline-capable and free. Every build-side consumer therefore takes an explicit
mode (`predev` → `development`, `prebuild` → `production`, and the Vite plugin gets
Vite's own `mode`). Get it wrong in one direction and dev pulls 38.3 MiB per engine
start; wrong in the other and a production build ships an over-cap asset.
`engine-nnue` asserts dev resolves the net same-origin, so a leak goes red.

The rules live in exactly two places, and the split is deliberate:

- **runtime** — `resolveNetLocation()` in `src/engine/nnue.ts`, pure and
  unit-tested, bundled for the browser. **Forgiving**: a malformed URL logs and
  falls back to same-origin rather than throwing, because an env-var typo must not
  white-screen the app.
- **build** — `scripts/nnue-net-config.mjs`, plain JS, imported by
  `copy-nnue.mjs`, `upload-nnue.mjs` and the Vite build guard. **Fatal**: a
  malformed URL fails the build, which is what makes the runtime's forgiveness
  safe, since a typo can't reach production without passing through here.

Runtime forgiving, build time strict. They are not shared because the build side
runs in Node before Vite exists and cannot import a TS module that reaches
`@/lib/usePersistedState` — but everything build-side goes through the one module,
so `dist/` and the bundle's baked-in URL cannot disagree. That mattered
concretely: reading `process.env` alone missed `VITE_NNUE_NET_URL` set in
`.env.local` (npm doesn't load dotenv), which produced a bundle pointing at R2
while `dist/` still carried the 38.3 MiB net.

**A cross-origin net needs CORS and nothing else.** The instinct is that
`COEP: require-corp` also demands
`Cross-Origin-Resource-Policy: cross-origin` on the net's host. Measured, it does
not: both the probe and Stockfish's own download are CORS-mode requests, and a
CORS response satisfies COEP by itself — a host sending CORP but no CORS fails,
CORS but no CORP works. This is load-bearing for the deployment (it is why a plain
public R2 bucket suffices) and is pinned by
`scripts/test/integration/nnue-remote-net.mjs` across all four header
combinations. Do not "fix" it by adding CORP requirements to the docs.

Stockfish accepts an absolute URL for `EvalFile` because it loads the net through
`emscripten_fetch`, which passes the value to XHR verbatim. Measured: same
+377 cp on the rook endgame from either origin.

**A missing net is fatal, not degrading.** Stockfish 16 calls
`exit(EXIT_FAILURE)` at the first `go` if `Use NNUE` is on and the net did not
load, so analysis dies rather than getting worse. `nnueNetAvailable()` therefore
HEAD-probes the net first and requires `content-length > 1_000_000`: the size
check is the load-bearing half, because Vite's SPA fallback answers a missing
path with `index.html` at HTTP 200. On failure it warns and the handshake omits
both NNUE options, falling back to classical.

**Set `nnueEnabled` explicitly when you send the option; never infer it.** A
worker that is about to run NNUE still emits
`option name Use NNUE type check default false` during `uci`, because that reply
lands after our `setoption`. The regex that reads that line is only consulted
when NNUE was *not* requested. Infer it instead and every analysis is
mislabelled, which then makes cloud sync's conflict rule do the wrong thing.

**Handshake order** (`EngineWorker#handshake`): `uci` → `UCI_AnalyseMode true` →
`Threads 1` → `Hash 64` → *(if NNUE)* `EvalFile <nnueEvalFileValue()>` →
`Use NNUE true` → `isready`. That value is a **bare filename** in same-origin mode
— Stockfish resolves it next to the worker script, and an absolute
`/stockfish/...` path would break a non-root Vite `base` — and a **full absolute
URL** in remote mode. Never hardcode `NNUE_NET_FILE` here: a bare filename still
finds the dev-staged net, so the mistake passes every local test and only fails in
production, where no same-origin copy exists. `nnue-remote-net.mjs` catches it by
asserting the foreign host's access log shows the engine's `GET`, not just the
probe's `HEAD`.

**The eval cache key includes the evaluator.** `evalCacheRowKey()` gives NNUE
rows `${fen}|${depth}|nnue` and leaves classical on the legacy `${fen}|${depth}`
(so no migration). Without this a warm classical cache feeds NNUE-*labelled*
analyses.

**Memory, not bandwidth, is the real cost:** ~340 MB RSS per worker with NNUE
against ~125 MB classical, so a 4-worker pool goes ~0.5 GB → ~1.4 GB. Fine on
desktop, fatal on a phone. `defaultPoolSize({cores, memoryGb, nnue})` reads
`navigator.hardwareConcurrency` and `navigator.deviceMemory`, and clamps to
1 worker at ≤2 GB and 2 at ≤4 GB — **but only when NNUE is on**. iOS Safari
exposes no `deviceMemory`, so it cannot be detected there; the per-device
toggle is that device's answer. The toggle lives in localStorage
(`chess-coach:engine.nnue:v1`, default on) rather than the synced `Settings`
row precisely because it is a per-device bandwidth/memory question.

`Analysis.engine` is typed plain `string`. `isNnueAnalysis()` (in
`src/features/sync/diff.ts`) is the single reader: a substring test for
`nnue`, so absent, null or unrecognised reads as **classical**. That is the
honest default — everything analyzed before the evaluator was recorded came
from a build running `Use NNUE` off.

## Puzzles

The Puzzles page serves the **Lichess open puzzle database** (CC0), not
positions mined from the user's own games.

| fact | value |
|---|---|
| Puzzles shipped | `PUZZLE_TOTAL = 191250` |
| Shards | 50 TSV files, ~18 MB total, committed under `public/puzzles/<PUZZLE_BUILD_ID>/` |
| Manifest module | `src/data/puzzles.meta.generated.ts` (totals, per-shard ranges, `PUZZLE_THEMES` vocabulary, tier bounds) |
| Runtime loader | `src/features/puzzles/corpus.ts` |
| Rebuild | `npm run puzzles:build` → `scripts/build-puzzles.mjs` |

**Why static shards, not Dexie and not a `.ts` module.** 18 MB imported would
wreck the JS bundle, and copying it into IndexedDB would duplicate what the HTTP
cache already holds and force a migration per refresh. Only *progress* is
persisted, in `puzzleAttempts`. The loader keeps an LRU of 6 decoded shards and
de-dupes in-flight fetches; the real persistence layer is
`Cache-Control: immutable` on `/puzzles/*`, which is honest because the
directory name is a content hash of every shard body — refreshed data always
lands on new URLs.

**The `Moves[0]` trap — the single easiest way to break this.** In the Lichess
CSV, `FEN` is the position *before* the opponent plays into the puzzle. So
`Moves[0]` is **theirs** and the solver's first move is `Moves[1]`. The build
script resolves this up front: it plays `moves[0]`, stores the resulting FEN,
and ships `moves.slice(1)` as the solution. Get it backwards and every puzzle is
off by one ply — the positions still look plausible but are unsolvable.
`src/data/puzzles.corpus.test.ts` replays solution lines to catch it (note the
similarly-named `src/features/puzzles/corpus.test.ts` is a separate pure unit
test); `PUZZLE_CORPUS_FULL=1` makes it exhaustive instead of a 1-in-20 stride
sample.

**Shard row schema**: five tab-separated columns, no header —
`id`, `fen`, space-joined solution UCIs, `rating`, theme codes (fixed-width
2-char base36 indices into `PUZZLE_THEMES`). The CSV's `GameUrl` is parsed and
then **discarded**; the solver links to `https://lichess.org/training/<id>`, not
to the source game.

**Build tuning knobs** — all `export const` in `scripts/build-puzzles.mjs`, all
paths hardcoded relative to the repo root (no env vars):

| knob | value | note |
|---|---|---|
| `PER_BAND_CAP` | 8000 | Capped **per 100-point rating band** (`BAND_WIDTH`), not globally. Lichess ratings cluster near 1500, so a global top-N starves Easy and Hard. |
| `TIERS` | easy `<1300`, medium `<1900`, hard rest | `maxExclusive`; `Infinity` serializes as `null` in the manifest. |
| `MIN_NB_PLAYS` / `MIN_POPULARITY` / `MAX_RATING_DEVIATION` | 100 / 85 / 90 | The quality gate. Loosen it and the corpus grows with worse puzzles. |
| `SHARD_ROWS` | 4000 | Rows per shard. |

The rebuild needs `.cache/lichess_db_puzzle.csv.zst` (304 MB, gitignored —
re-download from <https://database.lichess.org/lichess_db_puzzle.csv.zst>) and
`zstd` on PATH; it takes ~3 min. It **deletes every build directory under
`public/puzzles/` that isn't the new one**, so commit the new shards and the
regenerated manifest together.

**Two UX rules that are product decisions, not accidents.** A puzzle's themes
stay hidden until it is solved or revealed (`Rail` in
`LibraryPuzzleSolver.tsx`) — the theme *is* the answer. And `solvedClean`, not
"attempted", is what retires a puzzle from the queue.

**Recommended** (`src/features/puzzles/recommend.ts`) scores the user's own
mistake motifs — `buildMistakes` in `src/features/puzzles/mistakes.ts` — and
fills a run of 20 from the corpus:

| constant | value | meaning |
|---|---|---|
| `HALF_LIFE_DAYS` | 30 | Recency decay `0.5^(age/30)`. |
| `SEV_FLOOR` | 0.5 | Severity multiplier runs 0.5-1.5 by winrate drop. |
| `MIN_SHARE` | 0.05 | Motifs below a 5% share are dropped, then the top `MAX_MOTIFS` survive. |
| `MAX_MOTIFS` | 5 | |
| `RATING_WINDOW` / `RATING_SAMPLE_GAMES` | 250 / 20 | Window ±250 around the middle rating of the last 20 rated games (`DEFAULT_CENTER_RATING = 1400` if none carry one). |

Lichess puzzle Glicko is not Chess.com game Elo, so that centring is a
heuristic — which is why the manual tier tabs exist alongside Recommended.

**`motifThemes.ts` maps our `Motif` union to Lichess theme strings, and
`motifThemes.test.ts` fails if any mapped theme is absent from
`PUZZLE_THEMES`.** That vocabulary is derived from the surviving rows of the
last build, so this test is the guard for a corpus refresh: if Lichess renames a
theme, it goes red instead of Recommended silently returning nothing. The same
test forbids mapping onto descriptor themes (`short`, `crushing`, `master`,
`middlegame`, …), which describe the puzzle rather than the tactic.

`puzzleAttempts` deliberately stores **raw attempt facts**
(`attempts`, `solvedClean`, `hintUsed`, `firstSeenAt`, `lastAttemptedAt`,
`msTaken`, `rating`) and not an SM-2 schedule, so spaced repetition can be
layered on later without a migration. `solvedClean` is deliberately **not**
indexed: IndexedDB cannot key on a boolean and Dexie *silently skips* such rows,
so `attempts.ts` scans and filters in JS.

## Openings

The library (~3 700 lines, 148 families) is generated from the Lichess
`chess-openings` TSVs into `src/data/openings.generated.ts`.

**Two naming systems, reconciled by `resolveOpeningFamily`.** Library names
come from Lichess and keep punctuation and diacritics ("Caro-Kann Defense",
"Réti Opening", "King's Gambit"). A game's `opening` comes from Chess.com's
ECO-URL slug via `parseOpeningFromEcoUrl`, which flattens every hyphen to a
space and carries no accents ("Caro Kann Defense", "Reti Opening", "Kings
Gambit"). Exact equality therefore fails for ~24 families.
`resolveOpeningFamily` folds both to a common key (diacritics, apostrophes and
all punctuation *and* whitespace stripped) and resolves in three stages: exact;
longest library family the input extends (collapsing "Caro-Kann Defense:
Advance Variation" to its family); shortest family extending the input (for
openings Chess.com names plainly but Lichess only files under a qualified name —
"Vienna Gambit" has 15 lines, all under "Vienna Gambit, with Max Lange
Defense").

Anything linking a chart row or a game to the library must pass through it and
link with the **canonical** name, or the openings page can't select a family.
Invariants pinned in `library.test.ts`: every one of the 3 690 lines resolves,
none onto an unrelated opening, and every family resolves to itself.

**But punctuation is not the only disagreement, and `resolveOpeningFamily`
cannot fix the other one.** All three of its stages are prefix-based, so they
only bridge names that *contain* one another. The datasets also use flatly
different names for the same opening: Chess.com calls 1.g3 "King's Fianchetto
Opening" where the bundled Lichess data calls it "Hungarian Opening". Those share
no prefix, `resolveOpeningFamily` returns null, and a dashboard chart row with no
canonical name rendered with **no link at all** — which reads as "this opening
isn't in the library" when it is.

So a caller that fails to resolve by name falls back to resolving by *moves*:
`familyFromGameMoves` in `features/openings/identifyFromGame.ts` runs
`identifyOpeningLine` over a sample game's UCI. This is the same principle
§ Prep gaps rests on — names are unreliable, moves are not — and it is preferred
over an alias table because it covers every divergence, including ones nobody
enumerated. `winRateByOpening` carries a `sampleGameId` per bar so the fallback
costs one PGN read per *unresolved* row and nothing at all when every row
resolves. Pinned by `chart-opening-links.mjs`, which asserts on the link's
target rather than merely on a link existing.

**`openingFamily()` splits the stored name on the first colon**, and the
importer only inserts one at the first
`Variation|Defense|Attack|Gambit|System|Opening` token. Slugs whose tail *is*
one of those words arrive unsplit as a single blob — which is why the prefix
stages above exist.

**Personal opening stats are expensive.** `buildPersonalOpeningStats` re-parses
every game's PGN through chess.js (~1.3 s at 2 500 games). Compute one colour,
and only once it is actually needed — not on mount. The same single walk also
accumulates per-prefix win/draw/loss (from `Game.result`, already stored from
the user's perspective), so a winrate signal costs nothing extra — add any
further per-game derivation to that walk rather than a second pass. The practice
page computes it once in `PracticeRunner` and threads it down; never build it
twice on one page.

**The generated bundle must stay coherent with its TSV inputs.** If
`openings.generated.ts` is built from a different
`data/openings/line-popularity.tsv` than the one committed beside it, every
frequency-derived number (opening suggestions, difficulty tiers) is silently
wrong — the data still looks plausible, so nothing surfaces it. Because
`scripts/build-openings.mjs` is offline over committed inputs, a unit test
(`src/data/openings.generated.test.ts`) rebuilds the bundle in memory and fails
if it differs from the committed file, ignoring only the timestamped banner
line; `buildBundle()` is the pure seam it calls. **If that test fails, run
`npm run openings:build` and commit the result** — never edit the bundle by
hand. Never let the two halves be regenerated separately: refresh the TSV and
rebuild the bundle in the same change.

**The guided set must never resolve to nothing drillable.** Active line keys
are *library* lines, and `guidedLineIndices` matches a key only against a
repertoire line that equals or **extends** it. A repertoire whose lines are
shallower than its recommendations therefore matches nothing — hold just the
5-ply Italian mainline and every top-5 recommendation is a 6+ ply continuation
of it — which would leave the drill page with an empty session and no board to
practise on. Which lines rank top-5 shifts with every opening-data refresh, so
treat this as live rather than hypothetical: `PracticePage` calls
`drillableGuidedIndices`, which falls back to the repertoire's own lines
(capped at the guided starter size). Pinned in `curriculum.test.ts` — keep that
guard when touching the guided flow.

**Repertoire line indices are not stable, and a picker row is not a line.**
`enumerateLines` (`repertoire/store.ts`) DFS-walks the FEN-keyed node tree and
emits a line per childless node, so adding one line renumbers every leaf after
it — and adding a line that *extends* an existing leaf makes that leaf stop
existing. Any index held across a repertoire write silently comes to mean a
different line. Hold line **keys** (`lineKey(uci)`, the joined UCI) and derive
indices at render time; `practiceMode`'s `remapIndices` event translates a
session's indices when the list rebuilds. Separately, a picker row stands for
"the shortest repertoire leaf that equals or extends me"
(`pickerModel.drillTargetFor`, `curriculum.guidedLineIndices`), because bulk
imports store deep leaves while the library offers shallow variations. So
several rows can share one leaf (unticking one unticks its siblings), a row's
target can change when a new leaf is added, and "N selected" counts leaves, not
ticked rows. Anything that selects lines automatically must respect an explicit
untick (a `deselectedKeysRef`), since absence from the selection cannot
distinguish "never wanted" from "just said no".

**The drill picker merges repertoire and library, keyed by `openingLineKey`.**
`buildPickerModel` (`repertoire/pickerModel.ts`) unions `enumerateLines` (what
you can drill) with `getVariations` (what you could add), per family; a library
variation counts as in-repertoire when a repertoire leaf *extends* it, not just
on exact match. Difficulty tiers (`openings/difficulty.ts`) are pure and
family-relative: scores are absolute, but the Easy/Medium/Hard cut is by
terciles of each family's own distribution (fixed thresholds for families with
< 3 lines), so "Hard" means hard *for that opening*. Adding a line from the
picker also stamps `learningMode: 'guided'` (inside
`addGuidedLinesToRepertoire`), which is why the drill page must not let that
write pull the user out of "Include all lines".

**A frequency is only trusted within `MEASURED_PARENT_DEPTH`.** The snapshot
(`scripts/snapshot-opening-popularity.mjs`) queries the explorer down to a
parent depth recorded in the TSV header (`measuredParentDepth=`); beyond it, a
line's `globalGames`/`globalShare` is the nearest measured ancestor scaled by a
`0.82^n` decay. That estimate falls monotonically with ply, so it is *not* a
rarity measurement — treating it as one would count depth twice and rebuild the
very ply-sorted ordering the difficulty tiers exist to replace. The build
propagates that depth into the bundle as `MEASURED_PARENT_DEPTH` +
`isMeasuredLine(line)`; `difficulty.ts` drops the rarity term (and the
forced/rare chip) for an estimated line, and the Learn panel refuses to quote a
frequency for one (`trustworthyShare`). A `globalGames` of zero means "no
signal" (the explorer only lists a position's top moves), never "maximally
rare". Because `MEASURED_PARENT_DEPTH` changes with each data refresh, code that
branches on it takes an injectable predicate in tests
(`scoreLine(line, stats, isMeasured)`) rather than hard-coding the current
depth.

### Prep gaps

`features/dashboard/prepGaps.ts` finds openings you lose in that are absent
from your prep. Two rules keep it honest, and both are easy to undo by
accident.

**Never split a game's `opening` into family + variation.** The reconciliation
above is about *spelling*; this is a separate defect in the same string.
`parseOpeningFromEcoUrl` inserts its colon at the first marker word it
recognises, so where the colon lands depends on whether Chess.com's slug
carried a trailing move sequence — the same opening arrives as both
`"Caro Kann Defense Advance Variation: 4.Nf3"` and
`"Caro Kann Defense: Advance Variation"`. Splitting on the colon files those
under two different families and fragments the very record that makes a gap
visible. `openingGroupKey` instead drops the move tail, neutralises the
punctuation and groups on the whole remaining name. The result is a grouping
key only: it is variation-grained but is not a library name (note the lost
hyphen), so it must never reach the UI as a label.

**The name shown and the position checked both come from the moves, never from
that key.** Stage 2 resolves each candidate through `identifyOpeningLine`,
which returns the deepest library line prefixing the game — so labels and
`/openings` links are canonical by construction, with no name matching between
the two vocabularies. The prep check is then deliberately *coarser* than that
match: the library distinguishes "Advance Variation, Short Variation" from
"Advance Variation, Tal Variation" where a game says only "Advance", so the
matched variation is truncated to its first comma segment before its defining
(shallowest) position is looked up. Checking the deep sub-line instead would put
"lost 8 of 11" beside a label describing one of the eight, and would report
prepped prep as a gap. Where the group's own name is just the family, the check
drops to the family. Both errors it avoids are silent — the card looks right
either way — which is why `scripts/test/integration/prep-gaps.mjs` asserts on
the hyphen in "Caro-Kann" and on a row retiring itself after prep.

The split into a pure PGN-free stage 1 and a PGN-reading stage 2 exists because
the dashboard reads `listGamesLight()` on a throttled live query; stage 2 reads
at most `MAX_CANDIDATES * SAMPLES_PER_CANDIDATE` PGNs. Widening stage 1 to parse
PGNs would put ~2 MB of allocation behind every refire.

## Openings data refresh

`.github/workflows/openings-refresh.yml` re-snapshots monthly (and on manual
dispatch) and pushes regenerated data to `main`, but only after a gauntlet:
snapshot → `openings:build` → a plausibility gate (row count and non-zero-row
count vs the committed TSV, to catch a proxy answering junk with HTTP 200) →
`typecheck` → `test:unit`. It commits only if the data-bearing lines actually
changed (both artifacts carry generated timestamps, so a byte diff would churn
every run). Verify-before-push is load-bearing: Cloudflare Pages deploys from
`main` on its own webhook, not through Actions, so anything that lands ships.
The snapshot script and the loop share an **exit-code contract** — `0` wrote the
TSV, `3` means the cache is still incomplete (resume), anything else is a hard
failure — so "incomplete" is never mistaken for "complete but unchanged". The
explorer cache is persisted across runs with `actions/cache/save@v4` under
`if: always()` (the default `@v4` post-step only saves on success, which would
discard every rate-limited run's progress). It gates on unit rather than e2e so
a single known-failing e2e test cannot freeze data refreshes.

To refresh by hand, expect it to take a while: the unauthenticated proxy
throttles at roughly 24 requests/minute and a full-depth snapshot needs ~2 300
parent positions, so run it in small batches
(`--concurrency=1 --delay=1500 --max=300`) and re-run to resume — the cache
makes each attempt compound, and the script exits `3` while work remains.
Setting a `LICHESS_TOKEN` hits Lichess directly and skips the proxy's limits
entirely.

## Storage durability

Everything the app owns lives in IndexedDB, and IndexedDB is **best-effort
storage**: until an origin asks otherwise, the browser may evict all of it to
reclaim space, and some browsers evict on an inactivity timer too. For most of
this app's life it never asked, so the README's local-first promise rested on
luck. `lib/storagePersistence.ts` asks — once per page load, from `AppLayout`'s
boot effect — and `features/settings/StorageDurabilityCard.tsx` reports the
answer.

**An eviction does not look like an eviction.** It takes the Clerk session with
it, so the app comes back signed out *and* empty, which reads as data loss or as
a sync bug. The pair of symptoms arriving together is the tell — a Dexie
migration wipe, by contrast, empties the tables and leaves you signed in.

What the grant does and does not buy, because it is easy to over-trust:

- Firefox prompts, so `false` can be a real refusal.
- Chrome decides silently from engagement signals (installed, bookmarked,
  frequently visited) and commonly refuses with no prompt at all.
- **Nothing on the client survives the user's own browser settings.** "Clear
  cookies and site data when you close all windows", or a manual clear, takes
  the data whatever was granted.
- **A full disk defeats the grant outright, and this is the failure that
  actually happened.** Chromium keeps two floors on free disk space:
  `should_remain_available` (min(1 GiB, 10%)) below which it evicts storage
  buckets, and `must_remain_available` (min(2 GiB, 1%)) below which it *refuses
  writes*. Durability exempts an origin from quota eviction; it does not exempt
  it from those floors. Measured on the machine this app is developed on: a disk
  at 13.9 MB free wiped six origins including this one, and WhatsApp Web lost its
  session with `durable_storage: 1` **granted**. So `persist()` is worth
  requesting but must never be described as protection against disk exhaustion.
  ext4's 5% root reserve is what makes this hard to spot — root stays healthy and
  only unprivileged writers starve, so it presents as "one app is misbehaving".
- Quota headroom is not protection either. An origin can be cleared while using
  a fraction of a percent of its quota, so a healthy `estimate()` says nothing
  about durability — only `persisted()` does. Conversely a *collapsed* `quota`
  is the app-visible symptom of a nearly-full disk, since Chromium derives quota
  from free space; that is the signal worth surfacing.

**So the app warns on headroom, not on the grant.** `assessStoragePressure`
reads `estimate()` and bands the *remaining* quota: below ~250 MB is `low` (a
Settings line), below ~50 MB is `critical` (an app-wide banner, mounted above
every other banner in `AppLayout`). Headroom rather than an absolute quota
figure, because a small quota on a small device is normal while small *remaining*
quota means writes are about to fail whatever the device — and a `quota` of 0 is
read as no room, never as unlimited, since that is precisely what a browser
promising nothing looks like.

Only `critical` interrupts. A banner that fires on "low" would be trained into
invisibility, and this one has to be believed the single time it matters.
`storage-durability.mjs` stubs `estimate()` to a nearly-full-disk shape and
asserts the banner appears, because the warning's whole value is being *told* —
a readout you have to go and look at would not have helped the two-day incident
that prompted it.

Which is why the mitigation that matters is not the grant but **cheap recovery**:
cloud sync restores the library, and § Boot-time passes' per-row rules vintage is
what keeps that restore from costing a reclassification of everything.

`requestDurability` checks `persisted()` before calling `persist()`, because
re-asking can re-prompt where browsers prompt, and the result is memoised so the
boot call and the Settings readout share one answer. Everything is wrapped: some
contexts (private windows, blocked site data) throw rather than resolve, and a
storage question must never break boot.

`scripts/test/integration/storage-durability.mjs` instruments
`navigator.storage` *before* the app's scripts run, because "the card renders"
would pass just as happily over a `persist()` call that never happens.

## Cloud sync

`src/features/sync/` mirrors three Dexie tables to Supabase.
`supabase/cloud-sync.sql` is the whole server side and is idempotent — re-run it
in the SQL editor after any change. Setup walkthrough: `SETUP_AUTH.md` §5.

| Postgres | Dexie |
|---|---|
| `cloud_games` | `games` |
| `cloud_analyses` | `analyses` |
| `cloud_puzzle_attempts` | `puzzleAttempts` |

**Gating is in RLS, never the client.** Writes require a row in
`cloud_sync_allowlist`, checked by `public.cloud_sync_enabled()` inside every
policy. The publishable key ships in the browser bundle by design, so a
client-side check would be cosmetic — the app's `isSyncEnabled` probe is a UX
affordance, not a boundary. Two deliberate shapes:

- The allowlist has a SELECT policy (`allowlist_select_own`) and **no
  insert/update/delete policy at all**, so the app can check its own membership
  but can never enrol itself. Enrolment is a dashboard action.
- It is a separate table rather than a `profiles` column because column-level
  `REVOKE` does not subtract from a table-level `GRANT` — a column flag would
  still be settable by a crafted insert.

**There is no DELETE policy on any table.** The mirror only grows. Deleting a
game locally does not remove the cloud copy, and a later sync restores it. That
is intended (it is a backup); pruning is a dashboard action, and
`summarizeCloudProgress` clamps for `analyses > games` because of it.

**Manifest diff, not dirty flags.** Each side reports ids plus a few decision
fields; `diff.ts` is pure (type-only imports) and reconciles them, which makes
sync stateless, idempotent, resumable and self-healing — no flag can be left
lying. Rows are jsonb `data` blobs plus decision columns, so the fast-moving
Dexie schema needs no Postgres migration. Two notes: attempts are the exception
that fetches whole rows (below), and `fetchAll` pages at 1000 because PostgREST
silently caps there.

**Every decision column must actually be written.** The diff reads columns, not
payloads, so a column left NULL makes the row read as something it isn't — and
the diff stops being a fixed point, so every sync re-pushes everything.
`toCloudAnalysis` carrying `engine` is the live example; `diff.test.ts` pins the
round trip.

Conflict rules, all in `diff.ts`:

| table | rule |
|---|---|
| analyses | `isBetter`: **NNUE beats classical above depth**, then deeper, then newer. A classical search at depth 20 is a weaker judge searching further, not a better analysis — ranking depth first would let a laptop's classical re-analysis overwrite the server's NNUE work. |
| games | Whichever side is analyzed wins, **except** that a local `pending`/`running` is left alone. |
| puzzle attempts | Field-by-field merge: max `attempts`, OR the sticky `solvedClean`/`hintUsed`, min `firstSeenAt`, max `lastAttemptedAt`, and `rating`/`msTaken` from the more recent side. |

Attempts are the only genuinely concurrent table, and their merge is
**commutative and idempotent** (both pinned in `diff.test.ts`) so two devices
converge without coordinating. Keep it that way: any new field needs an
operation with those two properties.

Three invariants a change must not break:

1. **Compute the analysis plan AFTER the games phase.** `diffAnalyses` skips a
   cloud analysis whose game is missing locally (no orphans). On a wiped device
   that set is empty until games have been pulled, so diffing everything up
   front skips *every* analysis and a "restore" comes back with games and no
   Stockfish work. `runCloudSync` re-reads the local games after the pull for
   exactly this reason.
2. **Attempts must fetch the real `data` row**, not be rebuilt from the metadata
   columns. Those columns omit `firstSeenAt`/`msTaken`, so the merge stops being
   a fixed point: every sync re-pushes every attempt and a restore overwrites
   `firstSeenAt`. (The columns are still written — they are just never read
   back.)
3. **A local `pending`/`running` is user intent (a requeue), not stale data.**
   If the games rule pulls the cloud's `done` row over it, it flips the very
   status `diffAnalyses`'s requeue guard keys off, and the requeue is silently
   undone. `error` still pulls — that is a failure, not an intent.

**Triggers**, in `useCloudSync.ts`: on sign-in (after the allowlist probe), on
the analysis queue going idle (`running` true→false), and the manual "Sync now"
button in Settings. There is deliberately **no polling timer** for sync itself;
the 45 s interval in `useCloudProgress` is a read-only progress readout and a
different thing. The store is pinned on `globalThis` so a duplicate module (HMR,
dynamic import) cannot split the state.

**`startSync` coalesces concurrent triggers, but never onto an aborted pass.**
De-duping onto a pass whose signal is already aborted *drops the request
invisibly*: the aborted pass resolves, `isAbort` maps it to `phase: 'ready'` —
which is indistinguishable from a clean no-op sync — and nothing transferred.
This is not theoretical. Clerk resolves `isLoaded` / `userId` in stages, so the
first effect run starts a sync and the second aborts it and retries; a retry that
adopted the dying promise never synced at all, and whether that happened depended
on network timing. Two rules follow:

- a request arriving while the running pass is aborted **queues behind it**
  instead of adopting it;
- the manual button passes `force`, because a deliberate click must always produce
  a pass — it is pressed precisely when something already looks wrong.

Ownership of the in-flight slot is tracked with a token, not promise identity: a
chained pass may already own the slot by the time its predecessor's `finally`
runs, and clearing it unconditionally would allow a third concurrent sync. Pinned
by `sync-coalescing.mjs`.

**Sync is mounted in `AppLayout`, so it runs in every browser test.** The E2E
bypass stub therefore answers the cloud tables as empty rather than throwing —
`CLOUD_SYNC_TABLES` in `src/lib/testAuth.ts`. A new cloud table must be added
to that set or every browser test starts logging errors.

`selectCandidates.ts` lives in this directory but is worker policy rather than
sync: it decides which games the off-laptop worker re-analyzes, mirroring
`isBetter`'s evaluator-then-depth ranking, and never downgrades an existing
NNUE analysis.

## Off-laptop analysis worker

`scripts/worker/` analyzes `cloud_games` with native Stockfish 16, writes
`cloud_analyses` and stamps a summary back onto `cloud_games`; the laptop collects
the results through cloud sync. It runs as a **scheduled Cloud Run job**
(`npm run worker:deploy`). **Full docs: `scripts/worker/README.md`** — read the
six load-bearing deployment decisions there before changing any of its flags.
Three things that must not be missed:

- **Run the verify job before any bulk run.** It proves the native binary
  reproduces the browser's evals with NNUE off, that NNUE genuinely changes them
  with it on (the check that catches a net failing to load), and that
  `analyzeGamePgn` runs end-to-end under Node.
- **One task, never parallel.** The worker has no lease or claiming — it selects
  every candidate game itself — so N parallel tasks each analyze the same games
  for N times the compute. Concurrency belongs inside the task.
- **The cloud is not the interactive path.** ~115 s of Cloud Run provisioning
  before any analysis starts, against ~10 s for a whole game locally. It exists to
  converge the library without the laptop, and to make devices that cannot run a
  4-worker NNUE pool (phones) fast. A review the user is waiting on is always
  answered locally — see § Engine.

Auth is the Supabase **service_role** key, which bypasses RLS entirely — hence
`USER_ID` is mandatory and every query filters on it. Because a classical
analysis counts as inadequate when NNUE is requested, the first NNUE run
re-analyzes the whole library rather than only unanalyzed games; `DRY_RUN=1`
prints the split.

## UI conventions

- `<html class="dark">` is a *Tailwind* convention and tells the browser
  nothing. Native chrome (scrollbars, `<select>` popups, date pickers,
  autofill) needs `color-scheme: dark`, declared once on `html` in
  `styles/index.css`. On Linux/GTK Chromium even that does not repaint the page
  scrollbar, so `html::-webkit-scrollbar*` is styled explicitly.
- A native `<select>`'s option popup inherits the **select's own** background,
  not its wrapper's. `bg-transparent` on a select renders a white menu.
- `BoardFrame` is the single source of primary-board sizing.
  `EVAL_BAR_WIDTH_PX` lives in `EvalBar` and both import it so the board stays
  at `PRIMARY_BOARD_MAX_PX` whether or not a bar is present.
- Tables over user data render a bounded page (see `PAGE_SIZE` in `GamesPage`).
  Filters and counts still run over the whole library; only the mounted row
  count is capped.
- `NAV_ITEMS` is exported from `AppLayout.tsx` and is the single definition of
  the nav; the mobile-drawer test derives its expected count from it rather than
  hard-coding one.
- Move sounds (`audio/moveSounds.ts`) are **synthesized** with Web Audio, not
  sampled: chess.com's audio files are their copyright, and generating the cues
  costs no bundle weight and no first-move network request. Swap in samples by
  changing `playMoveSound` alone — callers only ever name a `MoveSoundKind`.
  Each cue is a struck knock — contact noise plus a damped pitched body and one
  inharmonic partial, all starting on the same frame. *Stacking* simultaneous
  components is what gives weight; *sequencing* them is what reads as doubled
  sounds, so nothing is scheduled late except the `brilliant` flourish, which is
  deliberately a three-note arpeggio. Castling and promotion are plain moves;
  `brilliant` comes from `lastMoveClassification`, and precedence runs
  mate > brilliant > check > capture > move. `Board` drives them off
  `(fen, lastMoveUci)` rather than the user's drag, so one hook covers user
  moves, engine replies, autoplay and history stepping; it's opt-in per board
  (`sounds`) because the same component draws silent preview thumbnails. The
  on/off preference lives in localStorage, not the synced `Settings` row,
  because it's read synchronously inside a move handler and is a per-device
  question.

## Deployment

Cloudflare Pages builds from `main` via its own GitHub integration, so deploys
do **not** depend on GitHub Actions and nothing gates them. See `DEPLOY.md`.

**The build command must be `npm run build`, never a bare `vite build`.** The
`prebuild` hook is what stages the 40 MB NNUE net into `public/`, and Vite
copies `public/` into `dist/` verbatim. Skip it and `dist/stockfish/nn-*.nnue`
is absent, the runtime probe fails, and every analysis silently drops to the
classical evaluator. Verify with:

```bash
npm run build && ls -l dist/stockfish/nn-*.nnue   # ~40 MB
```

That check passes locally and the deploy still ships without the net, because
Cloudflare Pages rejects the 38.3 MiB asset outright — see § NNUE and
DEPLOY.md. Both facts matter: the staging step has to keep working for dev and
for any future host that accepts the file.

Two verification gotchas: Vite content hashes are not reproducible across
builds, so comparing a local `dist/` hash to the live one proves nothing — grep
the deployed asset for a string you added instead. And rollout is not atomic;
consecutive requests can hit old and new edges for a minute or two, so check a
few times before concluding.

`public/_headers` sets `COEP: require-corp` globally, which means every
subresource needs to opt in. Its own comments are the reference — read them
before editing. The two rules most likely to bite: **never redeclare COEP in a
per-route block** (Cloudflare *appends* per-route headers to the wildcard, and a
duplicated `Cross-Origin-Embedder-Policy` makes `new Worker(url)` fail with an
empty `ErrorEvent`), and the `Cache-Control: immutable` lines on `/stockfish/*`
and `/puzzles/*` are load-bearing rather than an optimisation — they are what
make a 40 MB net and an 18 MB corpus one-time costs. The CORP lines on those two
routes are defensive: a same-origin `fetch` passes the check either way.
`vite.config.ts` mirrors these headers in dev.

The Chrome extension ships separately:
`npm run extension:build -- --coach-origin=https://<host>` stamps the production
origin into `options.js` only (`content.js` keeps its localhost dev default on
purpose). The options page seeds that origin into `chrome.storage` on first
load, because `storage.sync.get` defaults are read-only and nothing was
persisted until the user pressed Save.
