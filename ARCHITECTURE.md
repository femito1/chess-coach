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
  one. Bump only for a new store, a new index, or an `upgrade()` hook.
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

**Version gates compare `>=`, not `===`.** A rolled-back version would
otherwise re-trigger the expensive pass on every DB that briefly saw the higher
number — re-freezing exactly the users a rollback is meant to rescue. A DB
carrying a newer stamp has already been through at least as new a rule set.
Pinned by `recompute-skip.mjs` phase 5.

**A pass that found nothing to do must not stamp.** Otherwise a first boot on
an empty DB marks the work done and the pass never runs on the data that
arrives afterwards. Passes 3, 4 and 5 hold this. `backfillBrilliantCounts`
does not — it stamps unconditionally, which is a latent bug if you ever rely on
it running post-import.

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
| Net filename, toggle, `nnueActive()`, `nnueNetAvailable()` | `src/engine/nnue.ts` |
| Staging the net into `public/stockfish/` | `scripts/copy-nnue.mjs` (`prebuild`, `predev`, `npm run nnue:stage`) |
| Evaluator ids | `NNUE_EVALUATOR_ID = 'stockfish-16-nnue'`, `CLASSICAL_EVALUATOR_ID = 'stockfish-16-classical'` |

**The 40 MB net is gitignored and staged at build time.** It ships inside the
`stockfish` npm package, so `npm ci` always supplies it; committing it would add
40 MB to every clone forever. `copy-nnue.mjs` parses `NNUE_NET_FILE` out of
`src/engine/nnue.ts` rather than repeating it, and **exits non-zero if the
installed package ships a different net** — otherwise a Stockfish upgrade would
leave the app asking for a file nobody copies and every eval would quietly go
classical. Starting Vite directly (`npx vite`) skips npm lifecycle scripts and
therefore skips staging.

**The net does not currently reach production.** Cloudflare Pages caps a
single asset at 25 MiB; the net is 38.3 MiB (40,119,326 bytes), so the deploy
that first staged it **failed to build** and `/stockfish/nn-*.nnue` on the live
site answers with the SPA fallback rather than the network. The probe below
catches that and the app runs classical there. So today NNUE is real in dev and
in the off-laptop worker (which embeds the net in its own binary), and *not* in
production — do not write code, or draw a conclusion about production eval
quality, that assumes otherwise. Serving it needs a host that allows a 40 MB
object; because the engine fetches it from inside a Worker under
`COEP: require-corp`, an off-origin copy would also need CORS plus
`Cross-Origin-Resource-Policy: cross-origin`. See DEPLOY.md § The NNUE network
and the 25 MiB asset cap.

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
`Threads 1` → `Hash 64` → *(if NNUE)* `EvalFile <filename>` → `Use NNUE true` →
`isready`. `EvalFile` is a **bare filename**; Stockfish resolves it next to the
worker script, and an absolute `/stockfish/...` path would break a non-root Vite
`base`.

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
different thing. `startSync` is de-duped by a module-level in-flight promise,
and the store is pinned on `globalThis` so a duplicate module (HMR, dynamic
import) cannot split the state.

**Sync is mounted in `AppLayout`, so it runs in every browser test.** The E2E
bypass stub therefore answers the cloud tables as empty rather than throwing —
`CLOUD_SYNC_TABLES` in `src/lib/testAuth.ts`. A new cloud table must be added
to that set or every browser test starts logging errors.

`selectCandidates.ts` lives in this directory but is worker policy rather than
sync: it decides which games the off-laptop worker re-analyzes, mirroring
`isBetter`'s evaluator-then-depth ranking, and never downgrades an existing
NNUE analysis.

## Off-laptop analysis worker

`scripts/worker/` analyzes `cloud_games` with native Stockfish 16 on a box you
provision and writes `cloud_analyses`; the laptop collects the results through
cloud sync. **Full docs: `scripts/worker/README.md`.** Two things that must not
be missed:

- **It is code, not a running service.** No server exists until someone
  provisions one.
- **Run `npm run worker:verify` before any bulk run.** It proves the native
  binary reproduces the browser's evals with NNUE off, that NNUE genuinely
  changes them with it on (the check that catches a net failing to load), and
  that `analyzeGamePgn` runs end-to-end under Node.

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
