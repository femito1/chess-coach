/**
 * Chess Coach — Review After Game (service worker)
 *
 * Three responsibilities:
 *
 *   1. Receive `openCoachReview` messages from the content script and
 *      open the deep link in a new tab. Doing this from the service
 *      worker (rather than `window.open` in the content script) is
 *      slightly more robust — popup blockers sometimes treat
 *      content-script `window.open` as a synthetic popup, but
 *      `chrome.tabs.create` is exempt because it's an extension API.
 *
 *   2. On install, open the options page so the user can paste their
 *      Chess.com username and (optionally) override the Chess Coach
 *      origin from the localhost default.
 *
 *   3. Expose a manual-trigger entry-point on the toolbar action.
 *      When the user clicks the extension icon while on a chess.com
 *      tab that's currently showing a finished game, we send a
 *      `forcePrompt` message to the content script — useful as a
 *      diagnostic safety valve when auto-detection silently misses
 *      because chess.com refactored a class name. If the active tab
 *      isn't a chess.com tab, we open the options page instead so
 *      first-time users can configure the extension.
 */

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'openCoachReview' && typeof msg.url === 'string') {
    chrome.tabs
      .create({ url: msg.url, active: true })
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true; // keep the channel open for the async response
  }
  return false;
});

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    void chrome.runtime.openOptionsPage();
  }
});

chrome.action.onClicked?.addListener?.(async (tab) => {
  // No tab id (e.g. a discarded tab) → fall back to options.
  if (!tab?.id) {
    void chrome.runtime.openOptionsPage();
    return;
  }
  const url = tab.url || '';
  if (!/^https:\/\/www\.chess\.com\//.test(url)) {
    void chrome.runtime.openOptionsPage();
    return;
  }
  try {
    const res = await chrome.tabs.sendMessage(tab.id, { type: 'forcePrompt' });
    if (!res || !res.ok) {
      // Content script not loaded for some reason — open options as
      // a sensible fallback.
      void chrome.runtime.openOptionsPage();
    }
  } catch (_e) {
    // sendMessage throws when no listener is registered (i.e. content
    // script hasn't loaded on this tab yet). Same fallback.
    void chrome.runtime.openOptionsPage();
  }
});
