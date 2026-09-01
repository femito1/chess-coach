# Chess Coach

A personal chess improvement app. Imports your Chess.com games, analyses them
with Stockfish 16 in the browser, and turns the result into a review UI, a
dashboard, an openings repertoire you can drill, and a puzzle trainer.

Local-first: games, analyses and progress live in IndexedDB on the device.
There is no application server. Sign-in (Clerk) is required to reach the app,
and an opt-in Supabase mirror can back the data up — see
[Cloud sync](#cloud-sync).

## What it does

| Area | Route | Summary |
|---|---|---|
| Import | `/import` | Pull Chess.com games by month; queue them for analysis. |
| Games | `/games` | The library, filtered/paged; accuracy and brilliancy badges. |
| Review | `/review/:id` | Eval graph, per-move classification (blunder / mistake / inaccuracy / miss / good / best / brilliant / book), motifs, clock use, play-it-out vs Stockfish. |
| Dashboard | `/dashboard` | Rating + accuracy trends, win rate by opening family, **prep gaps** (openings you lose in that aren't in a repertoire), study cards. |
| Puzzles | `/puzzles` | 191,250 vetted puzzles from the Lichess open DB (CC0). Tabs: Recommended / Easy / Medium / Hard / All. |
| Openings | `/openings` | ~3,700 named lines (Lichess `chess-openings`, MIT). Browse by family, preview, add lines or a whole family to a repertoire. |
| Repertoire | `/repertoire` | Family-bound repertoires; SM-2 spaced repetition (`/repertoire/:id/train`). |
| Drill | `/repertoire/:id/drill` | Repertoire ∪ library lines in one picker, tiered Easy / Medium / Hard (family-relative), with a **Learn** active-recall step that hands straight into drilling that same line. |
| Settings | `/settings` | Per-device engine + sound preferences, NNUE toggle, cloud-sync status. |

Two things run outside the page:

- **Chrome extension** (`extension/`) — detects the end of a Chess.com game and
  offers a one-click deep link into your review. Build with
  `npm run extension:build -- --coach-origin=<url>`; see DEPLOY.md §9.
- **Off-laptop analysis worker** (`scripts/worker/`) — native Stockfish on a box
  you provision, feeding results back through cloud sync. It is **code, not a
  running service**. See `scripts/worker/README.md`.

## Stack

React 18 + Vite + TypeScript · [chessground](https://github.com/lichess-org/chessground)
+ [chess.js](https://github.com/jhlywa/chess.js) ·
[Stockfish 16](https://github.com/nmrugg/stockfish.js) WASM in Web Workers
(NNUE on by default; in production the net is served from R2 — see below) ·
[Dexie](https://dexie.org/) over IndexedDB ·
Clerk (auth) + Supabase (optional mirror) · Tailwind · i18next · Recharts.

## Running locally

```bash
npm install     # also needed for the Stockfish NNUE net (see below)
npm run dev
```

**The three auth env vars are mandatory.** `src/lib/env.ts` throws at module
load if any is missing, so the app will not boot without them. Copy
`.env.example` to `.env.local` and fill it in (`SETUP_AUTH.md` walks through
obtaining the values).

To boot without real credentials, pass structurally-valid fakes inline. The
Clerk key must decode — `ClerkProvider` base64-decodes it and throws otherwise,
which error-boundaries the whole router:

```bash
VITE_CLERK_PUBLISHABLE_KEY=pk_test_bG9jYWwuY2xlcmsuYWNjb3VudHMuZGV2JA== \
VITE_SUPABASE_URL=https://local.invalid \
VITE_SUPABASE_ANON_KEY=sb_publishable_local_verify \
VITE_E2E_AUTH_BYPASS=true npx vite --port 5173 --strictPort
```

Two caveats. `npx vite` skips npm lifecycle scripts, so it does **not** stage
the NNUE net — run `npm run nnue:stage` first or every eval silently falls back
to the classical evaluator. And the auth bypass is dev-only
(`import.meta.env.MODE !== 'development'` disables it), so a production build
cannot be driven this way.

First run: **Import** → enter your Chess.com username → pick months. Analysis
starts automatically in a background worker pool; watch the header indicator.

Keyboard: `←`/`→` step through moves, `Home`/`End` jump to start/end.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server (`predev` stages the NNUE net). |
| `npm run build` | `tsc -b && vite build` (`prebuild` stages the NNUE net). |
| `npm run typecheck` | `tsc -b --noEmit`. |
| `npm run nnue:stage` | Copy Stockfish's 38.3 MiB NNUE net into `public/stockfish/`. Skipped when `VITE_NNUE_NET_URL` is set. |
| `npm run nnue:setup` | One-shot R2 setup via `wrangler`: bucket, public access, CORS, upload, verify, and write `VITE_NNUE_NET_URL` to `.env.production`. `-- --dry-run` shows the commands. Needed because Pages can't serve a 38.3 MiB asset — see DEPLOY.md. |
| `npm run nnue:upload` | Just the upload + verify half. `-- --verify-only` checks a live bucket without uploading. |
| `npm test` | Unit + integration (the default gate). |
| `npm run test:unit` / `:integration` / `:e2e` / `:live` / `:all` | Test tiers — see `TESTING.md`. |
| `npm run test:watch` | Vitest watch mode. |
| `npm run puzzles:build` | Rebuild the puzzle corpus shards. Needs a 304 MB download; see ARCHITECTURE.md § Puzzles. |
| `npm run openings:build` | Regenerate `src/data/openings.generated.ts` from the committed TSVs. |
| `npm run openings:snapshot` | Re-measure line popularity from the Lichess explorer (slow, rate-limited). |
| `npm run worker:build` / `worker:verify` / `worker:run` | Off-laptop analysis worker. **Always `worker:verify` before a bulk run.** |
| `npm run worker:deploy` | Deploy the worker as a scheduled Cloud Run job so analysis happens automatically and off your laptop. `-- --dry-run` shows every command. See `scripts/worker/README.md`. |
| `npm run extension:build` | Build the Chrome extension zip. |
| `npm run extension:screenshots` | Regenerate the extension's store screenshots. |
| `npm run preview` | Serve a built `dist/`. |

## NNUE, and where the network comes from

The engine runs Stockfish's NNUE evaluator by default, in production as well as
locally — but the 38.3 MiB network reaches the browser from a different place in
each case.

- **Locally**, `predev`/`prebuild` stage it out of `node_modules` into
  `public/stockfish/` and it is served same-origin. The net is gitignored; `npm
  install` supplies it.
- **In production**, Cloudflare Pages refuses any single asset over 25 MiB, so
  the net cannot live in `dist/` on that host — permanently, not as a
  misconfiguration to be fixed. It is served from an R2 bucket instead, with
  `VITE_NNUE_NET_URL` in `.env.production` pointing the app there. Setting that
  variable also makes `prebuild` **skip** staging, so the deployed `public/`
  stays under the cap.

Two things that look like faults and are not:

- In production, `/stockfish/nn-*.nnue` on the app's own origin answers with
  SPA-fallback HTML. The net is deliberately not there.
- **Preview deploys run the classical evaluator.** The bucket's CORS policy
  allows only the production hostname and `http://localhost:5173`, while preview
  builds get per-branch hostnames. Pass `--origin=` to `npm run nnue:setup` to
  add one.

If the net fails to load for any other reason, a `HEAD` probe catches it and the
engine falls back to classical with a console warning instead of dying —
Stockfish 16 `exit()`s at the first `go` when `Use NNUE` is on and no net
arrived, so that probe is load-bearing. Analyses record which evaluator produced
them (`stockfish-16-nnue` / `stockfish-16-classical`), and cloud sync ranks the
evaluator **above** depth: a deeper classical search is a weaker judge looking
further, not a better analysis.

The real cost of NNUE is memory, not bandwidth — ~340 MB RSS per engine worker
against ~125 MB classical — so the pool shrinks on low-memory devices and
Settings carries a per-device toggle.

`npm run nnue:upload -- --verify-only` checks the live bucket end to end. Run it
after any bucket change and after any Stockfish upgrade, since the net's
filename carries its own hash and a stale object then 404s under the new name.
DEPLOY.md § "The NNUE network and the 25 MiB asset cap" and ARCHITECTURE.md
§ NNUE have the rest.

## Cloud sync

Optional, and gated **per account by a row in the Supabase
`cloud_sync_allowlist` table, enforced in RLS**. There is no in-app enrolment;
enrol from the Supabase dashboard (`SETUP_AUTH.md` §5). Unenrolled accounts
run fully local and the Settings card stays hidden.

It mirrors games, analyses and puzzle attempts as an accumulating archive.
Read ARCHITECTURE.md § Cloud sync before changing anything in
`src/features/sync/` — three ordering rules there are load-bearing.

## Docs

| File | Contents |
|---|---|
| `ARCHITECTURE.md` | The invariants map: data model, boot passes, engine + NNUE, puzzles, openings, cloud sync, UI conventions. **Read the relevant entry before touching its area** — these are the rules the codebase breaks quietly rather than loudly. |
| `TESTING.md` | Test tiers, how to add a browser test, known-failing tests, and the traps that produce false passes. |
| `DEPLOY.md` | Cloudflare Pages + GitHub Actions, deploy verification, rollback, troubleshooting, extension distribution. |
| `SETUP_AUTH.md` | Clerk + Supabase setup, env vars, cloud-sync enrolment (§5). |
| `scripts/worker/README.md` | The off-laptop analysis worker: the scheduled Cloud Run deployment, env, run order, costs. |
| `scripts/README.md` | Script inventory and the browser-test entry points. |

Every doc above is in the repo. Code comments point only at these files — if you
find a pointer to something absent, it is a bug in the comment, not a doc you are
missing.

## Self-hosting

`npm run build` produces a static `dist/`. Serve it with any static file
server, but two response-header groups are load-bearing and shipped as
`public/_headers` (Cloudflare Pages format; Netlify reads the same file,
Vercel needs a `vercel.json`):

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Without cross-origin isolation there is no `SharedArrayBuffer`, and the engine
falls back to the single-threaded Stockfish build — **~11× slower at NNUE**
(measured 9.7 s vs 110 s on the same game at depth 18), not a mild degradation.
Settings surfaces a warning when that happens.

The second group is `Cache-Control: immutable` on `/stockfish/*` and
`/puzzles/*`, which makes the 38.3 MiB NNUE net and the 18 MB puzzle corpus a
one-time cost per device. The third is `no-store` on the SPA document **for every
route** — `_headers` matches the request path, not the SPA-rewritten one, so a
host that only no-stores `/` will serve stale bundles on `/games`, `/settings`
and the rest. `src/app/routeHeaders.test.ts` guards the list.

Self-hosting somewhere without a per-asset size cap is the one case where the
NNUE net can just live in `dist/`: leave `VITE_NNUE_NET_URL` unset and
`prebuild` stages it. Cloudflare Pages caps assets at 25 MiB and therefore
cannot — see DEPLOY.md § The NNUE network.

`public/_redirects` provides the SPA fallback. Read the comments in all three
files before editing them.

## Regenerating committed data

Two datasets are generated and committed. Both have a unit test that fails if
the committed artifact drifts from its inputs, so a red test here means "run
the build", not "fix the test".

- **Openings** — `npm run openings:build` rebuilds `src/data/openings.generated.ts`
  from `data/openings/*.tsv`. `.github/workflows/openings-refresh.yml` does this
  monthly and pushes to `main`. ARCHITECTURE.md § Openings data refresh.
- **Puzzles** — `npm run puzzles:build` rebuilds `public/puzzles/<buildId>/`
  and `src/data/puzzles.meta.generated.ts`. ARCHITECTURE.md § Puzzles.
