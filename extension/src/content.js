/**
 * Chess Coach — Review After Game (content script)
 *
 * Watches the chess.com tab for finished-game pages. When the user
 * lands on one, injects a small floating panel offering a one-click
 * "Review in Chess Coach" CTA that opens the deep link in a new tab.
 *
 * Loads on every chess.com page (manifest match `https://www.chess.com/*`)
 * and short-circuits inside `maybePrompt()` until the URL is a
 * finished-game URL.
 *
 * Detection strategy: we use the **URL itself** as the signal.
 * Chess.com only mints a numeric game id once the game is finished
 * — live games in progress sit at `/play/online` (no id in the URL).
 * The moment the URL contains a numeric game id under any of the
 * known finished-game URL shapes (see `currentGameId`), we prompt.
 *
 * This was a rewrite of an earlier DOM-heuristic approach that tried
 * to detect specific result-modal class names. That approach kept
 * regressing every time chess.com refactored its markup, and worse,
 * it missed the historical-game case entirely — opening any past
 * game from the archive renders no live "game over" UI but is still
 * a perfectly valid moment to offer a Chess Coach review. The URL
 * is both more reliable and cheaper to evaluate.
 *
 * Behaviour contract:
 *   - Every navigation to a finished-game URL prompts (modulo a
 *     same-page-visit dismissal, see below).
 *   - If the user dismisses the prompt for game A, we don't re-show
 *     it for A on this page visit. But if they navigate away and
 *     back, or to game B, the prompt fires again.
 *   - The moment the URL transitions away from a finished-game URL
 *     (typically the user starting a new game → `/play/online`), we
 *     hide whatever panel is currently on screen.
 *
 * Diagnostics: every meaningful state change is logged with the
 * `[chess-coach]` prefix, so a user reporting "the prompt didn't
 * appear" can open DevTools and read what the script saw.
 */

const LOG_PREFIX = '[chess-coach]';
const log = (...args) => console.log(LOG_PREFIX, ...args);
const warn = (...args) => console.warn(LOG_PREFIX, ...args);

const STATE = {
  /**
   * Game URL that's currently being prompted for. We use this only to
   * avoid re-injecting an identical panel on every heartbeat tick — it
   * is NOT a "never prompt this URL again" flag. Cleared on navigation
   * away from the game and on user dismissal so the next finished
   * game (or a re-visit of the same one in a fresh navigation) prompts
   * fresh.
   */
  activePromptUrl: /** @type {string | null} */ (null),
  /**
   * Game URL the user explicitly dismissed on the *current* page
   * visit. Distinct from `activePromptUrl` so we know not to re-show
   * the panel for the rest of this visit, but we still reset on URL
   * change (so the next finished game we land on prompts again).
   */
  dismissedUrl: /** @type {string | null} */ (null),
  panelEl: /** @type {HTMLElement | null} */ (null),
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
  STATE.activePromptUrl = null;
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

  const onDismiss = () => {
    log('user dismissed prompt for', gameUrl);
    STATE.dismissedUrl = gameUrl;
    hidePanel();
  };
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
    if (force) warn('manual trigger ignored: not on a finished-game URL');
    return;
  }
  const url = canonicalGameUrl(id);

  // Manual force trigger from the toolbar action — bypass every gate.
  if (force) {
    STATE.dismissedUrl = null;
    STATE.activePromptUrl = url;
    void showPanel(url);
    return;
  }

  // Already showing for this exact URL — nothing to do (heartbeat
  // tick after the panel was injected). Cheap early exit.
  if (STATE.activePromptUrl === url && STATE.panelEl) return;

  // User dismissed the panel for this URL during the current page
  // visit. Respect that — don't re-nag. The dismiss flag is cleared
  // on URL change, so finishing the next game (or revisiting any
  // other game) prompts fresh.
  if (STATE.dismissedUrl === url) return;

  // The page URL itself is the signal: chess.com only mints a numeric
  // game id once the game is finished (live games in progress sit at
  // `/play/online` with no id in the URL until completion). Skipping
  // the brittle DOM heuristic means we no longer miss prompts when
  // chess.com refactors its result-modal markup, and we now also fire
  // on archive revisits of historical games (no live modal renders
  // there but the user explicitly navigated to a finished game and
  // wants the option to review it).
  STATE.activePromptUrl = url;
  void showPanel(url);
}

/**
 * Drive detection from an SPA-aware URL watcher.
 *
 * Chess.com is a SPA: navigating between games is a `pushState`, not
 * a full reload, so a single content-script lifetime can see many
 * `/play/online` ↔ `/game/<id>` transitions. The watcher polls
 * `location.href` every 750 ms; on each transition we hide any
 * lingering panel, clear the dismissal flag, and fire a fresh
 * prompt-check. URL-only detection means we don't need a
 * MutationObserver — the URL itself tells us whether we're on a
 * finished-game page.
 *
 * We also fire once on script load to cover the cold-load case where
 * the user lands directly on a finished-game URL (refresh, deep link
 * from the archive, or a tab re-open).
 */
function start() {
  if (STATE.started) return;
  STATE.started = true;

  log('content script loaded on', location.href);

  const fire = () => {
    try {
      maybePrompt();
    } catch (e) {
      warn('detection error', e);
    }
  };

  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      log('navigation detected →', lastUrl);
      STATE.dismissedUrl = null;
      hidePanel();
      fire();
    }
  }, 750);

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
