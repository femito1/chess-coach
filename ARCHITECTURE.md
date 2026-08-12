# Architecture notes

Load-bearing invariants and the reasoning behind them. Everything here is
something that has already been broken at least once; the code comments at
each site are the detailed version, this is the map.

## Data model

Everything is client-side: Dexie over IndexedDB, no server. Tables that
matter: `games`, `analyses`, `repertoires`, `repertoireNodes`,
`repertoireCards`, `repertoireLineStats`, `settings` (single row, id
`main`).

**`games` carries denormalized fields derived from `analyses`.** Move
classifications live in `analyses`, keyed by game id. The Games table and
dashboard must not read that table per render — a 1 k-game library is
~2 MB of PGN and per-move data. So these are cached on the `Game` row:

| field | written by |
|---|---|
| `accuracy` | queue on analysis · recompute pass |
| `userTimeSec` / `userPlyCount` | queue on analysis · `backfillUserTimeStats` |
| `brilliantCount` | queue on analysis · recompute pass · `backfillBrilliantCounts` |

Adding another cached field means touching all of its writers, plus a
backfill for already-analyzed games. Distinguish `undefined` ("never
computed") from `0` ("computed, found none") — that difference is what
makes a backfill idempotent and a UI badge trustworthy.

**Read projections.** `listGamesLight()` strips `pgn`. Pages over the
`games` table should use it, plus `useThrottledLiveQuery` — an
un-throttled `useLiveQuery` refires on every analyzer write, which both
re-renders and busts downstream `useMemo`s.

## Boot-time passes and version stamps

`startAnalysisQueue()` runs housekeeping passes on boot, each gated by a
version stamped into `settings`. Two rules, both learned the hard way:

**Never bump `RECOMPUTE_VERSION` just to stamp a new field.**
`recomputeClassificationsAndAccuracies` re-runs `classifyMove` +
`detectMotifs` + `detectPhase` over every move of every analyzed game and
rewrites `analyses`. That is seconds-to-minutes of blocking main-thread
work; bumping it to add a cheap counter froze the app on reload for every
user. A field derivable from data already in `analyses` gets its own pass
with its own stamp — `backfillBrilliantCounts` (~10 ms for 40 games) is
the worked example. The expensive pass may *refresh* such a field as a
rider, but must never be the reason it runs.

**Version gates compare `>=`, not `===`.** A rolled-back version would
otherwise re-trigger the expensive pass on every DB that briefly saw the
higher number — re-freezing exactly the users a rollback is meant to
rescue. A DB carrying a newer stamp has already been through at least as
new a rule set. Pinned by `recompute-skip.mjs` phase 5.

## Engine

`EngineWorker` wraps one Stockfish WASM worker; `EnginePool` runs several.
The singleton `engine` export is for single-position consumers (live eval)
and is refcounted by `useLiveEval`; `analysisPool()` is for whole-game
analysis. Free-play uses its own separate worker so the opponent search
doesn't fight live eval.

**Pool slots are released by worker identity, never by captured index.**
`setMaxWorkers()` splices `workers`/`busy` (the visibility throttle calls
it when the tab hides), which renumbers every worker above a removed slot.
A task that captured index 2 and finished after a shrink used to clear
`busy[2]` past the end of the array, stranding its own slot as
permanently busy — which leaked a worker, made `isIdle()` permanently
false so the WASM heap was never freed, and eventually made `pump()` call
`.analyze()` on `undefined`, surfacing as a game that errored for no
reason. Pinned by `pool-shrink-desync.mjs`.

**`cancelAnalysis()` on the shared singleton kills whatever is running,
whoever started it.** `useLiveEval` only calls it once its consumer
refcount hits zero, so one idle consumer can't kill another's search.

**Pausing the queue does not abort the in-flight game.** The `paused`
check sits at the top of the run loop, so the current analysis finishes
and only the *next* game is withheld. The store still reports
`running: true` with a `currentGameId` while paused.

## Openings

The library (~3 700 lines, 148 families) is generated from the Lichess
`chess-openings` TSVs into `src/data/openings.generated.ts`.

**Two naming systems, reconciled by `resolveOpeningFamily`.** Library
names come from Lichess and keep punctuation and diacritics
("Caro-Kann Defense", "Réti Opening", "King's Gambit"). A game's `opening`
comes from Chess.com's ECO-URL slug via `parseOpeningFromEcoUrl`, which
flattens every hyphen to a space and carries no accents ("Caro Kann
Defense", "Reti Opening", "Kings Gambit"). Exact equality therefore fails
for ~24 families. `resolveOpeningFamily` folds both to a common key
(diacritics, apostrophes and all punctuation *and* whitespace stripped)
and resolves in three stages: exact; longest library family the input
extends (collapsing "Caro-Kann Defense: Advance Variation" to its
family); shortest family extending the input (for openings Chess.com names
plainly but Lichess only files under a qualified name — "Vienna Gambit"
has 15 lines, all under "Vienna Gambit, with Max Lange Defense").

Anything linking a chart row or a game to the library must pass through
it and link with the **canonical** name, or the openings page can't select
a family. Invariants pinned in `library.test.ts`: every one of the 3 690
lines resolves, none onto an unrelated opening, and every family resolves
to itself.

**`openingFamily()` splits the stored name on the first colon**, and the
importer only inserts one at the first
`Variation|Defense|Attack|Gambit|System|Opening` token. Slugs whose tail
*is* one of those words arrive unsplit as a single blob — which is why the
prefix stages above exist.

**Personal opening stats are expensive.** `buildPersonalOpeningStats`
re-parses every game's PGN through chess.js (~1.3 s at 2 500 games).
Compute one colour, and only once it is actually needed — not on mount.

## UI conventions

- `<html class="dark">` is a *Tailwind* convention and tells the browser
  nothing. Native chrome (scrollbars, `<select>` popups, date pickers,
  autofill) needs `color-scheme: dark`, declared once on `html` in
  `styles/index.css`. On Linux/GTK Chromium even that does not repaint the
  page scrollbar, so `html::-webkit-scrollbar*` is styled explicitly.
- A native `<select>`'s option popup inherits the **select's own**
  background, not its wrapper's. `bg-transparent` on a select renders a
  white menu.
- `BoardFrame` is the single source of primary-board sizing.
  `EVAL_BAR_WIDTH_PX` lives in `EvalBar` and both import it so the board
  stays at `PRIMARY_BOARD_MAX_PX` whether or not a bar is present.
- Tables over user data render a bounded page (see `PAGE_SIZE` in
  `GamesPage`). Filters and counts still run over the whole library; only
  the mounted row count is capped.

## Deployment

Cloudflare Pages builds from `main` via its own GitHub integration, so
deploys do **not** depend on GitHub Actions. See `DEPLOY.md`.

Two verification gotchas: Vite content hashes are not reproducible across
builds, so comparing a local `dist/` hash to the live one proves nothing —
grep the deployed asset for a string you added instead. And rollout is not
atomic; consecutive requests can hit old and new edges for a minute or
two, so check a few times before concluding.

The Chrome extension ships separately:
`npm run extension:build -- --coach-origin=https://<host>` stamps the
production origin into `options.js` only (`content.js` keeps its localhost
dev default on purpose). The options page seeds that origin into
`chrome.storage` on first load, because `storage.sync.get` defaults are
read-only and nothing was persisted until the user pressed Save.
