# Chess Coach — Review After Game (browser extension)

A small Manifest V3 (Chromium) extension that watches Chess.com for the end
of a live game and offers a one-click "Review in Chess Coach" prompt that
deep-links into the local Chess Coach app.

## How it works

The extension runs a content script on `https://www.chess.com/*` pages.
When a post-game state is detected (the chess.com "Game Over" overlay or one
of the post-game CTA buttons), the script injects a small floating card in
the bottom-right corner of the page asking whether to send the game to
Chess Coach. Clicking **Review** opens a new tab pointing at:

```
<coach-origin>/review-by-url?url=<chesscom-game-url>&username=<your-username>&endTime=<ms>
```

…which is handled by the `ImportAndReviewPage` route in the Chess Coach
app. That route imports the single game from the user's monthly archive,
queues analysis, and redirects to `/review/<id>`. See
`src/features/import/auto.ts → importGameByUrl` and
`src/features/import/ImportAndReviewPage.tsx` on the app side.

The deep link is bounded — Chess Coach scans **at most three** monthly
archives (the month containing the `endTime` hint plus the current month
plus the previous one) before giving up. This keeps the per-click cost
predictable and avoids a "scan back to 2007" worst case.

## Install (development)

1. Build / run Chess Coach locally (`npm run dev` in the repo root).
2. Open `chrome://extensions`.
3. Enable **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the `extension/` folder of this
   repo.
5. The extension's options page opens automatically. Fill in:
   - **Chess.com username** — required for the deep link to know whose
     archive to fetch.
   - **Chess Coach URL** — defaults to `http://localhost:5173`. Set this
     to your production URL if you've deployed Chess Coach to e.g.
     Cloudflare Pages.
6. Open Chess.com and play a game. When it ends, the prompt appears in
   the bottom-right corner.

## Production install

Two paths depending on how you're distributing the extension.

**Side-load zip with the production URL baked in.** From the repo root:

```bash
npm run extension:build -- --coach-origin=https://your-prod-host.example.com
```

That writes `dist-extension/chess-coach-<version>.zip` to the repo
root, with `DEFAULT_COACH_ORIGIN` in `options.js` rewritten to your
production URL. Recipients Load Unpacked from the unzipped folder
and the extension comes pre-configured — they only have to enter
their Chess.com username on first run.

**Existing install (already loaded unpacked).** Open the extension's
options page and edit the **Chess Coach URL** field to point at your
production origin. Click **Test connection** to verify it's
reachable; this triggers a one-time browser permission prompt asking
you to grant the extension fetch access to that origin. Then **Save**.
Nothing else has to change — the deep link is constructed at click
time from whatever's in storage.

The Chrome Web Store path is documented in the repo root
`DEPLOY.md § 9c`.

## Files

- `manifest.json` — MV3 manifest. Permissions are minimal: `storage`
  (for the username + URL config) and host access only on
  `https://www.chess.com/*`.
- `src/content.js` — runs on chess.com pages, detects end-of-game,
  injects the prompt, builds the deep link.
- `src/content.css` — styles for the floating card.
- `src/background.js` — service worker that opens the deep link in a
  new tab on click. Also opens the options page on first install.
- `src/options.html` / `src/options.js` — the options UI.

## Detection notes

Chess.com renames CSS class names regularly, so the content script
defensively layers three heuristics for "game is over" — any one is
enough to fire the prompt:

1. **Primary:** `.game-over-modal-content` is visible — the dedicated
   post-game modal. Long-lived userscripts pin their detection to this
   selector and it has survived multiple chess.com refactors.
2. **Secondary:** any visible element whose class string contains
   `game-over` (case-insensitive). Catches sub-pieces of the modal
   even if the wrapper class is renamed.
3. **Tertiary:** a visible button labelled "Game Review" or
   "Rematch".

The content script also dedupes per game URL so the prompt only
appears once per game even if chess.com re-mounts its modal (e.g.
after clicking "Game Review" inline).

## Troubleshooting

**The prompt didn't appear after I finished a game.**

1. Open DevTools (F12) on the chess.com tab and switch to the Console
   panel. The content script logs everything it does with the
   `[chess-coach]` prefix — including which page it loaded on,
   navigation events, and detection failures. If you don't see a
   `content script loaded on …` line, the extension isn't running on
   the tab; try reloading the page.
2. **Manual trigger:** click the extension's toolbar icon while on a
   `chess.com/game/live/<id>` URL. That sends a `forcePrompt` message
   to the content script which bypasses the auto-detection heuristic
   and shows the prompt unconditionally. Useful when chess.com has
   refactored the modal class names again and the heuristic needs an
   update.
3. The prompt only shows when the page URL matches a live-game shape
   (`/game/live/<id>`, `/live/game/<id>`, or `/game/daily/<id>`). If
   you're on `/play/online` and the game just ended but the URL
   hasn't transitioned yet, wait a second — chess.com usually
   rewrites the URL within a beat of the modal mounting.
4. Verify the **enabled** checkbox in the options page is on.

## Privacy

The extension stores **only** what you type into the options page (your
chess.com username and the Chess Coach origin URL) in
`chrome.storage.sync`. No telemetry, no analytics, no remote calls
beyond the deep-link redirect.
