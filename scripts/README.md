# Headless tests

These are ad-hoc Playwright scripts that drive a real Chromium against the dev
server to exercise the engine / queue end-to-end. They're the closest thing to a
real smoke test for the parts of the app that aren't easy to unit-test
(Stockfish WASM, IndexedDB, queue orchestration).

Requirements:

```bash
npx playwright install chromium
```

Run one of:

```bash
# Engine-only: loads both Stockfish workers and confirms UCI handshake.
node scripts/test-engine.mjs

# Engine + analyzer module with a synthetic game.
node scripts/test-analyze.mjs

# Inserts a game row, waits for the background queue to process it.
node scripts/test-full-queue.mjs

# Simulates a stuck "worker error" row from an older session and verifies
# the self-heal path requeues and completes it.
node scripts/test-heal.mjs

# Live: hits Chess.com API, imports 3 real games, runs full analysis.
#   URL=http://localhost:5173/ USER_CC=magnuscarlsen node scripts/test-live-chesscom.mjs
node scripts/test-live-chesscom.mjs
```

All scripts assume the dev server is running. Override the URL with `URL=...`
if your Vite server picked a different port.
