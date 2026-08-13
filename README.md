# Chess Coach

A personal chess improvement app. Imports your Chess.com games, runs Stockfish analysis in the background, and gives you a clean review UI with an eval graph and classified moves (blunder / mistake / inaccuracy).

Everything runs in the browser. No backend, no server, no account. Your data stays in IndexedDB on your machine.

## What it does

- **Import + analyse** — pull your Chess.com games, analyse them in the background with Stockfish, and read the result as an eval graph with mistakes and blunders called out.
- **Coaching from your own games** — mistake patterns aggregated across games, puzzles generated from your blunders, and win-rate by opening family on the dashboard alongside rating and accuracy trends.
- **Openings Library** — ~3,700 named lines from the Lichess `chess-openings` dataset (MIT). Browse by family/variation, preview any line, add a single line or a whole family to a repertoire.
- **Repertoire drilling** — family-bound repertoires with SM-2 spaced repetition, and "play it out vs Stockfish" from the end of any line.
- **Learn-then-drill with difficulty tiers** — the drill page lists every library line for the openings you play, marks the ones already in your repertoire, and tiers each **Easy / Medium / Hard**: family-relative, blending line depth, master-level frequency, and your own win/draw/loss record in that variation. Add lines in place, filter by tier, and **Learn** a line first — step through it with the next move hidden, guess it on the board (nothing is scored), then hand straight into drilling that same line.
- **Chrome extension** (`extension/`) — detects the end of a Chess.com game and offers a one-click deep link into your review. Build with `npm run extension:build -- --coach-origin=<url>`.

## Stack

- React + Vite + TypeScript
- [chessground](https://github.com/lichess-org/chessground) + [chess.js](https://github.com/jhlywa/chess.js)
- [Stockfish 16](https://github.com/nmrugg/stockfish.js) compiled to WASM, run in a Web Worker
- [Dexie](https://dexie.org/) over IndexedDB for persistence
- Tailwind CSS

## Running locally

```bash
npm install
npm run dev
```

Then open the URL Vite prints (usually `http://localhost:5173`).

On first launch:
1. Go to **Import** and enter your Chess.com username.
2. Pick the months you want to import.
3. Games start analyzing automatically in a background Web Worker. Watch progress in the header.
4. Open **Games** and click **Review** on any game.

## Keyboard shortcuts

- `←` / `→` — step through moves
- `Home` / `End` — jump to start / end

## Contributing

- [`ARCHITECTURE.md`](ARCHITECTURE.md) — data model, boot-time version
  stamps, engine pool, the openings data pipeline, the two opening-naming
  systems, UI conventions. Read the relevant entry before touching the
  analysis queue, a boot pass, the openings data, or anything that maps a
  game to an opening: these are the rules the codebase breaks quietly
  rather than loudly.
- [`DEPLOY.md`](DEPLOY.md) — Cloudflare Pages + GitHub Actions setup.
- [`SETUP_AUTH.md`](SETUP_AUTH.md) — Clerk + Supabase env vars.

### Tests

```bash
npm run typecheck && npm test    # the gate before pushing

npm run test:unit         # vitest — pure logic, no browser
npm run test:integration  # browser + Stockfish + IndexedDB, synthetic data
npm run test:e2e          # browser, drives the real UI
npm run test:live         # hits the live Chess.com API — on demand only
```

The browser tiers need `npm run dev` running in another terminal.
`scripts/test/manifest.mjs` is the catalog of every browser test; add new
ones there and use `runBrowserTest()` from `scripts/test/harness.mjs`.
Unit tests must not import Dexie, Web Workers, chessground or Stockfish —
see the conventions comment in `vitest.config.ts`.

Everything should pass in CI. One exception: `mobile-audit` fails on some
local setups while passing in CI, so confirm against CI before chasing it.

## Self-hosting

`npm run build` produces a static `dist/` folder. Serve it with any static file server (nginx, Caddy, `python -m http.server`, GitHub Pages, etc.).

For full-strength Stockfish (multi-threaded WASM), the serving origin must be cross-origin isolated:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

The Vite dev server sets these automatically. On GitHub Pages (which can't set custom headers) the app falls back to a single-threaded Stockfish build that still works, just slower.

## Roadmap

- **Opening prep-gap detection** — detailed below; the next thing to build.
- **Endgame trainer** built on the Lichess Syzygy tablebase.
- **Pre-game prep** — scout an opponent's openings before you play them.
- **Position annotations** — your own notes, recalled across games.

### Next up: opening prep-gap detection

Surface the openings you *lose* to but haven't prepped — e.g. "you've lost
8 of 11 in the Advance Variation and it isn't in your repertoire" — turning
your own game history into a prioritized study list. `repertoire/gaps.ts`
already walks games against a repertoire tree to find out-of-book points;
the missing half is ranking those gaps by how much they cost you and
offering the fix as lines to learn.

### Refreshing the openings database

The library is generated from the Lichess chess-openings TSVs committed
under `data/openings/`, plus a line-popularity snapshot from the Lichess
opening explorer. A scheduled job
(`.github/workflows/openings-refresh.yml`) re-snapshots monthly and pushes
the regenerated data to `main` only after typecheck + unit tests pass, so
you normally don't touch this. To refresh by hand:

```bash
# 1. (optional) re-measure line popularity at full depth. Slow and
#    rate-limited; resumes from .cache if interrupted. Set LICHESS_TOKEN
#    to hit Lichess directly and skip the proxy's limits.
node scripts/snapshot-opening-popularity.mjs

# 2. (optional) pull upstream chess-openings updates: download the latest
#    a.tsv..e.tsv into data/openings/, then rebuild.
node scripts/build-openings.mjs
```

`build-openings.mjs` regenerates `src/data/openings.generated.ts` from the
committed TSVs; commit the result. A unit test
(`openings.generated.test.ts`) fails if the committed bundle ever drifts
out of sync with its inputs — if it's red, run `npm run openings:build`.
