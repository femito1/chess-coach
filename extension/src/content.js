/**
 * Chess Coach — Review After Game (content script)
 *
 * Watches the chess.com tab for the end-of-game state. When detected,
 * injects a small floating panel offering a one-click "Review in Chess
 * Coach" CTA that opens the deep link in a new tab.
 *
 * Loads on every chess.com page (manifest match `https://www.chess.com/*`)
 * and short-circuits inside `start()` until the URL becomes a live-game
 * URL. This is more robust than narrow URL match patterns because
 * chess.com sometimes resolves the post-game UI before the page URL
 * transitions to the canonical `/game/live/<id>` shape.
 *
 * Detection strategy (defensive — chess.com renames classes regularly):
 *   1. PRIMARY: `.game-over-modal-content` — the dedicated modal that
 *      pops up after a finished game. This selector has been stable
 *      enough that other long-lived userscripts (e.g. wintrcat-uk) rely
 *      on it as their sole hook.
 *   2. SECONDARY: any visible element whose class string contains
 *      `game-over` (case-insensitive).
 *   3. TERTIARY: a button labelled "Game Review" or "Rematch" that's
 *      currently in the DOM (the post-game CTAs).
 * Any of (1)/(2)/(3) is enough to fire.
 *
 * The panel dedupes per game URL: once shown for a given game, we
 * don't re-inject it (chess.com re-mounts the modal sometimes when
 * the user clicks "Game Review" inline).
 *
 * Diagnostics: every meaningful state change is logged with the
 * `[chess-coach]` prefix, so a user reporting "the prompt didn't
 * appear" can open DevTools and read what the script saw — far more
 * useful than a silent script.
 */

const LOG_PREFIX = '[chess-coach]';
const log = (...args) => console.log(LOG_PREFIX, ...args);
const warn = (...args) => console.warn(LOG_PREFIX, ...args);

const STATE = {
  lastPromptedUrl: /** @type {string | null} */ (null),
  panelEl: /** @type {HTMLElement | null} */ (null),
  observer: /** @type {MutationObserver | null} */ (null),
  started: false,
};

const DEFAULT_COACH_ORIGIN = 'http://localhost:5173';

async function getOptions() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(
      { coachOrigin: DEFAULT_COACH_ORIGIN, chesscomUsername: '', enabled: true },
      (items) => resolve(items),
    );
  });
}

/**
 * Find chess.com's numeric game id from the current URL. Returns
 * undefined if the page is not a finished-game page.
 *
 * Chess.com has shipped *three* URL shapes for finished games at
 * different points in 2024–2026:
 *   - `/game/live/<id>`   (legacy)
 *   - `/live/game/<id>`   (some archive-API responses)
 *   - `/game/<id>`        (current live-game shape, observed
 *                          2026-05-08 by user diagnostic console)
 *   - `/game/daily/<id>`  (correspondence games)
 *
 * We accept all of them; the chess-coach app's importer
 * (`extractChessComGameId` in `src/features/import/urlShape.ts`)
 * mirrors this list and falls back to numeric-id matching against
 * the monthly archive, so whichever shape the page gives us still
 * resolves to the right Game.id at the chess-coach end.
 *
 * Order of alternatives matters: the more-specific patterns
 * (`game/live/<id>`, `live/game/<id>`, `game/daily/<id>`) come
 * before the bare `game/<id>` so we never mis-extract. We also
 * insist on a hostname / start anchor so a future page like
 * `/game-explorer/123` can't accidentally trip the regex.
 */
function currentGameId() {
  const m = location.href.match(
    /chess\.com\/(?:game\/live\/|live\/game\/|game\/daily\/|game\/)(\d+)(?:\b|\/|$)/,
  );
  return m?.[1];
}

