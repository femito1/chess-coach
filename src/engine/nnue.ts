/**
 * NNUE evaluation: the network file, the per-device opt-out, and the single
 * source of truth for "is NNUE actually going to be used".
 *
 * ── Why any of this exists ───────────────────────────────────────────────
 *
 * The bundled WASM Stockfish 16 ships `Use NNUE` defaulting to FALSE and no
 * network file — the `.wasm` payloads are 575–708 KB against a 40 MB net — so
 * every analysis this app produced before this module used Stockfish's
 * *classical* evaluator. That is a materially weaker judge of quiet positions.
 * Measured at depth 18 with identical UCI options:
 *
 *   rook endgame  `8/5R2/1p2P3/p4r2/P6p/1P3Pk1/4K3/8 b - - 1 64`
 *       classical +53 cp   ·   NNUE +377 cp     ("equal" vs "winning")
 *   queenless middlegame  `r4rk1/1bp2ppp/p1p5/4P3/2P5/2N5/PP3PPP/2KR3R b - - 1 16`
 *       classical -113 cp  ·   NNUE -296 cp
 *   forced mate   `r1bqkbnr/.../RNB1K1NR w KQkq - 4 4`
 *       both: mate 1                            (tactics agree; judgement doesn't)
 *
 * So the app now serves the net and turns NNUE on. Two UCI commands do it —
 * `EvalFile` then `Use NNUE true` — and Stockfish then reports
 * `info string NNUE evaluation using nn-…` instead of
 * `info string classical evaluation enabled.`
 *
 * ── The cost, and why it is opt-out rather than opt-in ───────────────────
 *
 * The net is a 40 MB one-time download per device, cached permanently (the
 * filename carries the net's own hash, and `public/_headers` marks
 * `/stockfish/*` `immutable`). It is fetched lazily by the WASM engine on its
 * first handshake, so it never touches first paint and a user who only reads
 * their dashboard never pays for it.
 *
 * On by default because a coaching app whose engine misjudges endgames is
 * wrong in the way that matters most; off available because 40 MB on a metered
 * connection is a real cost that only the person holding the device can judge.
 * That makes it a PER-DEVICE preference, hence localStorage rather than the
 * Dexie `Settings` row — syncing "this laptop is on hotel wifi" to the user's
 * desktop would be actively wrong. Same key/version scheme as
 * `MOVE_SOUNDS_PREF_KEY`, for the same reason: it must be readable
 * synchronously, before any await.
 *
 * ── Where the net is served from ─────────────────────────────────────────
 *
 * Two modes, chosen by whether `VITE_NNUE_NET_URL` is set at build time:
 *
 *   unset  — SAME-ORIGIN. `scripts/copy-nnue.mjs` stages the net into
 *            `public/stockfish/` and the app fetches `<base>stockfish/<net>`.
 *            This is the dev default: no external dependency, works offline.
 *
 *   set    — REMOTE. The net lives on an object store and the app fetches it
 *            from there. This exists because Cloudflare Pages refuses any
 *            single asset over 25 MiB and the net is 38.3 MiB, so production
 *            cannot serve it from the app's own origin at all.
 *
 * The remote host must send `Access-Control-Allow-Origin`. That is the whole
 * requirement, measured rather than assumed: both the probe below and
 * Stockfish's own fetch of the net are CORS-mode requests, and a successful
 * CORS response satisfies `COEP: require-corp` on its own. A host that sends
 * `Cross-Origin-Resource-Policy: cross-origin` but no CORS header fails; one
 * that sends CORS but no CORP works. See DEPLOY.md for the measurements and
 * the R2 setup.
 *
 * A remote net that 404s or lacks CORS is the fatal case, not the degrading
 * one — Stockfish `exit()`s at the first `go` — which is exactly why the probe
 * below runs first and why it must probe the URL the ENGINE will use, not a
 * same-origin stand-in.
 */

import { readPersistedValue, persistedStorageKey } from '@/lib/usePersistedState';

