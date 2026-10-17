# Chess Coach: Review After Game (browser extension)

A small Manifest V3 (Chromium) extension that watches Chess.com for the end
of a live game and offers a one-click "Review in Chess Coach" prompt that
deep-links into the local Chess Coach app.

## How it works

The extension runs a content script on `https://www.chess.com/*` pages.
It requires both a recognized game URL and visible post-game evidence (a
result, "Game Over" UI, or a post-game CTA) before injecting a small floating
card. This matters because Chess.com can assign `/game/<id>` at move one;
the URL alone does not mean the game is finished. Clicking **Review** opens
a new tab pointing at:

```
<coach-origin>/review-by-url?url=<chesscom-game-url>&username=<your-username>&endTime=<ms>
```

…which is handled by the `ImportAndReviewPage` route in the Chess Coach
app. That route imports the single game from the user's monthly archive,
queues analysis, and redirects to `/review/<id>`. See
`src/features/import/auto.ts → importGameByUrl` and
`src/features/import/ImportAndReviewPage.tsx` on the app side.

`endTime` is a **hint, taken at the click** — the Chess.com page exposes no
reliable end time. For a game just finished that is the right month; for one
opened from the archive months later it is not, so the app does not trust it
alone. Chess Coach first scans the month containing the hint plus the current
month and the previous one, and only when all three miss does it walk the
player's other archives from Chess.com's own index, newest first, **at most
24** more (`MAX_WIDENED_MONTHS` in `src/features/import/urlShape.ts`). That
keeps the common click to one or two fetches, bounds a wrong username (which
can never hit) to a couple of years of fetches, and still avoids a "scan back
to 2007" worst case.

Live games are sent as `/game/live/<id>` whichever URL shape the page used,
because the importer tries an exact URL match against the archive before
falling back to the numeric id. Daily (correspondence) games keep their own shape:
daily ids are a separate number space — a daily id can equal some live game's
id — so the content script sends `/game/daily/<id>` unchanged. Rewriting it to
`/game/live/<id>` would miss the archive's exact match and name a live game that
may not exist. The app likewise only varies a daily URL into the daily shape.

## Install (development)

1. Build / run Chess Coach locally (`npm run dev` in the repo root).
2. Open `chrome://extensions`.
3. Enable **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the `extension/` folder of this
   repo.
5. The extension's options page opens automatically. Fill in:
   - **Chess.com username** — tells the deep link whose archive to fetch.
     Left blank, the content script falls back to the username in the
     Chess.com page's markup.
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

That writes `dist-extension/chess-coach-<version>.zip` (`--output=` overrides
the path), with `DEFAULT_COACH_ORIGIN` in `options.js` rewritten to your
production URL. Recipients Load Unpacked from the unzipped folder; the options
page opens on install and saves that origin to storage, so they only have to
enter their Chess.com username. `content.js` keeps its own localhost default,
which is why the origin has to reach storage. What the build script does is in
`DEPLOY.md § 9b`.

**Existing install (already loaded unpacked).** Open the extension's
options page and edit the **Chess Coach URL** field to point at your
production origin. Click **Test connection** to verify it's
reachable; this triggers a one-time browser permission prompt asking
you to grant the extension fetch access to that origin. Then **Save**.
Nothing else has to change — the deep link is constructed at click
time from whatever's in storage.

The Chrome Web Store path is documented in the repo root
`DEPLOY.md § 9c`; `WEB_STORE_LISTING.md` here has the copy-paste answers for
the store form.

## Files

- `manifest.json` — MV3 manifest (version 0.3.1). Permissions are minimal: `storage`
  (for the username + URL config) and host access only on
  `https://www.chess.com/*`.
- `src/content.js` — runs on chess.com pages, detects end-of-game,
  injects the prompt, builds the deep link.
- `src/content.css` — styles for the floating card.
- `src/background.js` — service worker that opens the deep link in a
  new tab on click, opens the options page on first install, and handles
  the toolbar action (see Troubleshooting).
- `src/options.html` / `src/options.js` — the options UI.

## Detection notes

Chess.com renames CSS class names regularly, so the content script combines
a recognized numeric game URL with layered visible DOM signals:

1. **Primary:** `.game-over-modal-content` or another visible `game-over`
   container, the dedicated post-game modal. Sufficient on its own.
2. **Secondary:** a visible `game-result` / `data-game-result` element
   containing `1-0`, `0-1`, `1/2-1/2`, or result language such as
   "checkmate" or "draw". This covers completed historical games too.
3. **Tertiary:** a visible button labelled "Game Review", "Review", or
   "Rematch", for completed pages whose result text the content script
   cannot inspect.

A debounced (100 ms) `MutationObserver` catches game-over UI that appears
while the numeric URL stays unchanged. A URL watcher polling every 750 ms
handles SPA navigation between games: on each change it hides any panel,
clears the dismissal and checks again. The toolbar action bypasses the DOM gate on a
recognized game URL if Chess.com ships new markup before the extension is
updated.

The content script also dedupes per game URL so the prompt appears once
per page visit even if chess.com re-mounts its modal (e.g. after clicking
"Game Review" inline); navigating away and back prompts again. Clicking
**Review** counts as handling the prompt, exactly like dismissing it: the
game-over modal is still on screen, so otherwise the panel's own removal would
wake the observer and re-show the prompt ~100 ms after the click.

## Troubleshooting

**The prompt didn't appear after I finished a game.**

1. Open DevTools (F12) on the chess.com tab and switch to the Console
   panel. The content script logs everything it does with the
   `[chess-coach]` prefix — including which page it loaded on,
   navigation events, and detection failures. If you don't see a
   `content script loaded on …` line, the extension isn't running on
   the tab; try reloading the page.
2. **Manual trigger:** click the extension's toolbar icon while on a
   game URL (any shape in step 3). That sends a `forcePrompt` message
   to the content script which bypasses the auto-detection heuristic
   and the dismissal, and shows the prompt. Useful when chess.com has
   refactored the modal class names and the heuristic needs an update.
   On a non-chess.com tab, or one where the content script is not
   loaded, the icon opens the options page instead.
3. The prompt only shows when the page URL matches a game shape
   (`/game/<id>`, `/game/live/<id>`, `/live/game/<id>`, or
   `/game/daily/<id>`) and the page exposes a visible completion signal.
4. Verify the **enabled** checkbox in the options page is on. With it off
   the content script logs that detection fired and does not prompt.

## Privacy

The extension stores **only** what the options page holds (your
chess.com username, the Chess Coach origin URL and the enabled toggle) in
`chrome.storage.sync`. No telemetry, no analytics. Its only network
request is **Test connection**, which fetches the Chess Coach origin you
entered after you grant that one host; the deep link itself is a tab
navigation.
