# Architecture notes

Load-bearing invariants: the rules this codebase breaks quietly rather than
loudly if you violate them, and enough reasoning to know when a change is about
to violate one. Read the relevant entry before touching its area; the code
comments at each site are the detailed version, this is the map.

Contents: [Data model](#data-model) ·
[Boot-time passes](#boot-time-passes-and-version-stamps) · [Engine](#engine) ·
[NNUE](#nnue) · [Memory on mobile](#memory-on-mobile) · [Puzzles](#puzzles) ·
[Openings](#openings) · [Openings data refresh](#openings-data-refresh) ·
[Storage durability](#storage-durability) · [Cloud sync](#cloud-sync) ·
[Off-laptop analysis worker](#off-laptop-analysis-worker) ·
[UI conventions](#ui-conventions) · [Deployment](#deployment) ·
[Open items](#open-items)

## Data model

Everything is client-side: Dexie over IndexedDB (`src/db/schema.ts`, DB name
`chess-coach`), no application server. **Current schema version: 13.**

| table | key | holds |
|---|---|---|
| `games` | `id` | Game metadata + PGN, plus denormalized fields (below). |
| `analyses` | `gameId` | Per-move evals, classifications, motifs. |
| `puzzleAttempts` | `puzzleId` | Progress against the Lichess corpus (v12). |
| `repertoires` / `repertoireNodes` / `repertoireCards` / `repertoireLineStats` | `id` | Repertoire trees, SM-2 cards, per-line practice stats. |
| `evalCache` | `key` | Stockfish results, keyed by position **and evaluator**. |
| `importRecords` | `id` | Which Chess.com archives have been imported. A month counts as synced only if imported ≥24 h after its UTC end (`isImportComplete`): Chess.com caches archives, and a record of a month still in progress is a snapshot that kept growing. |
| `repertoireSyncBases` | `repertoireId` | What this device last agreed with the cloud about each repertoire (v13). See § Cloud sync. |
| `settings` | `key` (always `main`) | Single row: username, boot-pass stamps, prefs. |
| `puzzles`, `notes` | `id` / `fenKey` | **Dead stores.** Nothing in `src/` reads or writes them. |

Two schema rules:

- **A version bump is only needed to change stores or indexes.** Adding a field
  to `Settings` or `Game` needs no bump (`Game.requeuedAt` is one such field).
  Bump only for a new store, a new index, or an `upgrade()` hook. `v11` bumped
  for an optional `Settings` field purely so it showed in the schema history;
  don't read that as the rule.
- **Never drop a store to tidy up.** Dexie destroys its rows irreversibly. The
  two dead stores above are kept for exactly that reason. `v10` is the worked
  example of a deliberate wipe: its `upgrade()` clears the four repertoire
  tables and nothing else.

**Write `settings` only through `updateSettings`.** It is one row patched by many
independent writers — every boot pass stamps a version marker into it — and
`updateSettings` does its read and write in one rw transaction. A hand-rolled
`getSettings()` then `db.settings.put()` loses concurrent patches, which shows up
as a toggle the user flipped quietly reverting. Pinned by
`settings-concurrent-update.mjs`.

**`games` carries denormalized fields derived from `analyses`.** Move
classifications live in `analyses`, keyed by game id. The Games table and
dashboard must not read that table per render — a 1 k-game library is ~2 MB of
PGN and per-move data. So these are cached on the `Game` row:

| field | written by |
|---|---|
| `accuracy` | queue on analysis · recompute pass · `backfillAccuracies` · cloud sync on every pulled analysis |
| `userTimeSec` / `userPlyCount` | queue on analysis · `backfillUserTimeStats` |
| `brilliantCount` | queue on analysis · recompute pass · `backfillBrilliantCounts` · cloud sync on every pulled analysis |

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
of 60 games (20 on a phone for the recompute, brilliant-count and accuracy
passes, via `recomputeChunkSize`).

| order | pass | gate | constant (value) |
|---|---|---|---|
| 1 | `resetRunningToPending()` — **awaited, blocking**; recovers games left `running` by an unclean unload | every boot | — |
| 2 | `requeueStaleErrors()` — requeues games whose `analysisError` matches a known-transient pattern | every boot | — |
| 3 | `refreshOpeningMetadata()` — re-parses `opening`/`eco` from PGN | `lastOpeningRefreshVersion` | `OPENING_REFRESH_VERSION` (1) |
| 4 | `recomputeClassificationsAndAccuracies()` | `lastRecomputeVersion` | `RECOMPUTE_VERSION` (4) |
| 5 | `backfillUserTimeStats()` | `lastUserTimeBackfillVersion` | `USER_TIME_BACKFILL_VERSION` (1) |
| 6 | `backfillBrilliantCounts()` | `lastBrilliantBackfillVersion` | `BRILLIANT_BACKFILL_VERSION` (1) |
| 7 | `backfillAccuracies()` — re-derives cached `Game.accuracy` from stored winrates after a model recalibration | `lastAccuracyBackfillVersion` | `ACCURACY_BACKFILL_VERSION` (1) |
| 8 | `backfillRecomputeVersion()` — copies the DB-wide recompute stamp onto rows that predate `Analysis.recomputeVersion` | `lastRecomputeStampBackfillVersion` | `RECOMPUTE_STAMP_BACKFILL_VERSION` (1) |

Every constant lives in `src/db/queries.ts` except `RECOMPUTE_VERSION`, which is
defined in `src/db/analysisVintage.ts` and re-exported by `queries.ts`:
`analysisVintage.ts` has no Dexie import, so `analyzer.ts` — and through it the
Node worker — can stamp rows with it. A `detectMotifs` / `classifyMove` output
change is what a bump is for.

The analyzer run loop starts *before* passes 2-8, so a fresh import is never
held up by housekeeping. `BootBanner` only renders if the passes are still
running 400 ms in (`BOOT_BANNER_DELAY_MS`), so a warm boot shows nothing.

**Never bump `RECOMPUTE_VERSION` just to stamp a new field.** Pass 4 re-runs
`classifyMove` + `detectMotifs` + `detectPhase` over every move of every
analyzed game and rewrites `analyses`. That is seconds-to-minutes of
main-thread work, enough to make the app look frozen on reload. A field
derivable from data already in `analyses` gets its own pass with its own
stamp — `backfillBrilliantCounts` (~10 ms for 40 games) is the worked example.
The expensive pass may *refresh* such a field as a rider, but must never be the
reason it runs.

**The pass is resumable, and has to be.** It stamps `lastRecomputeVersion` only
after walking the *whole* library, and on a couple of thousand games it takes
minutes during which the app looks frozen — so the natural response, reload,
would otherwise guarantee it never finishes. Each chunk writes
`recomputeCursor` / `recomputeCursorVersion` to settings, and a run resumes
after the cursor; a reload costs at most one chunk of redone work. Three rules
the cursor carries, all pinned in `recompute-skip.mjs` phases 6–8:

- **It is only honoured for the version that wrote it.** After a rules change
  the old prefix was classified under the old rules and must be redone — which
  is the entire point of the bump. `force` ignores it for the same reason.
- **A completed run clears it**, or the next version bump would resume from a
  stale point and skip everything before it.
- **`doneIds` is sorted** so "everything up to the cursor" is a well-defined
  prefix. `primaryKeys()` off an index is already ordered, but the resume
  contract should not rest on that staying true.

A game imported *after* a partial run that sorts before the cursor is skipped —
but that is true without resumption too, because `doneIds` is snapshotted at
the start and the completion stamp suppresses later boots. Freshly analyzed
games get their classification from the analyzer; this pass exists only to
re-derive *old* rows under new rules.

**The pass skips rows that are already current, which is what makes a restore
cheap.** `Analysis.recomputeVersion` records the rules vintage of a row's
derived fields, and the pass reprocesses only rows below the current version.
This matters because the mirror stores whole `Analysis` blobs: pulled rows
already carry correct `classification` / `motifs`, yet an evicted device loses
its settings row too, so the DB-wide stamp is gone and without the per-row check
the pass would re-derive a library that is already right.

Three parts make that work, and all three are needed:

- **The producer stamps.** `analyzeGamePgn` runs the same `classifyMove` /
  `detectMotifs` / `detectPhase`, so its output is current by construction, and
  it sets `recomputeVersion` on the row it returns; `saveAnalysis` stamps again,
  to keep any other producer honest. The stamp has to be on the producer
  because the off-laptop worker writes straight to `cloud_analyses` and never
  calls `saveAnalysis`; an unstamped row reads as vintage 0 and every restore
  would reclassify and re-push it. Cloud *pulls* write `db.analyses` directly
  and must never stamp — they carry whatever vintage the producing device
  recorded.
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

`backfillRecomputeVersion` (boot pass 8) exists for libraries that predate the
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
arrives afterwards — which cloud restore makes the routine case: a wiped device
boots empty, then receives its library seconds later. Passes 3-8 all hold this.

**A pass writes only the fields it derives, and never puts back a row it read
earlier.** Every pass runs at boot beside the analyzer and cloud sync, and yields
between chunks, so a row read at the top of a chunk may have been rewritten by
the time the chunk writes: the analyzer sets `analysisStatus`, "Re-analyze all"
deletes the analysis and sets the game `pending`, a pull replaces an analysis
with a better one. A `bulkPut` of the rows as read silently reverts all of
those. So game-row passes patch with `bulkUpdate`, and
`backfillRecomputeVersion` uses `modify`, whose check and write see the same row
in one transaction. The recompute pass cannot patch — it rewrites the whole
`moves` array — so inside its write transaction it re-reads each analysis and
writes only those still the same search it reclassified (`isSameSearch` in
`analysisVintage.ts`: `analyzedAt` + `engine` + `depth`, the identity of a
search; the derived fields are what the pass rewrites, so they cannot be part of
it). A row replaced or deleted meanwhile is skipped, along with its game patch.

**The recompute pass OWNS `MoveEval.classification`, `.motifs`, and the
after-move fields of a terminal position.** It re-derives them from each move's
*stored FENs* and winrates on every boot where the stamp is behind — it is not a
one-time backfill — refreshes the game's cached `accuracy` / `brilliantCount`
from the result, and fills `phase` / `clockAfter` / `timeSpent` where absent. The terminal-position repair
(`repairTerminalMoveEval`, last move only) is the one place it rewrites an
*engine-derived* field: `winrateAfter` / `evalCpAfter` / `mateInAfter` for a
`fenAfter` with no legal move. It can, because the truth there follows from the
FEN alone, and it must, because otherwise a library analyzed without that rule
could only be corrected by re-running Stockfish over all of it. Consequences:

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
`EnginePool` (`src/engine/pool.ts`) runs several. The singleton `engine` export
is for single-position consumers (live eval) and is refcounted by `useLiveEval`;
`analysisPool()` is for whole-game analysis. Free-play uses its own separate
worker (`freePlayEngine.ts`) so the opponent search doesn't fight live eval.

**Pool slots are released by worker identity, never by captured index.**
`setMaxWorkers()` splices `workers`/`busy` (the visibility throttle calls it
when the tab hides), which renumbers every worker above a removed slot. A task
holding an index across a shrink therefore clears the wrong slot — or one past
the end of the array — stranding its own slot as permanently busy. That leaks a
worker, pins `isIdle()` false so the WASM heap is never freed, and eventually
has `pump()` call `.analyze()` on `undefined`, which surfaces as a game erroring
for no visible reason. Pinned by `pool-shrink-desync.mjs`.

**A position with no legal move is not the engine's to score, and it does not
say so in a way the parser hears.** For checkmate and stalemate Stockfish 16
answers `info depth 0 score mate 0` — carrying **no `pv`** — followed by
`bestmove (none)`. `EngineWorker` only folds an `info` line into its result when
that line has a pv, so both score fields arrive `null` and the caller reads
`0 cp`: dead equal. That is why `analyzeGamePgn` settles terminal positions with
chess.js (`terminalOutcome`) and never enqueues them.

Getting this wrong is silent and expensive: the last move of a game won on the
board is the mate, so reading its `fenAfter` as equal charges the *winner* a
~48-point winrate drop — one move accuracy of ~10 inside a harmonic mean over a
dozen scored plies, enough to take a 74 game to 45. The move list still says
`best` (`classifyMove` consults `isBest`), so the only symptom is a number that
feels wrong, on roughly a third of a blitz library. `mateToCp(0)` returns the
mated side's floor for the same reason: `mate 0` means "already mated".

**Ask `terminalOutcome` once per game, of the final position only.** An earlier
position with no legal move would have ended the game, and the check costs a full
legal-move generation — ~74× what classifying a quiet ply costs, so per ply it
adds minutes to the recompute pass on a large library. Keep it as the
`isCheckmate()` / `isStalemate()` pair: `moves().length === 0` reads simpler and
measured 3× slower, because public `moves()` builds a SAN string per move.

**A stopped search's output still arrives, so lines are attributed by count,
never by who is listening.** `stop` is answered with the stopped search's own
`bestmove`, and any `info` lines posted before the worker saw the `stop` are
still in the channel — both land *after* the next job has attached its listener
(measured against native Stockfish 16: `go depth 40`, `stop`, a new position and
`go depth 8` prints the old search's `info … pv e2e4` and `bestmove e2e4` first).
Taking "whatever arrives now" would hand every call the *previous* call's result,
and `rememberLiveEval` would cache it under the new FEN. UCI guarantees exactly
one `bestmove` per `go` and Stockfish starts a search only after printing the
last one's, so `EngineWorker` counts `go`s sent and `bestmove`s seen
(`searchesStarted` / `searchesFinished`, counted in `noteLine` so a cancelled
job's `bestmove` is seen too) and a job accepts only the lines after the (N−1)th
`bestmove` — exact, with no round trip before each search. Within a job, an
`info` line carrying a score replaces **both** `scoreCp` and `scoreMate`: a plain
spread would keep the stale half, so a mate seen at depth 12 would survive a
depth-18 `score cp`, and every caller reads `scoreMate` first. The Node worker
has the mirror problem after a timeout — see § Off-laptop analysis worker.

**A stored mate is from the side to move in its FEN — not the mover, not
White.** `mateInBefore` is the mover's (side to move in `fenBefore`);
`mateInAfter` is the *opponent's* (side to move in `fenAfter`): positive means the
opponent mates, so the move allowed it, and `0` means the mover just delivered
mate. That is Stockfish's own convention, and stored rows, the eval bar and the
terminal repair rely on it, so it is converted at the reader, never in storage:
`allowedMate` tests for a **positive** `mateInAfter`, and display goes through
`mateForWhite` so the move list's mate reads from White's side like the
centipawn figure beside it.

**Motif inputs, and what makes a motif count** (`engine/motifs.ts`):

- *"Walked into"* motifs (`fork`, `pin`, `skewer`, `backRank`) play the
  **opponent's best reply** on `fenAfter` (`replyUci`), never `bestUci` — that
  is the mover's move from the position before, and playing it on `fenAfter`
  moves the wrong side's piece. `replyUci` is the next ply's `bestMoveUci`,
  passed only when that ply's `fenBefore` equals this `fenAfter` (and, in the
  analyzer, that ply is not a book ply), because that is all the recompute pass
  can read back — tagging differently in the two would make a game's motifs
  depend on whether it was ever recomputed.
- *Back rank* means a real rook/queen mate on that rank, threatened or
  delivered, against the **side to move's** king boxed in by its own pieces —
  not "a king behind pawns", which is true of nearly every castled position.
- *Pins and skewers* count only lines that did not exist before the move, so a
  pin standing since move 6 does not tag every later mistake.
- *Fork* targets are undefended only if `chess.js` `attackers()` finds no
  defender; no legal move lands on its own side's piece, so a move-list test
  finds every target undefended.

Known gaps are listed under § Open items.

**A game must start from a position the analysis can represent.**
`analyzeGamePgn` replays from the game's own first position
(`history[0].before`, which honours a `[SetUp "1"] [FEN …]` header); replaying
from `new Chess()` fails every set-up game on its first move. A **White-to-move**
set-up start is analysed normally. Two cases are refused with a sentence in
`analysisError` (deterministic, so it must not match `requeueStaleErrors`'
transient patterns): a non-Standard `[Variant]`, because chess.js and Stockfish
both play standard rules here (no `UCI_Chess960`), and a **Black-to-move**
start, because every reader of a stored analysis splits colours on ply parity
(`ply % 2 === 1` is White) and would swap them. Variants are also filtered at
import — `isStandardChessComGame` (Chess.com `rules` other than `chess`; absent
counts as standard) in the bulk imports, the new-games banner's count (or it
would offer the same "N new games" forever), the off-laptop worker, and the
deep link, which names the variant in its error rather than claiming the game
was not found. The analyzer check catches rows imported before the filter, and
any other source.

**Game accuracy is calibrated against Chess.com's own figures.**
`CURRENT_ACCURACY_MODEL` (`analyzer.ts`) is the harmonic mean of per-move
accuracies — Lichess's curve with a steeper decay (0.074) — each floored at 24,
book plies counted as perfect, no gap stretch. Fitted on 938 colour-scores from
this user's games (~700-1000 rated, all Stockfish 16 NNUE depth 18) that carry
Chess.com `accuracies`: 5-fold cross-validated MAE 4.24 (9.18 for the previous
model; bias −6.8 → +0.9), 95% within ±10, and 4.4 on Aug-Oct when fitted on
Jan-Jul only. A gap stretch (a ×1.5 one fitted on Carlsen/Nakamura) refits to
×1.0 once the decay is free. Residual: § Open items. The fitting data: Chess.com
publishes `accuracies` on ~20% of this user's games, unauthenticated, at
`api.chess.com/pub/player/<user>/games/YYYY/MM`; the matching move lists are in
`cloud_analyses`. **A model change is an `ACCURACY_BACKFILL_VERSION` bump** (the
cheap `backfillAccuracies` pass — stored winrates only), **not** a
`RECOMPUTE_VERSION` bump. The Cloud Run worker computes accuracy with its own
bundled copy, but only into `cloud_games`, which clients never trust for it
(§ Cloud sync) — so redeploying it after a model change keeps that cached copy
tidy rather than fixing anything users see.

**`cancelAnalysis()` on the shared singleton kills whatever is running, whoever
started it.** `useLiveEval` only calls it once its consumer refcount hits zero,
so one idle consumer can't kill another's search.

**Pausing the queue does not abort the in-flight game.** The `paused` check
sits at the top of the run loop, so the current analysis finishes and only the
*next* game is withheld. The store still reports `running: true` with a
`currentGameId` while paused.

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

**Preemption also drops the abandoned game's queued positions.** `analyzeGamePgn`
enqueues every position of a game up front, so aborting only its per-ply loop
would leave the rest in the pool's FIFO, ahead of the game the user asked for —
most of a 60-ply game on four workers, which is exactly the wait preemption
exists to remove. So the game's `{ aborted }` flag travels with each position
(`EngineBackend.analyze` → `cachedAnalyze` → `EnginePool.analyze`) and `pump`
rejects a tripped task instead of dispatching it. Only *waiting* tasks are
dropped; one a worker already started runs to the end and is cached. That makes
`cachedAnalyze`'s in-flight coalescing subtle, because the preempting game is
usually the same opening and asks for positions the abandoned one still has
queued: a joiner of an abandoned entry takes its result if a worker had started
it, and re-asks under its own signal if it was dropped — inheriting the
`aborted` rejection would record a genuine-looking failure on the new game.

Invariants that are easy to break:

- **Re-requesting the in-flight game must be a no-op.** The review page's effect
  re-runs on re-render; if that preempted the game it is waiting for, the analysis
  would abort and restart forever and never finish. `requestAnalysisNow` checks
  `inFlight?.gameId` *before* it aborts anything.
- **A preempted game goes back to `pending`, never `error`.** `analyzeGamePgn`
  throws `aborted` when its signal trips, and the queue's catch would otherwise
  record a scary "analysis failed" on a game we cancelled deliberately —
  which `requeueStaleErrors` would then have to undo.
- **The chooser asks about the analysis row, not just the status**
  (`priorityGameWantsAnalysis`). An `error` game is dropped from the priority
  list: re-choosing it, with no sleep between, is a tight loop that starves the
  rest of the library, and the review page's Retry re-requests it anyway. A
  `done` game with **no** analysis row (a partial sync, a deleted row) is
  analysed: the page requests that case on purpose, and dropping every `done` id
  would leave it saying "queued" forever.

All pinned by `analysis-priority.mjs`.

**Worker count is a per-device setting, not a smarter heuristic.** Measured on a
12-core / 7.7 GB laptop, one 59-ply game at depth 18 NNUE through the real
analyzer: **4 workers 11.2 s, 6 workers 7.7 s, 8 workers ~122 s** — the last
because it starts swapping. The curve has a cliff, and where the cliff sits
depends on *free* memory, which the browser will not report:
`navigator.deviceMemory` gives total memory rounded to a power of two and capped
at 8. So `defaultPoolSize()` stays conservative and
`preferredWorkerCount()` (localStorage, like the NNUE toggle) lets a human who
knows their machine take the 31%. `effectivePoolSize()` is the one answer both the
pool and the Settings UI read. The phone clamp in § NNUE is not an exception to
this: it does not try to predict where the cliff is, it avoids a device that
cannot survive the default at all.

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

NNUE is **on by default** in the browser (except on a phone-shaped device, below),
and the difference is not cosmetic: classical and NNUE agree on forced tactics but
diverge badly in quiet and endgame positions — which is where a coaching app
draws its conclusions.

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
40 MB to every clone forever. `copy-nnue.mjs` reads `NNUE_NET_FILE` out of
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
| set (production) | that URL + the net filename; `copy-nnue.mjs` stages nothing and deletes any staged copy | absolute URL |

The production value lives in a **committed `.env.production`**, not in the Pages
dashboard: it is not a secret (every `VITE_*` is inlined into the client bundle),
`wrangler pages` has no build-variable command anyway, and a committed file is
reviewable and picked up by CI. A real environment variable still outranks it, so
per-environment overrides remain possible.

**Vite's mode is load-bearing here.** `.env.production` is read for `vite build`
and *not* for `npm run dev`, which is what keeps dev on the locally staged net —
offline-capable and free. Every build-side consumer therefore takes an explicit
mode (`predev` → `development`, `prebuild` → `production`, and the Vite plugin gets
Vite's own `mode`); a bare `npm run nnue:stage` defaults to `development` so it
never deletes the net it was asked to stage. Get it wrong in one direction and
dev pulls 38.3 MiB per engine start; wrong in the other and a production build
ships an over-cap asset. `engine-nnue` asserts dev resolves the net same-origin,
so a leak goes red.

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
so `dist/` and the bundle's baked-in URL cannot disagree. Reading `process.env`
alone would miss a `VITE_NNUE_NET_URL` set in `.env.local` (npm doesn't load
dotenv) and produce a bundle pointing at R2 while `dist/` still carries the
38.3 MiB net.

**A cross-origin net needs CORS and nothing else** — not
`Cross-Origin-Resource-Policy`, despite `COEP: require-corp`: the probe and
Stockfish's own download are CORS-mode requests, and a CORS response satisfies
COEP by itself. It is why a plain public R2 bucket suffices; pinned by
`scripts/test/integration/nnue-remote-net.mjs` across all four header
combinations, explained in DEPLOY.md § The only header that matters is CORS. Do
not "fix" it by adding CORP requirements to the docs. Stockfish accepts an
absolute URL for `EvalFile` because it loads the net through `emscripten_fetch`,
which passes the value to XHR verbatim (same +377 cp on the rook endgame from
either origin).

**A missing net is fatal, not degrading.** Stockfish 16 calls
`exit(EXIT_FAILURE)` at the first `go` if `Use NNUE` is on and the net did not
load, so analysis dies rather than getting worse. `nnueNetAvailable()` therefore
HEAD-probes the net first and requires `content-length > 1_000_000` (or no
length and a non-HTML type): the size check is the load-bearing half, because
Vite's SPA fallback answers a missing path with `index.html` at HTTP 200. On
failure it warns and the handshake omits both NNUE options, falling back to
classical.

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

**The eval cache key includes the evaluator.** `evalCacheRowKey()`
(`engine/cache.ts`) gives NNUE rows `${fen}|${depth}|nnue` and leaves classical on
the legacy `${fen}|${depth}` (so no migration). Without this a warm classical
cache feeds NNUE-*labelled* analyses.

**Memory, not bandwidth, is the real cost:** ~340 MB RSS per worker with NNUE
against ~125 MB classical, so a 4-worker pool goes ~0.5 GB → ~1.4 GB. Fine on
desktop, fatal on a phone. `defaultPoolSize({cores, memoryGb, nnue, phone})`
(`engine/pool.ts`) reads `navigator.hardwareConcurrency` and
`navigator.deviceMemory`, and clamps to 1 worker at ≤2 GB and 2 at ≤4 GB — **but
only when NNUE is on**.

**iOS Safari exposes no `deviceMemory`,** so on core count alone an iPhone gets
three NNUE workers, ~1.0 GB, beside the boot reclassification pass and a cloud
restore — enough for Safari to kill the tab. A Settings toggle is not that
platform's answer: the user would have to find it *before* the crash that tells
them they need it. So when there is no memory reading, `looksLikePhone()`
(`engine/device.ts`, pure form `isPhoneShaped`) is consulted: a coarse
**primary** pointer plus a short screen edge ≤500 px (`PHONE_MAX_SHORT_EDGE`)
means one NNUE worker, or two classical. NNUE's untouched default also flips off
there (`nnueDefaultForDevice`), which is the larger lever — 340 MB per worker
becomes 125 MB.

That is a capability query about the *device*, not user-agent sniffing, and it
deliberately does not widen to "no memory API" in general: desktop Safari and
Firefox report a fine pointer and keep the full pool. Tablets are also left alone
— an iPad's short edge is 744. `engine-nnue.mjs` pins both directions, including
that a phone which *does* report memory uses the reading rather than the screen
measurement. The toggle lives in localStorage (`chess-coach:engine.nnue:v1`,
default `nnueDefaultForDevice()`) rather than the synced `Settings` row
precisely because it is a per-device bandwidth/memory question.

`Analysis.engine` is typed plain `string`. `isNnueAnalysis()` (in
`src/features/sync/diff.ts`) is the single reader: a substring test for
`nnue`, so absent, null or unrecognised reads as **classical**. That is the
honest default — everything analyzed before the evaluator was recorded came
from a build running `Use NNUE` off.

## Memory on mobile

On a phone the engine is the dominant memory term (§ NNUE), but nothing
serialises the other big consumers against it: `startAnalysisQueue` starts the
engine run loop and then the boot passes, and cloud sync runs from its own
`AppLayout` effect, so whatever each costs, they can cost it at the same instant.
That is why every whole-table read has to keep its own peak down rather than
being scheduled around the others.

Sizes here are **estimates from row shapes**, not device measurements — the
30 KB-per-analysis figure comes from SETUP_AUTH.md. Treat the numbers as the
reason for a design, never as evidence of what it achieves.

### Projections stream, they never collect

A projection that exists so callers need not hold every PGN or every move list
must not itself hold them. `await table.toArray()` followed by `.map(strip)`
holds the table **twice** at its peak — every full row, because `toArray`
resolves all of them before `map` runs, plus the stripped copy being built
alongside — which is strictly worse than the unprojected read it replaces.

Use a **cursor**: `Table.each` / `Collection.each` visits one row at a time and
the full row is garbage the moment the callback returns, so the peak is one row
plus the light array the caller asked for. `streamLight` (`db/queries.ts`) is the
shared spelling. Dexie has no native "select-without-field" projection, so the
field is dropped in JS either way; what matters is how many rows are alive when
it happens.

| # | Sink | How it stays bounded |
|---|---|---|
| 1 | `listAnalysesLight()` | `streamLight` over a cursor. Peak: one analysis (vs ~1 200 analyses ≈ 36 MB JSON, plausibly 100–180 MB as live objects). |
| 2 | `listAllGamesLight()` / `listGamesLight()` | `streamLight` over a cursor. Called twice per sync. Settings reads no rows at all — see below. |
| 3 | Recompute pass gate | Decides on `bulkGetAnalysisLight` (vintage stamp + move count); full rows are read only for the ids that actually need reprocessing. On a restored library, every row current, that gate is the pass's entire cost. Chunk is 20 rather than 60 on a phone. |
| 4 | `backfillBrilliantCounts` | Cursors both tables, keeping two fields per game (`userColor`, `brilliantCount`) and one move list at a time — the PGN is never needed. Writes via `bulkUpdate`. |
| 5 | `PuzzlesPage` recommendation read | Folded per analysis — see below. |

`bulkGetAnalysisLight` is a cursor too. It walks `anyOf`, which visits the
primary-key index in **key** order rather than argument order, so it re-emits
from a map to keep its contract: argument order, unknown ids dropped, a repeated
id repeated. That re-emit is invisible to a type checker, and
`integration/light-projections` requests ids in descending order specifically to
catch its loss.

**Prefer an aggregate to rows.** Settings needs only the *set* of time classes
present to draw its filter chips, so `listTimeClasses` answers from the
`timeClass` index via `uniqueKeys` — no rows read, cost proportional to the
five-ish distinct classes rather than to the library. Reach for this before
reaching for a projection: a light row is affordable, an aggregate is free.
`countByStatus` is the same move. The Games page reads rows, correctly — it
lists them.

Chunk size is not a correctness parameter, which is why sink 3 can be
phone-aware cheaply: the cursor records the last id of whichever chunk finished
and resumption seeks past it, so a device that answers `looksLikePhone()`
differently between boots still resumes correctly, just at a different
granularity.

### Streaming what a projection cannot help

Motif scoring for "From your games" reads a classification and a motif list off
every move, so the move list *is* the input and a projection is no use. What
makes it boundable anyway is that each analysis is consumed **independently** —
nothing in one game's mistakes depends on another's — so it is folded on arrival
instead of collected:

- `mistakeRowsForGame(game, analysis)` (`puzzles/mistakes.ts`) is the per-game
  half of `buildMistakes`. Pure, and that module must stay pure: it has no Dexie
  import, which is what lets its consumers run in the unit tier.
- `forEachAnalysis(gameIds, visit)` (`db/queries.ts`) is the cursor. One analysis
  resident at a time. The visitor must be synchronous — awaiting inside a Dexie
  cursor closes its transaction — so fold, don't fetch.

What stays resident is `MistakeRow[]`: only the user's own blundery moves survive
the fold, so a few thousand small rows instead of ~1 200 move lists — single-digit
MB on that library, one to two orders below the move lists. `buildMistakes` still
takes every analysis at once; that is correct for `aggregateMistakes` and the
tests, which already hold them.

The cursor delivers in game-id order rather than the filtered game list's order,
and that does not matter: `scoreMotifs` sums into a map keyed by motif and sorts
its own output, and `estimateUserRating` re-sorts by date. `light-projections`
builds the rows both ways in one run and asserts they are field-for-field
identical, against a fixture seeded with real mistakes — two empty lists would
otherwise compare equal, and "the tab silently has nothing to recommend" is
exactly the regression to catch.

**A `MistakeRow` field belongs when a consumer reads it, not when one might.**
Rows outlive the analyses they are folded from, so every string field copied off
a `MoveEval` is held once per mistake in the library (a `fenBefore` is ~70
characters). Game-derived fields cost ~nothing — they reference strings the
caller's game rows keep alive — but are a `gameId` lookup away, so `opening` and
`eco` are there only because `aggregateMistakes` reads them. Widening is cheap:
`mistakeRowsForGame` has the `MoveEval` in hand, so it is one line in the type
and one in the fold. `recommend.test.ts`'s row factory builds the full shape so
that a contract change fails there first.

### `Settings.autoAnalyze`

Read by `nextGameToAnalyze` (`engine/queue.ts`), it is the lever for quieting the
analyzer on a constrained device. **It gates the unattended backfill only.** The
chooser is priority-first: the priority list is the review page saying "I am
showing this game and it has no analysis", which is the user asking directly, and
it keeps working whatever the toggle says. Only the `nextPendingGame()` fallback
beneath it — the newest-first background sweep, which is what the toggle's own
label describes — is gated. Gating the whole chooser would mean a user who turned
background analysis off could open an unanalyzed game and wait on a spinner
forever.

It is read *between games* rather than at the top of `runLoop`, deliberately:

- Turning it off does not abort the game in flight. Stopping new work is what was
  asked; abandoning the current analysis would drop the in-flight position and put
  the row back to `pending`. It stops at the next game boundary.
- Turning it back on takes effect within one poll — nothing restarts. Hence a
  settings read per call rather than a cached flag: one keyed Dexie get against a
  loop that sleeps 2–4 s when idle.

With it off and rows still `pending`, the chooser returns nothing, the loop takes
its idle path, and the engine workers are released after `IDLE_TEARDOWN_MS` —
which is the whole point on a device that cannot afford them. A `pending` row
arriving from a cloud pull is gated too, being exactly "a new game appearing on
its own".

The one place this is visible and could mislead: Settings' re-analyze buttons set
rows to `pending`, which with the toggle off will not move. That path says so in
its status line rather than flipping a setting the user just chose.
`integration/auto-analyze` pins all three properties, and asserts a pending game
*exists* alongside the "takes no work" assertion — without that precondition the
test would pass on an empty table.

## Puzzles

The Puzzles page serves the **Lichess open puzzle database** (CC0), not
positions mined from the user's own games.

| fact | value |
|---|---|
| Puzzles shipped | `PUZZLE_TOTAL = 191250` |
| Shards | 50 TSV files, ~18 MB total, committed under `public/puzzles/<PUZZLE_BUILD_ID>/` |
| Manifest module | `src/data/puzzles.meta.generated.ts` (totals, per-shard ranges, `PUZZLE_THEMES` vocabulary) |
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
| `PER_BAND_CAP` | 8000 | Capped **per 100-point rating band** (`BAND_WIDTH`), not globally. Lichess ratings cluster near 1500, so a global top-N starves the low and high ends. |
| `MIN_NB_PLAYS` / `MIN_POPULARITY` / `MAX_RATING_DEVIATION` | 100 / 85 / 90 | The quality gate. Loosen it and the corpus grows with worse puzzles. |
| `SHARD_ROWS` | 4000 | Rows per shard. |

The rebuild needs `.cache/lichess_db_puzzle.csv.zst` (304 MB, gitignored —
re-download from <https://database.lichess.org/lichess_db_puzzle.csv.zst>) and
`zstd` on PATH; it takes ~3 min. It **deletes every build directory under
`public/puzzles/` that isn't the new one**, so commit the new shards and the
regenerated manifest together.

`npm run puzzles:build` then runs `scripts/build-puzzle-theme-index.mjs`, which
reads the **shards** (not the CSV, so it can run alone) and writes
`src/data/puzzleThemeCounts.generated.ts`: puzzles per theme per 100-point band.
The theme picker shows those counts, and `windowForTheme` uses them to widen a
rare theme's rating window up front rather than by fetching shards until one
fills. `puzzleThemeCounts.test.ts` fails if its build id drifts from
`PUZZLE_BUILD_ID` — the guard against refreshing the corpus without it.

**Three views.** *Train* serves new puzzles: a theme (mixed, one Lichess
theme, or "From your games") at a difficulty **relative to the user's puzzle
rating** — presets −400…+400 (`DIFFICULTY_OFFSETS`), or an exact rating.
*Review* brings back missed puzzles on a schedule. *Progress* is stats plus a
grid of every puzzle done, each re-playable.

**Product rules, not accidents:**

- A puzzle's themes stay hidden until it is solved or revealed (`Rail` in
  `LibraryPuzzleSolver.tsx`) — the theme *is* the answer. (Picking a theme in
  Train discloses that one theme, by the user's choice.)
- **Any attempt, not only a clean solve, retires a puzzle from Train**
  (`loadAttemptedIds`). Misses go to Review instead, so a fresh run is fresh
  and the rating only ever sees first attempts.
- Only `clean` (no wrong move, no hint, no reveal) counts as a win — for the
  rating, for Review, and for first-try stats. A wrong move then Restart is
  still a `mistake`: the solver tallies moves in refs that `restart()` does
  not reset.
- **No live engine until the puzzle is solved or revealed.** Its read of the
  position is the answer in another form — "M2" on the eval bar says mate in 2
  as plainly as the hidden `mateIn2` theme would. The bar stays in place,
  neutral, so the board does not resize when it comes alive. Likewise the hint
  is withheld while the opponent's scripted reply is pending (it would ring
  *their* piece and still mark the attempt hinted), and clears once the reply
  lands.
- **The solver asks for the promotion piece.** `applyPuzzleMove` compares the
  whole UCI, promotion included, because some lines hinge on an underpromotion
  and crediting an auto-queen stalls them on an illegal scripted reply. The
  piece picker is `Board`'s opt-in `choosePromotion` prop; every other board
  still auto-queens.

**Puzzle rating** (`rating.ts`) is Glicko-1 replayed over each puzzle's
**first** attempt, from 1500 / RD 350; puzzle RD is taken as 75 (the build
keeps Lichess RD ≤ 90). RD floors at 60, regains ~8²/day idle, and reads as
provisional above 110. It is derived at read time, never stored. A run's
window is re-centred on the current rating every `TRAIN_BATCH` (10) puzzles —
not per puzzle, because the run must not rebuild under the user.

**Train window** (`windowForTheme`, `queue.ts`): ±60 around the target, widened
through `TRAIN_HALF_WINDOWS` only until the per-band theme index says it holds
`TRAIN_BATCH × 6`. Puzzles are drawn in a seeded shuffle, not ascending: inside
±60 an easiest-first ladder would just mean always the same corner.

**Review** (`stats.ts` § Review, `REVIEW_INTERVALS_MS`): miss → due in 20 h;
first clean retry → 3 days; second → learned; any miss restarts. Two steps, not
an open SM-2 ladder — fresh puzzles of the same pattern are always available, so
the goal is to fix the miss, not keep one position alive for months.

**Per-theme strengths** (`themeStats`) rank by *clean − expected*, where
expected is the rating's pre-result prediction for each puzzle. Raw success
rate would mostly rank themes by how hard their puzzles happened to be.
`themeCatalog.ts` groups the 72 themes (tactics / mates / phases / length /
other); `other` holds descriptors (`crushing`, `superGM`) and is excluded from
ranking. `themeCatalog.test.ts` fails if a corpus refresh adds an ungrouped
theme.

**"From your games"** (`src/features/puzzles/recommend.ts`) scores the user's own
mistake motifs — `buildMistakes` / `mistakeRowsForGame` in
`src/features/puzzles/mistakes.ts` (§ Memory on mobile) — and fills a run of 20
from the corpus:

| constant | value | meaning |
|---|---|---|
| `HALF_LIFE_DAYS` | 30 | Recency decay `0.5^(age/30)`. |
| `SEV_FLOOR` | 0.5 | Severity multiplier runs 0.5-1.5 by winrate drop. |
| `MIN_SHARE` | 0.05 | Motifs below a 5% share are dropped, then the top `MAX_MOTIFS` survive. |
| `MAX_MOTIFS` | 5 | |
| `RATING_WINDOW` / `RATING_SAMPLE_GAMES` | 250 / 20 | Window ±250 around the middle rating of the last 20 rated games (`DEFAULT_CENTER_RATING = 1400` if none carry one). |

Lichess puzzle Glicko is not Chess.com game Elo, so that centring is only the
fallback: once the puzzle rating is established (not provisional), the plan
centres on it plus the difficulty offset, ±150 — captured when the run starts,
for the same don't-rebuild-mid-run reason.

**The plan shapes the next batch, never the puzzle on screen.** It is recomputed
on every refire of the games table, which the analysis queue writes constantly;
as a dependency of the batch loader it would swap the puzzle mid-solve. So
`PuzzlesPage` reads it through a ref (`planRef`), like the rating, and the run's
first batch instead waits for `recommendation.loaded` (and for the attempt rows,
without which the rating reads as the 1500 default). That makes `loaded`
load-bearing: every input to the plan is `undefined` until known, so `loaded`
means "the plan is real" — an inactive query answering `[]` must not make it
true with an empty plan.

**`motifThemes.ts` maps our `Motif` union to Lichess theme strings, and
`motifThemes.test.ts` fails if any mapped theme is absent from
`PUZZLE_THEMES`.** That vocabulary is derived from the surviving rows of the
last build, so this test is the guard for a corpus refresh: if Lichess renames a
theme, it goes red instead of "From your games" silently returning nothing. The same
test forbids mapping onto descriptor themes (`short`, `crushing`, `master`,
`middlegame`, …), which describe the puzzle rather than the tactic.

`puzzleAttempts` deliberately stores **raw attempt facts**, and the rating,
Review schedule and stats are all derived from them at read time, so any of
those can be retuned with no migration. Each row carries `history` (one
`{at, outcome, ms, good, bad}` per attempt, capped at `MAX_ATTEMPT_HISTORY` = 25
in `puzzles/events.ts`, Dexie-free so the sync merge can share it) and a snapshot
of its puzzle (`fen`, `solution`, `themes`, ~200 bytes) so the history grid and
Review need no shard. All of it lives in the synced `data` jsonb, so it needs
**no DDL**. Legacy rows have neither: `eventsOf` reconstructs only what their
aggregates prove (first attempt always; last attempt when `solvedClean` after
2+), and `backfillAttemptContent` fetches their content once when Progress opens.

**The first attempt must survive everything that rewrites `history`**, because
it is the one the rating, first-try stats and band stats read
(`eventsOf(row)[0]`). So `capHistory` keeps the first event plus the newest 24
rather than the newest 25 — a plain slice would re-key all of those to
attempt #2 on the 26th try. And `recordAttempt` (via `withEvent`) and `mergeAttempt`
build from `eventsOf`, not `.history`: appending to a legacy row's empty history
would make the retry its only event, so `eventsOf` would stop synthesizing the
old first attempt and a clean retry of an old miss would re-score as a clean
first try. The synthesized first attempt thereby becomes a stored event on the
first retry or merge, with the same `at`+`outcome` key, so a shared attempt still
appears once. `solvedClean` is deliberately **not** indexed: IndexedDB cannot key
on a boolean and Dexie *silently skips* such rows, so `attempts.ts` scans and
filters in JS.

## Openings

The library (3 690 lines, 148 families) is generated from the Lichess
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
Invariants pinned in `library.test.ts`: every library line resolves, none onto
an unrelated opening, and every family resolves to itself.

**But punctuation is not the only disagreement, and `resolveOpeningFamily`
cannot fix the other one.** All three of its stages are prefix-based, so they
only bridge names that *contain* one another. The datasets also use flatly
different names for the same opening: Chess.com calls 1.g3 "King's Fianchetto
Opening" where the bundled Lichess data calls it "Hungarian Opening". Those share
no prefix, `resolveOpeningFamily` returns null, and a chart row with no canonical
name would render with **no link at all** — which reads as "this opening isn't in
the library" when it is.

So a caller that fails to resolve by name falls back to resolving by *moves*:
`familyFromGameMoves` in `features/openings/identifyFromGame.ts` runs
`identifyOpeningLine` over a sample game's UCI. This is the same principle
§ Prep gaps rests on — names are unreliable, moves are not — and it is preferred
over an alias table because it covers every divergence, including ones nobody
enumerated. `winRateByOpening` carries a `sampleGameId` per bar so the fallback
costs one PGN read per *unresolved* row and nothing at all when every row
resolves. Pinned by `chart-opening-links.mjs`, which asserts on the link's
target rather than merely on a link existing.

**The win-rate chart groups by `chartOpeningFamily`, not by `openingFamily()`
alone** (`dashboard/progress.ts`). `openingFamily()` splits the stored name on
the first colon, and the importer inserts one only at the first
`Variation|Defense|Attack|Gambit|System|Opening` token, so where it lands
depends on the slug's tail and one opening can arrive as up to a dozen chart rows.
`chartOpeningFamily` strips any move text (`stripOpeningMoves` — after a colon,
after a space, or fused: "Scotch Game 3...d6", "Pirc Defense...4.c3"), then
resolves through `resolveOpeningFamily`, which is also the canonical name the
row's link needs. A name the library does not know falls back to the name cut
after its first family-ending word (`Opening|Defense|Game|Attack|Gambit|System`),
so its variations still fold into one row; that row keeps Chess.com's spelling
and its link comes from moves, as above.

**A family's side comes from its name where explicit, else from its defining
move** (`familyColor`, `openings/library.ts`). It is the colour a family
repertoire is created with, so a wrong answer makes every drill card quiz the
opponent's moves. Neither source works alone: a name list misses every Black
gambit not spelled "Defense" (Latvian, Elephant, Benko Gambit Accepted), and the
moves alone mislabel ~20 families (the King's Indian's defining line ends on
3.Nc3). So naming rules first — `Defense`/`Countergambit` is Black, a trailing
`Opening`/`Attack`/`System`/`Game`/`Formation` is White, "<X> Accepted/Declined"
follows X, and "<X>, with <Y>" is judged on X — then whoever played the last move
of the family's bare (else shortest) line. Only the Queen's Gambit Declined and
Accepted are hard-coded Black, by convention against the Accepted/Declined
rule. `library.test.ts` pins the resulting Black set, so a data refresh that adds
a family forces a look at its side.

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

**The repertoire is a shared-position graph, and the line walk follows move
orders.** Nodes are keyed by `fenKey` (the FEN without its move counters), so two
move orders that transpose share one node — and the second arrives with
different counters, so **every** `childFens` / `parentFen` / `mainChildFen`
lookup must go by `fenKey`; a full-FEN lookup misses the shared node and
silently drops every line behind it. A shared node's stored `moveUci`/`moveSan`
describe only its first way in; `edgeMove` re-derives the move along any other
edge. Position-keying alone cannot say which continuations belong to which move
order, and following every edge cross-multiplies them into hundreds of lines
nobody added. So each node records `paths`, the root-to-node UCI sequences it was
added along (`RepertoireNode.paths`, optional and unindexed — no schema bump), and
the walk follows an edge only when the extended sequence is one of them. Rows
predating `paths` heal at read time: along their creation tree edges are followed
as before, and past a transposition only when the sequence is a library-line
prefix (`isLibraryLinePrefix`) — every line added since the v10 wipe came from the
library. The first write to such a repertoire upgrades it, writing exactly the
paths the fallback showed (`upgradeLegacyPaths`), since recording only the new
move order on a legacy node would hide every old line through it. Sync merges
union `paths` like `childFens`. The rules live in pure `repertoire/lineTree.ts`
and are unit-tested in `lineTree.test.ts`.

The **card trainer** grades against every repertoire move from a card's position
(`repertoireMovesAt`), not only the card's single `expectedUci`: at a branch point
each is the user's prep, and the card asks "do you know your move here", not
"which was added first".

**Repertoire line indices are not stable, and a picker row is not a line.**
`enumerateLines` (`repertoire/store.ts`, over `lineTree.ts`'s `walkLines`) emits a
line wherever a move order stops, so adding one line renumbers every line after
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
parent depth recorded in the TSV header (`measuredParentDepth=`, `full` for no
cap); beyond it, a line's `globalGames`/`globalShare` is the nearest measured
ancestor scaled by a `0.82^n` decay. That estimate falls monotonically with ply,
so it is *not* a rarity measurement — treating it as one would count depth twice
and rebuild the very ply-sorted ordering the difficulty tiers exist to replace.
The build propagates that depth into the bundle as `MEASURED_PARENT_DEPTH`
(`Infinity` for `full`, which the committed snapshot is) + `isMeasuredLine(line)`;
`difficulty.ts` drops the rarity term (and the forced/rare chip) for an estimated
line, and the Learn panel refuses to quote a frequency for one
(`trustworthyShare`). A `globalGames` of zero means "no signal" (the explorer
only lists a position's top moves), never "maximally rare". Because
`MEASURED_PARENT_DEPTH` changes with each data refresh, code that branches on it
takes an injectable predicate in tests (`scoreLine(line, stats, isMeasured)`)
rather than hard-coding the current depth.

A game that starts from a set-up position is analysed correctly (§ Engine), but
several openings readers still assume the standard start — see § Open items.

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
visible. `openingGroupKey` instead drops the move tail wherever it sits
(`stripOpeningMoves` — not only after a colon or comma: once a colon is placed,
moves arrive after a space or fused to the name, and each distinct tail would be
its own group too small to reach `MIN_GAMES_FOR_GAP`), neutralises the
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
TSV, `3` means the cache is still incomplete (resume), anything else is a failed
attempt (retried; the job fails if no attempt completes) — so "incomplete" is
never mistaken for "complete but unchanged". The explorer cache is persisted
across runs with `actions/cache/save@v4` under `if: always()` (the default `@v4`
post-step only saves on success, which would discard every rate-limited run's
progress). It gates on unit rather than e2e so a single known-failing e2e test
cannot freeze data refreshes.

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
reclaim space, and some browsers evict on an inactivity timer too.
`lib/storagePersistence.ts` asks — once per page load, from `AppLayout`'s boot
effect (`ensureDurableStorage`) — and `features/settings/StorageDurabilityCard.tsx`
reports the answer.

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
- **A full disk defeats the grant outright.** Chromium keeps two floors on free
  disk space: `should_remain_available` (min(1 GiB, 10%)) below which it evicts
  storage buckets, and `must_remain_available` (min(2 GiB, 1%)) below which it
  *refuses writes*. Durability exempts an origin from quota eviction; it does not
  exempt it from those floors (measured: a disk at 13.9 MB free wiped origins
  including ones holding `durable_storage: 1`). So `persist()` is worth
  requesting but must never be described as protection against disk exhaustion.
  ext4's 5% root reserve is what makes this hard to spot — root stays healthy and
  only unprivileged writers starve, so it presents as "one app is misbehaving".
- Quota headroom is not protection either. An origin can be cleared while using
  a fraction of a percent of its quota, so a healthy `estimate()` says nothing
  about durability — only `persisted()` does. Conversely a *collapsed* `quota`
  is the app-visible symptom of a nearly-full disk, since Chromium derives quota
  from free space; that is the signal worth surfacing.

**So the app warns on headroom, not on the grant.** `assessStoragePressure`
reads `estimate()` and bands the *remaining* quota: below ~250 MB
(`LOW_REMAINING_BYTES`) is `low` (a Settings line), below ~50 MB
(`CRITICAL_REMAINING_BYTES`) is `critical` (an app-wide banner,
`StoragePressureBanner`, mounted above every other banner in `AppLayout`).
Headroom rather than an absolute quota figure, because a small quota on a small
device is normal while small *remaining* quota means writes are about to fail
whatever the device — and a `quota` of 0 is read as no room, never as unlimited,
since that is precisely what a browser promising nothing looks like.

Only `critical` interrupts. A banner that fires on "low" would be trained into
invisibility, and this one has to be believed the single time it matters.
`storage-durability.mjs` stubs `estimate()` to a nearly-full-disk shape and
asserts the banner appears, because the warning's whole value is being *told* —
a readout you have to go and look at does not help.

Which is why the mitigation that matters is not the grant but **cheap recovery**:
cloud sync restores the library, and § Boot-time passes' per-row rules vintage is
what keeps that restore from costing a reclassification of everything.

`requestDurability` checks `persisted()` before calling `persist()`, because
re-asking can re-prompt where browsers prompt, and `ensureDurableStorage`
memoises the result so the boot call and the Settings readout share one answer.
Everything is wrapped: some contexts (private windows, blocked site data) throw
rather than resolve, and a storage question must never break boot.

`scripts/test/integration/storage-durability.mjs` instruments
`navigator.storage` *before* the app's scripts run, because "the card renders"
would pass just as happily over a `persist()` call that never happens.

## Cloud sync

`src/features/sync/` mirrors four kinds of local data to Supabase.
`supabase/cloud-sync.sql` is the whole server side and is idempotent — re-run it
in the SQL editor after any change. Setup walkthrough: `SETUP_AUTH.md` §5.

| Postgres | Dexie |
|---|---|
| `cloud_games` | `games` |
| `cloud_analyses` | `analyses` |
| `cloud_puzzle_attempts` | `puzzleAttempts` |
| `cloud_repertoires` | `repertoires` + `repertoireNodes` + `repertoireCards` + `repertoireLineStats`, one snapshot row per repertoire (below) |

**Gating is in RLS, never the client.** Writes require a row in
`cloud_sync_allowlist`, checked by `public.cloud_sync_enabled()` inside every
policy. The publishable key ships in the browser bundle by design, so a
client-side check would be cosmetic — the app's `isSyncEnabled` probe is a UX
affordance, not a boundary. Two deliberate shapes:

- The allowlist has a SELECT policy (`allowlist_select_own`) and **no
  insert/update/delete policy at all**, so the app can check its own membership
  but can never enrol itself. Enrolment is a dashboard action, and is by
  **literal Clerk user id** in `cloud-sync.sql` — never a lookup on `profiles`,
  whose rows (username included) each user writes for themselves, so a lookup by
  username would enrol anyone who claimed it.
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
silently caps there — **ordered by the row key**, because offset paging over an
unordered scan has no stable page boundaries: an upsert between two pages
(another device, the worker) can move a row, which then lands on two pages or on
none. The repertoire manifest pages the same way.

**Sync refuses a local library bound to another account.** The profile handshake
refuses to merge a browser bound to user A when user B signs in, but sync is a
separate trigger; without its own check it would push A's library into B's
mirror (permanently: no DELETE policy) and pull B's into A's local DB. Every
entry point — `runCloudSync`, `syncPuzzleAttempts`, `syncRepertoires` — calls
`assertLocalDataBelongsTo` (`sync/bindingGuard.ts`) before any request, which
reuses the handshake's own rule (`isBoundToOtherUser` in `auth/profileBind.ts`)
rather than a parallel one. An unbound device passes: the handshake binds it to
whoever signs in first, so syncing it agrees with what the handshake does.
`useCloudSync` asks too, so the triggers stay disarmed and the reason shows on
the Settings card. Pinned by `cloud-sync.mjs` step 9 — which is why sync tests
must use the bypass user's own id (TESTING.md).

**Every decision column must actually be written.** The diff reads columns, not
payloads, so a column left NULL makes the row read as something it isn't — and
the diff stops being a fixed point, so every sync re-pushes everything.
`toCloudAnalysis` carrying `engine` and `recompute_version` is the live example;
`diff.test.ts` pins the round trip. **Every writer goes through the serializer**
(`toCloudAnalysis` / `toCloudGame`), the off-laptop worker included: a hand-built
row that omits `recompute_version` reads as vintage 0, and each restore would
reclassify and re-push it.

Conflict rules, all in `diff.ts`:

| table | rule |
|---|---|
| analyses | `isBetter`: **NNUE beats classical above depth**, then deeper, then newer rules vintage (`recompute_version`, § Boot-time passes), then newer. A classical search at depth 20 is a weaker judge searching further, not a better analysis — ranking depth first would let a laptop's classical re-analysis overwrite the server's NNUE work. |
| games | Whichever side is analyzed wins, **except** that a local `pending`/`running` is left alone. |
| puzzle attempts | Field-by-field merge: max `attempts`, OR the sticky `solvedClean`/`hintUsed`, min `firstSeenAt`, max `lastAttemptedAt`, `rating`/`msTaken` from the more recent side, `history` unioned by `at`+`outcome` over each side's `eventsOf` (so a legacy side's synthesized first attempt is not lost; copies of one event merged field-wise, so it stays commutative), capped first + newest by `capHistory`, content from whichever side has it. |
| repertoires | Three-way against `repertoireSyncBases` (below). |

Attempts are the only genuinely concurrent row-level table, and their merge is
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

**The requeue guard keys on `Game.requeuedAt`, not on status alone.**
`requeueGame` deletes the local analysis and sets `pending`, and pulling the
cloud's copy would undo that — but a game this device has simply never analyzed
is *also* `pending`, and once the worker analyzes games the laptop never touched
that is the normal case; a status-only guard would pull none of them while the
laptop re-analyzes the whole library. So no stamp means nothing to protect and
the cloud analysis pulls; a stamp at or after the remote `analyzed_at` means it is
the discarded row; a stamp older than the remote analysis means someone did the
work better elsewhere, and it pulls.

**Pulling an analysis also settles the game row.** Writing the analysis alone
would leave `analysisStatus: 'pending'`, so the local queue would re-analyze a
game whose analysis had just arrived and clobber depth-18 NNUE with a shallower
local pass — which the next sync would pull back. `accuracy` and
`brilliantCount` are recomputed from **every** pulled analysis whose game is
local — not only the ones being settled — and never trusted from `cloud_games`.
That row is only fetched when the *game* is a pull candidate, and its cached
numbers go stale (the worker writes them with whatever model and rules its image
had), so re-deriving only for settled games would leave a restored library with
stale accuracy. Pinned by `cloud-sync.mjs` step 3 (a stale cloud accuracy must
not survive a restore) and 5b.

**Triggers**, in `useCloudSync.ts`: on sign-in (after the allowlist probe), on
the analysis queue going idle (`running` true→false), and the manual "Sync now"
button in Settings. There is deliberately **no polling timer** for sync itself;
the 45 s interval (`PROGRESS_POLL_MS`) is a read-only progress readout and a
different thing. The store is pinned on `globalThis` so a duplicate module (HMR,
dynamic import) cannot split the state.

**Puzzle attempts upload on their own, ~10 s after each one and on tab hide**
(`requestAttemptSync` → `syncPuzzleAttempts`, `ATTEMPT_SYNC_DELAY_MS`). None of
the three triggers above fires because of a puzzle, and the queue-idle one rarely
fires at all when the worker delivers games already analyzed — so without this, a
session's progress waits on the device for the next app open, and any loss of
local data in that window (§ Storage durability) takes it. **Anything new the user
produces locally needs the same treatment**: a full-sync trigger will not cover
it. The attempt-only path reads and writes **only** `cloud_puzzle_attempts` — the
game and analysis manifests are thousands of rows, fine once per app open,
wasteful once per puzzle — and waits behind an in-flight full sync rather than
racing it, since both diff the same rows. Its plan comes from a read a network
round trip old, so it **re-merges inside its write transaction**
(`rebaseAttemptWrite`): a puzzle solved meanwhile has committed a newer row that
writing the plan verbatim would erase. Exact rather than heuristic, because the
merge is commutative and idempotent — with no race it is the planned row
unchanged. Pinned by step 8 of `cloud-sync.mjs`.

Its runner — `createCoalescingRunner`, which the repertoire upload uses too —
has one rule that matters on tab hide:
`flush()` runs a pending job now, and **a follow-up owed by a request that
arrived mid-run counts as pending** — it runs the moment the in-flight job ends
instead of waiting out a delay the hidden page may never get. That follow-up
carries the attempt recorded during the upload, which is exactly what `flush`
exists for.

**Repertoires sync as whole snapshots, three-way.** One `cloud_repertoires` row
per repertoire holds its record, node tree, SRS cards and line stats, so a node
and its card can never be split across two half-applied syncs. Unlike games they
are edited in place and carry no per-row modification time, so each device keeps
a `repertoireSyncBases` row (v13): the cloud `rev` and content hash as of the last
agreement. Against it "changed here" and "changed there" are facts; only "changed
on both" merges, and the merge never discards training — counters take the max,
a card keeps its latest review, the tree is the union. The deliberate cost: a line
deleted on one device while the same repertoire was edited on another comes back.
Rules that must hold:

- **Every cloud update is compare-and-swap** (`where rev = <planned rev>`), so a
  push racing another device's is detected — and merged next sync — rather than
  overwriting it. A duplicate insert's `23505` means the same.
- **A pull replaces the repertoire and its base in one transaction.** A base
  written apart from its data would misreport a half-applied pull as a local edit.
- **An apply never overwrites an edit made while the sync was in flight.** The
  write transaction re-reads the local snapshot and compares its hash with the
  one the plan was made from; on any difference the pull, delete or merge is
  skipped and counted as a conflict. Overwriting would lose the edit for good,
  since the base saved with it would match the overwritten state. Skipped, base
  and data stay as they were, and the next sync sees "changed here".
- **Deletion is a tombstone** (`deleted = true`); there is no DELETE policy, and a
  device that still has the repertoire must learn it was deleted.
- **Changes are caught by Dexie table hooks**, not call sites: the store, the
  openings library and both trainers all write. The hooks skip the sync's own
  pull writes, or every pull would schedule a pointless follow-up — identified
  by **transaction** (`isRemoteRepertoireWrite(tx)`), not a module-wide flag: a
  user's write queued behind the sync's executes the moment it commits, before a
  flag cleared in `finally` would be, and is a real edit that must upload.
- **A project without the table skips the phase** with one warning: the app can
  deploy before `supabase/cloud-sync.sql` is re-run, and that must not turn every
  sync red. Policy is unit-tested in `repertoireDiff.test.ts`; plumbing, including
  both conflict signals, in `repertoire-sync.mjs`.

**`startSync` coalesces concurrent triggers, but never onto an aborted pass.**
De-duping onto a pass whose signal is already aborted *drops the request
invisibly*: the aborted pass resolves, `isAbort` maps it to `phase: 'ready'` —
which is indistinguishable from a clean no-op sync — and nothing transfers.
Clerk resolves `isLoaded` / `userId` in stages, so the first effect run starts a
sync and the second aborts it and retries; a retry that adopted the dying promise
would never sync, depending on network timing. Two rules follow:

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

`scripts/worker/` imports new Chess.com games into `cloud_games`, analyzes them
with native Stockfish 16, writes `cloud_analyses` and stamps a summary back onto
`cloud_games`; the laptop collects both through cloud sync. It runs as a
**scheduled Cloud Run job** (`npm run worker:deploy`). **Full docs:
`scripts/worker/README.md`** — read the seven load-bearing deployment decisions
there before changing any of its flags. Five things that must not be missed:

- **Import inserts only rows that are absent — never upserts over them.** A row
  the laptop pushed may be `done` and carry an accuracy the import knows nothing
  about; overwriting it with a fresh `pending` mapping would make the laptop
  re-analyze it. It reuses `chessComGameToGame`, so the id is the same URL hash
  the browser computes, and the laptop pulls the row as it pulls any cloud-only
  game. Import is what makes the job useful at all: without it the worker only
  sees games the laptop already imported, and usually analyzed.
- **A fix in shared `src/` code reaches the worker only on redeploy.** The job
  runs the last pushed image. The deploy script's project, `USER_ID` and timezone
  defaults are each wrong on a machine not set up like the original; the worker
  README § Redeploying has the command.
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

Its per-game writes — analysis, then the `done` summary on `cloud_games` — are
**not atomic** (PostgREST gives it no transaction across them), so a run killed
between them leaves an adequate analysis beside an un-`done` game that
`selectCandidates` would then skip forever. Each run settles those first
(`selectUnsettled`), with no engine. Both rows go through `toCloudAnalysis` /
`toCloudGame` (§ Cloud sync, "every decision column"). A run stopped by the
failure budget (more than 50 failures, outnumbering successes) **exits non-zero**
so the Cloud Run execution reads as failed, and a search that times out is
stopped and its `bestmove` drained — or, if wedged, the engine replaced — so the
next position never receives the old search's answer. Details in the worker
README § Resuming, and stopping.

Auth is the Supabase **service_role** key, which bypasses RLS entirely — hence
`USER_ID` is mandatory and every query filters on it. A classical analysis counts
as inadequate when NNUE is requested, so classical rows (from phones) are
re-analyzed; `DRY_RUN=1` prints the split.

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
- **A wide table's horizontal scrollbar belongs on screen, not at the bottom of
  the table.** `overflow-x-auto` puts it at the bottom of the scrolled element,
  so on a table that is both wider than the window and several screens tall it
  sits below the fold. `StickyXScroll` draws it in a strip that is
  `position: sticky` to the bottom instead. It draws the thumb rather than
  mirroring a native scrollbar into a second scroll container, because a native
  thumb is invisible wherever the platform uses overlay scrollbars — the strip
  would be an empty band until you were already scrolling, which is the one thing
  a "you can scroll sideways here" affordance must not be. It also means the
  thumb shows up in a screenshot, so `games-sticky-scroll` can assert on it.
  `sticky` is defeated by a clipping or scrolling ancestor, so the component
  renders its own wrapper — pass the surface class (`card`) to it rather than
  nesting it inside one.
- **A phone-width flex row shrinks whatever has an `auto` basis, and a `flex-1`
  child has a basis of 0.** So the item you meant to be flexible absorbs none of
  the shortfall and the fixed-size ones absorb all of it (a 48 px avatar renders
  32×48 at 320 px while the name beside it clips). Two habits follow — give an
  intrinsically-sized child (avatar, icon, badge) `shrink-0` so it cannot pay for
  a shortfall that is not its to pay, and stack the row on phones
  (`flex-col sm:flex-row`, full-width action) so there is no shortfall to
  distribute. `NewGamesBanner` and `PlayerCard` (`OnboardingPage.tsx`) are both
  this shape. **`mobile-audit` cannot catch this class of bug**: shrinking is how
  flex *avoids* overflow, so document width never exceeds window width and the
  audit reports zero. Distortion needs its own assertion — `onboarding-mobile`
  checks the avatar is still square and the name still unclipped.
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
  mate (any game end) > brilliant > check > capture > move
  (`classifyMoveSound`). `Board` drives them off `(fen, lastMoveUci)` rather than
  the user's drag, so one hook covers user moves, engine replies, autoplay and
  history stepping; it's opt-in per board (`sounds`) because the same component
  draws silent preview thumbnails. The on/off preference lives in localStorage,
  not the synced `Settings` row, because it's read synchronously inside a move
  handler and is a per-device question.

## Deployment

Cloudflare Pages builds from `main` via its own GitHub integration, so deploys
do **not** depend on GitHub Actions and nothing gates them. See `DEPLOY.md`.

**The build command must be `npm run build`, never a bare `vite build`.** The
`prebuild` hook (`copy-nnue.mjs --mode=production`) is where the NNUE rules of
§ NNUE are enforced: it fails the build on a malformed `VITE_NNUE_NET_URL`, and
on a Cloudflare Pages build (`CF_PAGES`) with no URL set, since a 38.3 MiB net
would exceed the 25 MiB asset cap. With the committed `.env.production` the net
is served from R2, so `prebuild` stages nothing and deletes any copy left in
`public/stockfish/` by an earlier `npm run dev` — Vite copies `public/` into
`dist/` verbatim, and a leftover would breach the cap. Only a same-origin build
(URL unset, a host without that cap) stages the net. Skipping `prebuild` leaves
just `nnueNetBuildGuard`, which strips a stray net from `dist/` in remote mode
and only *warns* otherwise. To verify a production build, `dist/stockfish/` must
hold **no** `nn-*.nnue`, and `npm run nnue:upload -- --verify-only` checks the
remote net is reachable with CORS.

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
make the engine files (and, on a same-origin host, the 40 MB net) and the 18 MB
corpus one-time costs. The CORP lines on those routes are defensive: a
same-origin `fetch` passes the check either way. `vite.config.ts` mirrors these
headers in dev.

The Chrome extension ships separately:
`npm run extension:build -- --coach-origin=https://<host>` stamps the production
origin into `options.js` only (`content.js` keeps its localhost dev default on
purpose). The options page seeds that origin into `chrome.storage` on first
load, because `storage.sync.get` defaults are read-only and never persisted
until the user presses Save.

Its deep link's `endTime` is the **click time**, a hint rather than the game's
end (the page exposes none), so `importGameByUrl` scans the hinted, current and
previous months and, only when all miss, up to `MAX_WIDENED_MONTHS` (24) older
months from the player's archive index — an old game opened from the archive
would otherwise never be found. Daily games keep the `/game/daily/<id>` shape
end to end: their ids are a separate number space, so rewriting one to
`/game/live/<id>` names a live game that may not exist. See
`extension/README.md`.

## Open items

Known, unfixed, and worth picking up. Remove an entry when it is done.

- **Extension 0.3.1 is not published.** The manifest (name "Chess Coach: Review
  After Game"; Review counts as handling the game; daily URLs kept) is ahead of the
  Web Store listing. Rebuild the zip and submit: DEPLOY.md § 9 (9b/9c),
  `extension/README.md`.
- **`cloud_analyses` rows the worker wrote before it used `toCloudAnalysis` have
  NULL `recompute_version`.** They heal without intervention: NULL reads as
  vintage 0, so any sync from a device whose local copy is stamped outranks it in
  `isBetter` and pushes the column; after a restore the recompute pass stamps any
  pulled row below 4, and the same push follows. No backfill is worthwhile: one
  restricted to images with `RECOMPUTE_VERSION ≥ 3` could only claim 3 (column
  and `data->recomputeVersion` together), still below the current 4, so those
  rows would be reclassified and re-pushed anyway.
- **Repertoires created in the wrong colour before `familyColor`'s current rules
  are not migrated.** Nothing re-derives a stored repertoire's colour.
- **Motif detection gaps** (`engine/motifs.ts`): `isKingUnsafe` (`weakKing`)
  counts attacked king-adjacent squares via `attackersOf`, a move list, so a pawn
  push onto an empty square counts as an attack (and a pawn's diagonal does not);
  `pinSkewerLines` ignores a skewer with the king in front (`first.type !== 'k'`).
- **Openings readers replay a set-up-position game as if from the standard
  start**: `buildPersonalOpeningStats` (`openings/recommendations.ts`) and
  `uciFromPgn` (`openings/identifyFromGame.ts`) key the set-up game's moves as
  standard-start prefixes, and `EngineCockpit`'s fallback board replays them on
  `new Chess()`.
- **Accuracy model residual**: reads ~5 high where Chess.com scores below 60
  (§ Engine, calibration).
- **Each worker deploy adds a Secret Manager version of the `service_role` key**
  (five at last count; six active versions are free). Old versions can be
  destroyed: `scripts/worker/README.md` § Cost, and a guard.
- **`public/_headers` sets no `Content-Security-Policy`.** A hardening gap; a
  policy has to admit the R2 net origin and the Clerk and Supabase endpoints.
- **`TIERS` in `scripts/build-puzzles.mjs` and `PUZZLE_TIERS` in the manifest are
  vestigial** (only the build's band report reads them; the page serves no tiers).
  Drop them on the next corpus rebuild.
- **Puzzle solver eval-bar tooltip**: while solving, the deliberately neutral bar
  still titles itself "Engine thinking…" (`EvalBar`'s no-label fallback), which
  implies an engine is running.
