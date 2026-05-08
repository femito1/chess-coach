const DEFAULT_COACH_ORIGIN = 'http://localhost:5173';

const $username = document.getElementById('username');
const $coach = document.getElementById('coachOrigin');
const $enabled = document.getElementById('enabled');
const $save = document.getElementById('save');
const $test = document.getElementById('test');
const $status = document.getElementById('status');

function load() {
  chrome.storage.sync.get(
    {
      coachOrigin: DEFAULT_COACH_ORIGIN,
      chesscomUsername: '',
      enabled: true,
    },
    (items) => {
      $username.value = items.chesscomUsername || '';
      $coach.value = items.coachOrigin || DEFAULT_COACH_ORIGIN;
      $enabled.checked = Boolean(items.enabled);
    },
  );
}

function setStatus(text, isError) {
  $status.textContent = text;
  $status.className = 'status' + (isError ? ' error' : '');
  if (text) {
    setTimeout(() => {
      $status.textContent = '';
      $status.className = 'status';
    }, 2400);
  }
}

function save() {
  const chesscomUsername = ($username.value || '').trim();
  const coachOriginRaw = ($coach.value || '').trim();
  const enabled = $enabled.checked;

  let coachOrigin = coachOriginRaw || DEFAULT_COACH_ORIGIN;
  // Strip trailing slash for canonical storage; the content script also
  // strips it when building the deep link, so saved values render the
  // same way no matter how the user typed them.
  coachOrigin = coachOrigin.replace(/\/$/, '');

  try {
    new URL(coachOrigin);
  } catch (_e) {
    setStatus('Coach URL is not a valid URL', true);
    return;
  }

  chrome.storage.sync.set(
    { chesscomUsername, coachOrigin, enabled },
    () => {
      if (chrome.runtime.lastError) {
        setStatus('Save failed: ' + chrome.runtime.lastError.message, true);
      } else {
        setStatus('Saved');
      }
    },
  );
}

/**
 * "Test connection" button. Verifies the configured Chess Coach
 * origin is reachable and looks like a Chess Coach deployment (the
 * index page response contains the app's marker title) before the
 * user finishes their first game and finds out the deep link 404s.
 *
 * Implementation:
 *   1. Validate URL shape locally — bail with a clear error if the
 *      user typed `chess-coach` without a protocol, etc.
 *   2. Request optional host permission for that origin via
 *      `chrome.permissions.request({ origins: [origin + '/*'] })`.
 *      Without this the fetch below would be blocked by the
 *      extension sandbox; with it, the user gets a one-time browser
 *      permission prompt naming the exact origin (good privacy
 *      surface — they see exactly which host we want to talk to).
 *   3. Fetch the origin's root and check the response status + body
 *      for an HTML payload containing "Chess Coach". If the response
 *      is unreachable, that's the most common failure mode (typo'd
 *      origin, dev server down) and the message says so.
 */
async function testConnection() {
  const raw = ($coach.value || '').trim().replace(/\/$/, '');
  if (!raw) {
    setStatus('Enter a URL first', true);
    return;
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch (_e) {
    setStatus('Not a valid URL', true);
    return;
  }
  setStatus('Testing…', false);

  // Request optional host permission for this exact origin. If the
  // user already granted it (e.g. from a previous Test click),
  // request() resolves to true without prompting.
  const originPattern = `${parsed.origin}/*`;
  let granted = false;
  try {
    granted = await chrome.permissions.request({ origins: [originPattern] });
  } catch (err) {
    setStatus('Permission request failed: ' + err.message, true);
    return;
  }
  if (!granted) {
    setStatus('Permission to fetch that origin was denied', true);
    return;
  }

  try {
    const res = await fetch(parsed.origin + '/', {
      method: 'GET',
      cache: 'no-cache',
      credentials: 'omit',
    });
    if (!res.ok) {
      setStatus(`Server returned HTTP ${res.status}`, true);
      return;
    }
    const body = await res.text();
    if (/chess[- ]?coach/i.test(body)) {
      setStatus('Connected ✓ (Chess Coach detected)', false);
    } else {
      // Reachable but doesn't look like Chess Coach — could be a
      // proxy, a 200 OK landing page, etc. Still useful info.
      setStatus('Reachable, but not recognised as Chess Coach', true);
    }
  } catch (err) {
    setStatus('Could not reach: ' + (err && err.message ? err.message : err), true);
  }
}

$save.addEventListener('click', save);
$test.addEventListener('click', testConnection);
document.addEventListener('DOMContentLoaded', load);