/**
 * The NNUE network shipped inside the `stockfish` npm package.
 *
 * THE one place this filename is written. `scripts/copy-nnue.mjs` parses this
 * very line to know what to stage into `public/stockfish/`, and refuses to run
 * if `node_modules/stockfish/src/` disagrees — so a Stockfish upgrade that
 * changes the net can't leave the app asking for a file that is no longer
 * being copied.
 *
 * In same-origin mode this is sent to Stockfish as a BARE filename, not a
 * path: the engine resolves `EvalFile` next to its own worker script
 * (`/stockfish/`), and an absolute `/stockfish/…` would break under a non-root
 * Vite `base` (GitHub Pages). In remote mode it is appended to
 * `VITE_NNUE_NET_URL` and sent as a full absolute URL — see
 * `resolveNetLocation`.
 */
export const NNUE_NET_FILE = 'nn-5af11540bbfe.nnue';

/** `Analysis.engine` values. `diff.ts#isNnueAnalysis` matches on `nnue`. */
export const NNUE_EVALUATOR_ID = 'stockfish-16-nnue';
export const CLASSICAL_EVALUATOR_ID = 'stockfish-16-classical';

/** Same key/version scheme as `usePersistedState`, so the Settings toggle and
 *  this module read and write exactly the same entry. */
export const NNUE_PREF_KEY = 'engine.nnue';
export const NNUE_PREF_VERSION = 1;

function isBoolean(raw: unknown): raw is boolean {
  return typeof raw === 'boolean';
}

/**
 * Does this device want NNUE? Defaults to true. Read synchronously and
 * deliberately *not* memoized, so flipping the Settings toggle takes effect on
 * the next engine start without a reload.
 */
export function nnuePreferenceEnabled(): boolean {
  return readPersistedValue(
    persistedStorageKey(NNUE_PREF_KEY, NNUE_PREF_VERSION),
    true,
    isBoolean,
  );
}

/**
 * Is the net actually being served? Memoized for the page's lifetime.
 *
 * This probe is not paranoia, it is a guard against a specific hard failure:
 * Stockfish 16 calls `exit(EXIT_FAILURE)` from `Eval::NNUE::verify()` when
 * `Use NNUE` is on and the net didn't load — and it does so on the first `go`,
 * not at `setoption`, so the UCI handshake succeeds and then the worker dies
 * mid-analysis. Without the probe, any environment where the copy step didn't
 * run (a bare `npx vite`, a deploy whose prebuild was skipped) would go from
 * "slightly weaker evals" to "analysis is broken", which is a far worse
 * failure. One `HEAD` per page buys the graceful degradation.
 *
 * `HEAD`, so the probe itself transfers no body — the engine's own fetch of the
 * net is the only 40 MB that crosses the wire.
 */
let netProbe: Promise<boolean> | null = null;
/** Last resolved probe value, for the sync callers that need a best answer
 *  without an await (see `EnginePool.evaluatorId`). Null until the first probe
 *  settles. */
let netKnown: boolean | null = null;

/**
 * Where the net is, and what to hand Stockfish for `EvalFile`.
 *
 * `url` is what the probe fetches; `evalFile` is the literal `EvalFile` value.
 * They differ in same-origin mode on purpose — the probe needs a URL the page
 * can fetch, while Stockfish wants a bare filename it resolves next to its own
 * worker script (see `NNUE_NET_FILE`). In remote mode both are the same
 * absolute URL, because Stockfish loads `EvalFile` through `emscripten_fetch`,
 * which passes it to XHR verbatim — so an absolute cross-origin URL simply
 * works (measured: identical +377 cp on the rook endgame from either origin).
 */
export interface NetLocation {
  /** Absolute, or `base`-relative, URL of the net. What the probe fetches. */
  url: string;
  /** The literal `EvalFile` value: a bare filename, or an absolute URL. */
  evalFile: string;
  /** True when the net comes from an origin other than the app's. */
  remote: boolean;
  /** Set when `VITE_NNUE_NET_URL` was present but unusable. The other fields
   *  then describe the same-origin fallback. */
  error?: string;
}

/**
 * Pure resolution of `VITE_NNUE_NET_URL` into a `NetLocation`.
 *
 * Exported for unit tests, and called by every accessor below.
 *
 * A malformed value **falls back to same-origin with an `error`** rather than
 * throwing. Throwing here would white-screen the whole app over an env-var
 * typo; the strict check belongs at build time, where `scripts/copy-nnue.mjs`
 * refuses to proceed and the deploy goes red with a readable message. Runtime
 * forgiving, build time strict.
 *
 * `configured` may be either a directory (`https://host/nets`) or the full net
 * URL (`https://host/nets/nn-<hash>.nnue`) — the latter is what you get by
 * copying a link out of an object-store dashboard. A full URL naming a
 * DIFFERENT net is rejected, because that is the silent-classical trap the
 * `copy-nnue.mjs` coherence guard exists to prevent, one origin over.
 */
