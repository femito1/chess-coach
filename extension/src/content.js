/**
 * Chess Coach — Review After Game (content script)
 *
 * Watches the chess.com tab for completed games. A game URL is necessary
 * but not sufficient: chess.com now assigns numeric URLs while play is
 * still in progress, so we wait for a visible result/game-over signal.
 *
 * Loads on every chess.com page (manifest match `https://www.chess.com/*`)
 * and short-circuits inside `maybePrompt()` until both gates pass.
 *
 * Detection strategy: recognized URL + layered, visible DOM evidence.
 * A MutationObserver catches the result UI mounting without a URL change;
 * the URL heartbeat still handles chess.com's SPA navigation. Historical
 * completed games expose the same result/review controls, so they prompt
 * too. The toolbar action bypasses the DOM gate as a safety valve.
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
  detectionTimer: /** @type {ReturnType<typeof setTimeout> | null} */ (null),
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
 * Find chess.com's numeric game id from the current URL. A matching URL can
 * represent either an in-progress or completed game; completion is a
 * separate DOM gate below.
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

const COMPLETION_SELECTORS = [
  '.game-over-modal-content',
  '[class*="game-over" i]',
  '.game-result',
  '[class*="game-result" i]',
  '[data-game-result]',
  '[data-test-element*="game-result" i]',
];

const RESULT_TEXT_RE =
  /(?:^|\s)(?:1\s*-\s*0|0\s*-\s*1|1\s*\/\s*2\s*-\s*1\s*\/\s*2|½\s*-\s*½)(?:\s|$)|\b(?:game\s+over|checkmate|stalemate|draw|you\s+won|you\s+lost)\b/i;
const POST_GAME_ACTION_RE = /^(?:game\s+review|review|rematch)$/i;

function isVisible(el) {
  if (!(el instanceof HTMLElement)) return false;
  if (el.hidden || el.getAttribute('aria-hidden') === 'true') return false;
  const style = getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
    return false;
  }
  return el.getClientRects().length > 0;
}

/**
 * Require visible post-game evidence so a numeric `/game/<id>` URL at
 * move one cannot trigger the prompt. Selectors are intentionally layered:
 * dedicated game-over containers are sufficient by themselves; generic
 * result containers must contain a result token; post-game action buttons
 * cover completed archive pages whose result text lives in a shadow/root
 * that the content script cannot inspect.
 */
function hasCompletedGameSignal() {
  for (const selector of COMPLETION_SELECTORS) {
    for (const el of document.querySelectorAll(selector)) {
      if (!isVisible(el)) continue;
      if (selector.includes('game-over')) return true;
      if (RESULT_TEXT_RE.test(el.textContent ?? '')) return true;
    }
  }

  for (const el of document.querySelectorAll('button, a[role="button"]')) {
    if (!isVisible(el)) continue;
    const label = (el.textContent || el.getAttribute('aria-label') || '')
      .replace(/\s+/g, ' ')
      .trim();
    if (POST_GAME_ACTION_RE.test(label)) return true;
  }
  return false;
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

function buildDeepLink(coachOrigin, username, gameUrl, endTime = Date.now()) {
  const params = new URLSearchParams();
  params.set('url', gameUrl);
  if (username) params.set('username', username);
  params.set('endTime', String(endTime));
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
  log('showing prompt for', gameUrl);

  const root = ensurePanel();
  const closeBtn = root.querySelector('.cc-close');
  const primary = root.querySelector('.cc-primary');
  const secondary = root.querySelector('.cc-secondary');

  const onDismiss = () => {
    log('user dismissed prompt for', gameUrl);
    STATE.dismissedUrl = gameUrl;
    hidePanel();
  };
  if (closeBtn) closeBtn.onclick = onDismiss;
  if (secondary) secondary.onclick = onDismiss;
  if (primary) primary.onclick = () => {
    // Capture the lookup hint at the user's click, not when the panel first
    // appeared. This is especially important for long-open archive tabs.
    const link = buildDeepLink(coachOrigin, username, gameUrl, Date.now());
    log('opening review for', gameUrl, '→', link);
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
  };
}

function maybePrompt({ force = false } = {}) {
  const id = currentGameId();
  if (!id) {
    if (force) warn('manual trigger ignored: not on a recognized game URL');
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

  if (!hasCompletedGameSignal()) return;

  STATE.activePromptUrl = url;
  void showPanel(url);
}

function schedulePromptCheck() {
  if (STATE.detectionTimer) clearTimeout(STATE.detectionTimer);
  STATE.detectionTimer = setTimeout(() => {
    STATE.detectionTimer = null;
    try {
      maybePrompt();
    } catch (e) {
      warn('detection error', e);
    }
  }, 100);
}

/**
 * Drive detection from an SPA-aware URL watcher plus a debounced DOM
 * observer. The observer is required because a live game can keep the same
 * numeric URL from the first move through the result modal.
 *
 * Chess.com is a SPA: navigating between games is a `pushState`, not
 * a full reload, so a single content-script lifetime can see many
 * `/play/online` ↔ `/game/<id>` transitions. The watcher polls
 * `location.href` every 750 ms; on each transition we hide any
 * lingering panel, clear the dismissal flag, and fire a fresh check.
 *
 * We also fire once on script load to cover the cold-load case where
 * the user lands directly on a finished-game URL (refresh, deep link
 * from the archive, or a tab re-open).
 */
function start() {
  if (STATE.started) return;
  STATE.started = true;

  log('content script loaded on', location.href);

  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      log('navigation detected →', lastUrl);
      STATE.dismissedUrl = null;
      hidePanel();
      schedulePromptCheck();
    }
  }, 750);

  const observer = new MutationObserver(() => schedulePromptCheck());
  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['class', 'style', 'hidden', 'aria-hidden'],
  });

  schedulePromptCheck();
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
