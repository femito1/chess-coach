# Architecture notes

Load-bearing invariants: the rules this codebase breaks quietly rather
than loudly if you violate them, and enough reasoning to know when a
change is about to violate one. Read the relevant entry before touching
its area; the code comments at each site are the detailed version, this is
the map.

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
A task holding an index across a shrink therefore clears the wrong slot —
or one past the end of the array — stranding its own slot as permanently
busy. That leaks a worker, pins `isIdle()` false so the WASM heap is never
freed, and eventually has `pump()` call `.analyze()` on `undefined`, which
surfaces as a game erroring for no visible reason. Pinned by
`pool-shrink-desync.mjs`.

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
The same single walk also accumulates per-prefix win/draw/loss (from
`Game.result`, already stored from the user's perspective), so a winrate
signal costs nothing extra — add any further per-game derivation to that
walk rather than a second pass. The practice page computes it once in
`PracticeRunner` and threads it down; never build it twice on one page.

**The generated bundle must stay coherent with its TSV inputs.** If
`openings.generated.ts` is built from a different
`data/openings/line-popularity.tsv` than the one committed beside it,
every frequency-derived number (opening suggestions, difficulty tiers) is
silently wrong — the data still looks plausible, so nothing surfaces it.
Because `scripts/build-openings.mjs` is offline over committed inputs, a
unit test (`src/data/openings.generated.test.ts`) rebuilds the bundle in
memory and fails if it differs from the committed file, ignoring only the
timestamped banner line; `buildBundle()` is the pure seam it calls. **If
that test fails, run `npm run openings:build` and commit the result** —
never edit the bundle by hand.

Never let the two halves be regenerated separately: refresh the TSV and
rebuild the bundle in the same change. `.github/workflows/openings-refresh.yml`
does this monthly and pushes to `main` only after a plausibility gate,
`typecheck` and `test:unit` all pass. Verify-before-push is load-bearing,
because Cloudflare Pages deploys from `main` on its own webhook rather
than through Actions — anything that lands ships immediately. It gates on
unit rather than e2e so a single known-failing e2e test cannot freeze data
refreshes.

**The guided set must never resolve to nothing drillable.** Active line
keys are *library* lines, and `guidedLineIndices` matches a key only
against a repertoire line that equals or **extends** it. A repertoire
whose lines are shallower than its recommendations therefore matches
nothing — hold just the 5-ply Italian mainline and every top-5
recommendation is a 6+ ply continuation of it — which would leave the
drill page with an empty session and no board to practise on. Which lines
rank top-5 shifts with every opening-data refresh, so treat this as live
rather than hypothetical: `PracticePage` calls `drillableGuidedIndices`,
which falls back to the repertoire's own lines (capped at the guided
starter size). Pinned in `curriculum.test.ts` — keep that guard when
touching the guided flow.

**The drill picker merges repertoire and library, keyed by
`openingLineKey`.** `buildPickerModel` (`repertoire/pickerModel.ts`) unions
`enumerateLines` (what you can drill) with `getVariations` (what you could
add), per family. A library variation counts as in-repertoire when a
repertoire leaf *extends* it — not just on exact match — because
bulk-imported trees store full leaves; and when drilling one, it points at
the *shortest* matching leaf, the same reasoning as
`curriculum.guidedLineIndices`. Difficulty tiers (`openings/difficulty.ts`)
are pure and family-relative: scores are absolute, but the Easy/Medium/Hard
cut is by terciles of each family's own distribution (fixed thresholds for
families with < 3 lines), so "Hard" means hard *for that opening*.

**A frequency is only trusted within `MEASURED_PARENT_DEPTH`.** The
snapshot (`scripts/snapshot-opening-popularity.mjs`) queries the explorer
down to a parent depth recorded in the TSV header
(`measuredParentDepth=`); beyond it, a line's `globalGames`/`globalShare`
is the nearest measured ancestor scaled by a `0.82^n` decay. That estimate
falls monotonically with ply, so it is *not* a rarity measurement —
treating it as one would count depth twice and rebuild the very
ply-sorted ordering the difficulty tiers exist to replace. The build
propagates that depth into the bundle as `MEASURED_PARENT_DEPTH` +
`isMeasuredLine(line)`; `difficulty.ts` drops the rarity term (and the
forced/rare chip) for an estimated line, and the Learn panel refuses to
quote a frequency for one (`trustworthyShare`). Running the snapshot at
full depth (the default now — `--depth=N` caps it) makes the header read
`full`, `isMeasuredLine` true for every line, and rarity a real signal: a
28-ply *forced* line then has a high share (not rare) while a short
offbeat line has a low one. Because `MEASURED_PARENT_DEPTH` changes with
each data refresh, code that branches on it takes an injectable predicate
in tests (`scoreLine(line, stats, isMeasured)`) rather than hard-coding
the current depth.

## Openings data refresh

`.github/workflows/openings-refresh.yml` re-snapshots monthly (and on
manual dispatch) and pushes regenerated data to `main`, but only after a
gauntlet: snapshot → `openings:build` → a plausibility gate (row count and
non-zero-row count vs the committed TSV, to catch a proxy answering junk
with HTTP 200) → `typecheck` → `test:unit`. It commits only if the
data-bearing lines actually changed (both artifacts carry generated
timestamps, so a byte diff would churn every run). Verify-before-push is
load-bearing: Cloudflare Pages deploys from `main` on its own webhook, not
through Actions, so anything that lands ships. The snapshot script and the
loop share an **exit-code contract** — `0` wrote the TSV, `3` means the
cache is still incomplete (resume), anything else is a hard failure — so
"incomplete" is never mistaken for "complete but unchanged". The explorer
cache is persisted across runs with `actions/cache/save@v4` under
`if: always()` (the default `@v4` post-step only saves on success, which
would discard every rate-limited run's progress). It gates on unit rather
than e2e so a known-failing e2e test cannot freeze data refreshes.

To refresh by hand, expect it to take a while: the unauthenticated proxy
throttles at roughly 24 requests/minute and a full-depth snapshot needs
~2 300 parent positions, so run it in small batches
(`--concurrency=1 --delay=1500 --max=300`) and re-run to resume — the cache
makes each attempt compound, and the script exits `3` while work remains.
Setting a `LICHESS_TOKEN` hits Lichess directly and skips the proxy's
limits entirely.

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
- Move sounds (`audio/moveSounds.ts`) are **synthesized** with Web Audio,
  not sampled: chess.com's audio files are their copyright, and generating
  the cues costs no bundle weight and no first-move network request. Swap in
  samples by changing `playMoveSound` alone — callers only ever name a
  `MoveSoundKind`. Each cue is a struck knock — contact noise plus a damped
  pitched body and one inharmonic partial, all starting on the same frame.
  *Stacking* simultaneous components is what gives weight; *sequencing* them
  is what read as doubled sounds, so nothing is scheduled late except the
  `brilliant` flourish, which is deliberately a three-note arpeggio.
  Castling and promotion are plain moves; `brilliant` comes from
  `lastMoveClassification`, and precedence runs mate > brilliant > check >
  capture > move. `Board` drives them off `(fen, lastMoveUci)` rather than
  the user's drag, so one hook covers user moves, engine replies, autoplay
  and history stepping; it's opt-in per board (`sounds`) because the same
  component draws silent preview thumbnails. The on/off preference lives in
  localStorage, not the synced `Settings` row, because it's read
  synchronously inside a move handler and is a per-device question.

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