export function resolveNetLocation(
  configured: string | null | undefined,
  baseUrl: string,
  netFile: string,
): NetLocation {
  const sameOrigin: NetLocation = {
    url: `${baseUrl}stockfish/${netFile}`,
    evalFile: netFile,
    remote: false,
  };

  const raw = (configured ?? '').trim();
  if (raw === '') return sameOrigin;

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return {
      ...sameOrigin,
      error: `${JSON.stringify(raw)} is not an absolute URL (it needs a scheme, e.g. https://…)`,
    };
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return {
      ...sameOrigin,
      error: `${raw} must be an http(s) URL, got protocol ${parsed.protocol}`,
    };
  }

  // A query string or fragment would ride along into the `EvalFile` value and
  // make the filename check below meaningless. Signed URLs don't work here
  // anyway: the net is fetched fresh by every worker, long after any short-lived
  // signature would have expired, so rejecting them is honest rather than
  // restrictive.
  if (parsed.search !== '' || parsed.hash !== '') {
    return {
      ...sameOrigin,
      error: `${raw} must not carry a query string or fragment`,
    };
  }

  if (parsed.pathname.endsWith('.nnue')) {
    if (!parsed.pathname.endsWith(`/${netFile}`)) {
      const named = parsed.pathname.slice(parsed.pathname.lastIndexOf('/') + 1);
      return {
        ...sameOrigin,
        error:
          `${raw} names ${named}, but this build asks Stockfish for ${netFile}. ` +
          'Either upload the net this build expects, or drop the filename and ' +
          'let the app append it.',
      };
    }
    return { url: parsed.href, evalFile: parsed.href, remote: true };
  }

  const href = `${parsed.href.replace(/\/+$/, '')}/${netFile}`;
  return { url: href, evalFile: href, remote: true };
}

/** Test seam: pretend `VITE_NNUE_NET_URL` holds `url`. Resets the probe, since
 *  its memoized answer was about the previous location. Null restores the real
 *  env value. */
let netUrlOverride: string | null = null;
export function _setNnueNetUrlOverride(url: string | null): void {
  netUrlOverride = url;
  _resetNnueNetProbe();
}

function viteEnv(): Record<string, string | undefined> {
  return typeof import.meta.env !== 'undefined'
    ? (import.meta.env as unknown as Record<string, string | undefined>)
    : {};
}

/** Deduped so a misconfiguration logs once, not once per worker start. */
let loggedLocationError: string | null = null;

/**
 * The resolved net location.
 *
 * Deliberately NOT memoized, matching `nnuePreferenceEnabled()` above: it stays a
 * plain read of the environment, so the test override takes effect on the next
 * engine start without a reload. The cost is one `new URL()` per call, and it is
 * called a handful of times per worker start.
 */
function nnueNetLocation(): NetLocation {
  const env = viteEnv();
  const configured = netUrlOverride !== null ? netUrlOverride : env.VITE_NNUE_NET_URL;
  const loc = resolveNetLocation(configured, env.BASE_URL ?? '/', NNUE_NET_FILE);
  if (loc.error && loc.error !== loggedLocationError) {
    loggedLocationError = loc.error;
    console.error(
      `[engine] VITE_NNUE_NET_URL is unusable — ${loc.error}\n` +
        `         Falling back to the same-origin net at ${loc.url}.`,
    );
  }
  return loc;
}

export function nnueNetUrl(): string {
  return nnueNetLocation().url;
}

/** The literal value to send as `setoption name EvalFile value …`. */
export function nnueEvalFileValue(): string {
  return nnueNetLocation().evalFile;
}

/** Whether the net is being served from another origin. Diagnostic. */
export function nnueNetIsRemote(): boolean {
  return nnueNetLocation().remote;
}

/** What to tell the developer when the net isn't there, which differs by mode:
 *  staging is a local build step, a remote miss is an upload or a CORS rule. */
