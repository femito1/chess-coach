# Scripts

Two kinds of scripts live here:

1. **Test scripts** under `scripts/test/{integration,e2e,live}/`. Managed by the unified runner.
2. **Build / data scripts** (`build-openings.mjs`, `check-errors.mjs`, etc).

## Tests — start here

The single source of truth for the test system is **`TESTING.md`** at the repo root. Read it before adding or changing tests. Quick reference:

```bash
npm test                  # default: unit + integration (requires `npm run dev` for integration)
npm run test:unit         # vitest only — pure logic, no browser
npm run test:integration  # browser scripts with synthetic data
npm run test:e2e          # browser scripts driving the real UI
npm run test:live         # browser scripts hitting the live Chess.com API
npm run test:all          # everything (slow, CI-style)
npm run test:watch        # vitest in watch mode
```

Run a single browser-driven script by name:

```bash
node scripts/run-tests.mjs --only=eval-cache
node scripts/run-tests.mjs --only=knight-arrow-toggle
```

Names come from `scripts/test/manifest.mjs`. See `TESTING.md` for the full catalog and conventions.

### Layout

- `scripts/run-tests.mjs` — single entry point (categories: unit, integration, e2e, live).
- `scripts/test/harness.mjs` — shared Playwright bootstrap, `runBrowserTest()`, `expect()`, polling helpers. Every browser script uses it.
- `scripts/test/manifest.mjs` — registry of every browser-driven script and its category.
- `scripts/test/integration/*.mjs` — synthetic-data browser tests.
- `scripts/test/e2e/*.mjs` — real-UI browser tests.
- `scripts/test/live/*.mjs` — Chess.com-API-dependent browser tests.
- `src/**/*.test.ts` — Vitest unit tests next to source.

### Requirements

For any browser category (integration / e2e / live):

```bash
npx playwright install chromium   # one-time
npm run dev                       # leave it running on :5173
```

Override the URL with `URL=http://localhost:5174/` if your dev server is elsewhere. Override the Chess.com username for live tests with `USER_CC=...`.

## Other scripts

Every one of these has an `npm run` alias; prefer the alias so lifecycle hooks
and paths stay right.

| script | alias | what it does |
|---|---|---|
| `copy-nnue.mjs` | `nnue:stage` | Stages Stockfish's 38.3 MiB NNUE network into `public/stockfish/`, **unless `VITE_NNUE_NET_URL` is set** — then it skips staging (and removes a stale copy), because production serves the net from an object store. Runs automatically as `predev` / `prebuild`; **not** for a bare `npx vite`, which skips lifecycle scripts. Fails the build if `node_modules` ships a different net than `NNUE_NET_FILE` in `src/engine/nnue.ts`, or if `VITE_NNUE_NET_URL` is unusable. |
| `upload-nnue.mjs` | `nnue:upload` | Uploads the net to R2 via `wrangler`, then verifies over HTTP that a browser could load it (status, size, content-type, `Access-Control-Allow-Origin`). `-- --verify-only` skips the upload. Exits non-zero on anything that would send the app back to the classical evaluator. See DEPLOY.md § The NNUE network. |
| `nnue-net-config.mjs` | — | Not a script: the shared build-side answer to "which net, served from where". Imported by `copy-nnue.mjs`, `upload-nnue.mjs` and the `nnueNetBuildGuard` plugin in `vite.config.ts` so all three agree — including when `VITE_NNUE_NET_URL` lives only in `.env.local`, which npm does not put in `process.env`. |
| `build-openings.mjs` | `openings:build` | Regenerates `src/data/openings.generated.ts` from `data/openings/*.tsv`. Commit the result; a unit test fails if the two drift. |
| `snapshot-opening-popularity.mjs` | `openings:snapshot` | Re-measures line popularity from the Lichess explorer. Slow and rate-limited; resumable, and exits `3` while work remains. |
| `build-puzzles.mjs` | `puzzles:build` | Rebuilds the puzzle corpus into `public/puzzles/<buildId>/` + `src/data/puzzles.meta.generated.ts`. Needs `.cache/lichess_db_puzzle.csv.zst` and `zstd`. Deletes stale build dirs. |
| `build-extension.mjs`, `build-extension-icons.mjs` | `extension:build` | Builds the Chrome extension zip into `dist-extension/`. |
| `screenshot-extension.mjs` | `extension:screenshots` | Regenerates the extension's store screenshots. |
| `worker/build.mjs` | `worker:build` | esbuilds `scripts/worker/{main,verify}.ts` into `dist-worker/`. |
| `worker/verify.ts` | `worker:verify` | Proves a native Stockfish binary matches the browser's evals and that NNUE is really loaded. **Run before any bulk worker run.** |
| `worker/main.ts` | `worker:run` | The off-laptop analysis worker. See `scripts/worker/README.md`. |
| `check-errors.mjs` | — | Ad-hoc DB diagnostic. |

Data-pipeline rationale and traps live in `ARCHITECTURE.md`; the worker has its
own `README.md` in `scripts/worker/`.