/**
 * Canonicalise the game URL to the shape we want to send into the
 * deep link. We deliberately keep the legacy `/game/live/<id>` form
 * here even though the page URL we're reading is the newer
 * `/game/<id>` shape: that's what chess.com's published-data API
 * (`/pub/player/{u}/games/{year}/{month}`) has historically returned
 * in its `url` field, and the chess-coach importer compares URLs
 * for an exact match first before falling back to numeric-id
 * matching. Passing the canonical form maximises the chance of an
 * exact-match hit.
 *
 * If chess.com flips the API to also use the bare `/game/<id>`
 * shape, this constant flips with it; the importer's numeric-id
 * fallback covers the transition window without any code change.
 */
function canonicalGameUrl(id) {
  return `https://www.chess.com/game/live/${id}`;
}

/**
 * Robust visibility check that — unlike `el.offsetParent !== null` —
 * works for `position: fixed` elements (chess.com's modal containers
 * are typically fixed-positioned, which makes `offsetParent` null
 * even when they're plainly visible on screen).
 */
function isVisible(el) {
  if (!el || !(el instanceof Element)) return false;
  const style = getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
    return false;
  }
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

/**
 * True when the page currently shows a post-game modal/UI. See the
 * file header for the heuristic priority list.
 *
 * Note: each layer is independent — any one is enough. The user-
 * provided diagnostic on 2026-05-08 showed that chess.com had moved
 * to a single `class="game-result"` element on the finished-game
 * page (no `game-over*` class anywhere in the DOM at that point),
 * which is why the original `game-over`-only heuristic missed every
 * real finished game. The selectors below now cover both the
 * `game-over*` and `game-result*` lineages so we ride out either
 * markup style.
 */
function isGameOverShowing() {
  // Primary: the dedicated modal class. Long-lived userscripts pin
  // their detection to this selector and it has survived multiple
  // chess.com refactors.
  const modal = document.querySelector('.game-over-modal-content');
  if (modal && isVisible(modal)) return true;

  // Secondary: any visible `game-over*` OR `game-result*` element.
  // The 2026-05-08 chess.com refactor dropped the `game-over`
  // ancestor entirely and just kept a `game-result` chip inline on
  // the finished-game page; the OR here covers both worlds.
  const candidates = document.querySelectorAll(
    '[class*="game-over" i], [class*="game-result" i], [class*="game-finished" i]',
  );
  for (const el of candidates) {
    if (isVisible(el)) return true;
  }

  // Tertiary: the post-game CTAs. We *don't* require a result chip
  // alongside (an earlier version did, which was the cause of "I
  // finished a game but it didn't pop up" — chess.com had refactored
  // the result chip out of the markup we were watching for, so the
  // and-clause silently rejected every detection).
  const buttons = document.querySelectorAll('button, a');
  for (const b of buttons) {
    const txt = (b.textContent || '').trim().toLowerCase();
    if (
      txt === 'game review' ||
      txt === 'rematch' ||
      txt === 'new game' ||
      txt === 'play again'
    ) {
      if (isVisible(b)) return true;
    }
  }
  return false;
}

/**
 * Try to read the chess.com username from the page DOM as a fallback
 * for users who haven't filled in the option. Looks at a few stable-ish
 * places that have survived multiple chess.com refactors.
 */
function detectUsernameFromDom() {
  const meta = document.querySelector('meta[name="user"]');
  if (meta) {
    const v = meta.getAttribute('content');
    if (v && v.trim()) return v.trim();
  }
  const tag = document.querySelector('[data-username]');
  if (tag) {
    const v = tag.getAttribute('data-username');
    if (v && v.trim()) return v.trim();
  }
  return '';
}

function buildDeepLink(coachOrigin, username, gameUrl) {
  const params = new URLSearchParams();
  params.set('url', gameUrl);
  if (username) params.set('username', username);
  params.set('endTime', String(Date.now()));
  return `${coachOrigin.replace(/\/$/, '')}/review-by-url?${params.toString()}`;
}