function fixHint(loc: NetLocation): string {
  if (!loc.remote) return 'Run `npm run nnue:stage`.';
  return (
    'Check that the object store has the net and sends ' +
    '`Access-Control-Allow-Origin` — `npm run nnue:upload -- --verify-only` reports both.'
  );
}

export function nnueNetAvailable(): Promise<boolean> {
  if (netProbe) return netProbe;
  const loc = nnueNetLocation();
  netProbe = (async () => {
    if (typeof fetch === 'undefined') return false;
    // Caught here rather than left to the probe's failure, because the browser's
    // own mixed-content error names the URL but not the fix.
    if (
      loc.remote &&
      new URL(loc.url).protocol === 'http:' &&
      typeof location !== 'undefined' &&
      location.protocol === 'https:'
    ) {
      console.warn(
        `[engine] NNUE net at ${loc.url} is http: on an https: page — the browser ` +
          'will block it as mixed content. Serve the net over https.',
      );
      return false;
    }
    try {
      const res = await fetch(loc.url, { method: 'HEAD' });
      // `res.ok` alone is NOT enough, measured: Vite's dev server answers an
      // unknown path with the SPA index.html fallback, so a HEAD for a net that
      // was never staged comes back 200. Size is the discriminator that works
      // on every host — the net is 40 MB and any fallback / error page is
      // kilobytes. A host that omits `content-length` (chunked) is accepted as
      // long as it isn't serving HTML.
      //
      // `content-length` survives the cross-origin trip without any
      // `Access-Control-Expose-Headers` on the host: it is a CORS-safelisted
      // response header. Verified against a host sending nothing but
      // `Access-Control-Allow-Origin`.
      const len = Number(res.headers.get('content-length') ?? '0');
      const type = res.headers.get('content-type') ?? '';
      const looksLikeNet = len > 1_000_000 || (len === 0 && !/html/i.test(type));
      const ok = res.ok && looksLikeNet;
      if (!ok) {
        console.warn(
          `[engine] NNUE net not served at ${loc.url} (HTTP ${res.status}, ` +
            `content-length ${len}); falling back to the classical evaluator. ` +
            fixHint(loc),
        );
      }
      return ok;
    } catch (err) {
      // A cross-origin host with no `Access-Control-Allow-Origin` lands here as
      // an opaque `TypeError: Failed to fetch` — the browser deliberately says
      // nothing more. Name the likely cause, since the error can't.
      console.warn(
        `[engine] NNUE net probe failed for ${loc.url}; using classical. ` +
          (loc.remote
            ? 'A cross-origin host that answers without `Access-Control-Allow-Origin` ' +
              'fails exactly like this. ' + fixHint(loc)
            : fixHint(loc)),
        err,
      );
      return false;
    }
  })();
  void netProbe.then((v) => {
    netKnown = v;
  });
  return netProbe;
}

/**
 * Will the next engine we start run NNUE? Preference AND net availability.
 *
 * Every consumer that needs to agree on the evaluator goes through here — the
 * UCI handshake in `engine.ts` and the eval cache's row key in `cache.ts` —
 * so the numbers in the cache and the label on the analysis cannot drift apart.
 */
export async function nnueActive(): Promise<boolean> {
  if (!nnuePreferenceEnabled()) return false;
  return nnueNetAvailable();
}

/** `nnueActive()` as an `Analysis.engine` value. */
export async function activeEvaluatorId(): Promise<string> {
  return (await nnueActive()) ? NNUE_EVALUATOR_ID : CLASSICAL_EVALUATOR_ID;
}

/**
 * Best sync answer to "which evaluator are we on", for callers that have no
 * await available. Exact once any engine has started (the probe has settled by
 * then); before that it optimistically trusts the preference, which is right
 * in every configuration where the net is actually deployed.
 */
export function intendedEvaluatorIdSync(): string {
  if (!nnuePreferenceEnabled()) return CLASSICAL_EVALUATOR_ID;
  return netKnown === false ? CLASSICAL_EVALUATOR_ID : NNUE_EVALUATOR_ID;
}

/** Test seam: forget the memoized probe so a test can flip the fixture. */
export function _resetNnueNetProbe(): void {
  netProbe = null;
  netKnown = null;
}
