# Chess Coach

A personal chess improvement app. Imports your Chess.com games, runs Stockfish analysis in the background, and gives you a clean review UI with an eval graph and classified moves (blunder / mistake / inaccuracy).

Everything runs in the browser. No backend, no server, no account. Your data stays in IndexedDB on your machine.

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

## Self-hosting

`npm run build` produces a static `dist/` folder. Serve it with any static file server (nginx, Caddy, `python -m http.server`, GitHub Pages, etc.).

For full-strength Stockfish (multi-threaded WASM), the serving origin must be cross-origin isolated:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

The Vite dev server sets these automatically. On GitHub Pages (which can't set custom headers) the app falls back to a single-threaded Stockfish build that still works, just slower.

## Roadmap

Phase 1: Chess.com import, background analysis, eval graph, blunder highlighting, backup/restore.

Phase 2: mistake pattern aggregation across games, personalized puzzles from your blunders, opening repertoire with SM-2 spaced repetition, repertoire gap analysis.

Phase 3 (this version):
- **Openings Library** preloaded with ~3,700 named lines from the Lichess `chess-openings` dataset (MIT). Browse by family/variation, preview any line, and one-click add individual lines or a whole family into a repertoire.
- **Progress charts** on the dashboard: rating trend per time class, accuracy over time (per-game + 20-game rolling avg), and win-rate by opening family.
- **Board polish**: Chess.com-style right-click drag arrows (with L-shaped paths for knight moves), right-click red square highlights, and faster piece movement (animation trimmed and suppressed on user-initiated moves).

Planned (Phase 4+): endgame trainer (Lichess Syzygy), pre-game prep (opponent scouting), Chrome extension to deep-link games from chess.com, position annotations / "memory palace" across games.

### Refreshing the openings database

The library is generated from the Lichess chess-openings TSVs committed under `data/openings/`. To pull in upstream updates:

```bash
# Download the latest TSVs, overwriting data/openings/*.tsv, then:
node scripts/build-openings.mjs
```

This regenerates `src/data/openings.generated.ts`. Commit the result.