function ensurePanel() {
  if (STATE.panelEl && document.body.contains(STATE.panelEl)) return STATE.panelEl;
  const root = document.createElement('div');
  root.id = 'chess-coach-prompt';
  root.innerHTML = `
    <div class="cc-card" role="dialog" aria-label="Review this game in Chess Coach">
      <div class="cc-header">
        <div class="cc-title">Review in Chess Coach?</div>
        <button class="cc-close" aria-label="Dismiss">×</button>
      </div>
      <div class="cc-body">
        Send this game to your local Chess Coach app for analysis.
      </div>
      <div class="cc-actions">
        <button class="cc-primary">Review</button>
        <button class="cc-secondary">Not now</button>
      </div>
    </div>
  `;
  document.body.appendChild(root);
  STATE.panelEl = root;
  return root;
}

function hidePanel() {
  if (STATE.panelEl) {
    STATE.panelEl.remove();
    STATE.panelEl = null;
  }
}

async function showPanel(gameUrl) {
  const opts = await getOptions();
  if (!opts.enabled) {
    log('detection fired but extension is disabled in options; not prompting');
    return;
  }

  const username = (opts.chesscomUsername || detectUsernameFromDom() || '').trim();
  const coachOrigin = (opts.coachOrigin || DEFAULT_COACH_ORIGIN).trim();
  const link = buildDeepLink(coachOrigin, username, gameUrl);

  log('showing prompt for', gameUrl, '→', link);

  const root = ensurePanel();
  const closeBtn = root.querySelector('.cc-close');
  const primary = root.querySelector('.cc-primary');
  const secondary = root.querySelector('.cc-secondary');

  const onDismiss = () => hidePanel();
  closeBtn?.addEventListener('click', onDismiss);
  secondary?.addEventListener('click', onDismiss);
  primary?.addEventListener('click', () => {
    // Service worker opens the tab — slightly more reliable than
    // window.open from a content script when popup blockers are in
    // play. Fall back to window.open if messaging fails.
    try {
      chrome.runtime.sendMessage({ type: 'openCoachReview', url: link }, () => {
        if (chrome.runtime.lastError) {
          window.open(link, '_blank', 'noopener');
        }
      });
    } catch (_e) {
      window.open(link, '_blank', 'noopener');
    }
    hidePanel();
  });
}

function maybePrompt({ force = false } = {}) {
  const id = currentGameId();
  if (!id) {
    if (force) warn('manual trigger ignored: not on a live-game URL');
    return;
  }
  const url = canonicalGameUrl(id);
  if (!force && STATE.lastPromptedUrl === url) return;
  if (!force && !isGameOverShowing()) return;
  STATE.lastPromptedUrl = url;
  void showPanel(url);
}

/**
 * Drive detection from a coalesced MutationObserver + a low-frequency
 * heartbeat. Chess.com's modal often mounts via React after a network
 * round-trip, so observing alone occasionally races; the heartbeat
 * makes detection eventually-consistent without hammering the page.
 */
function start() {
  if (STATE.started) return;
  STATE.started = true;

  log('content script loaded on', location.href);

  let scheduled = false;
  const fire = () => {
    scheduled = false;
    try {
      maybePrompt();
    } catch (e) {
      warn('detection error', e);
    }
  };
  STATE.observer = new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(fire, 250);
  });
  STATE.observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
  // Heartbeat — every 1.5 s, cheap. Does nothing if the panel is
  // already showing (deduped via `lastPromptedUrl`).
  setInterval(fire, 1500);

  // Reset the dedupe state on URL changes (chess.com is an SPA;
  // navigating to the next game is a pushState, not a full reload).
  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      log('navigation detected →', lastUrl);
      STATE.lastPromptedUrl = null;
      hidePanel();
    }
  }, 750);

  // Fire once on script load — covers the case where the user
  // reloaded the page on a finished-game URL and the modal is
  // already in the DOM by `document_idle`.
  fire();
}

// Listen for manual triggers from the extension's toolbar action /
// popup. Lets the user force-show the prompt if auto-detection
// silently fails for whatever reason — diagnostic safety valve.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'forcePrompt') {
    log('manual trigger received from background');
    maybePrompt({ force: true });
    sendResponse({ ok: true, gameId: currentGameId() ?? null });
    return true;
  }
  return false;
});

start();
