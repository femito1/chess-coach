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
 * Sent to Stockfish as a BARE filename, not a path: the engine resolves
 * `EvalFile` next to its own worker script (`/stockfish/`), and an absolute
 * `/stockfish/…` would break under a non-root Vite `base` (GitHub Pages).
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

export function nnueNetUrl(): string {
  const base =
    typeof import.meta.env !== 'undefined' ? import.meta.env.BASE_URL : '/';
  return `${base}stockfish/${NNUE_NET_FILE}`;
}

export function nnueNetAvailable(): Promise<boolean> {
  if (netProbe) return netProbe;
  netProbe = (async () => {
    if (typeof fetch === 'undefined') return false;
    try {
      const res = await fetch(nnueNetUrl(), { method: 'HEAD' });
      // `res.ok` alone is NOT enough, measured: Vite's dev server answers an
      // unknown path with the SPA index.html fallback, so a HEAD for a net that
      // was never staged comes back 200. Size is the discriminator that works
      // on every host — the net is 40 MB and any fallback / error page is
      // kilobytes. A host that omits `content-length` (chunked) is accepted as
      // long as it isn't serving HTML.
      const len = Number(res.headers.get('content-length') ?? '0');
      const type = res.headers.get('content-type') ?? '';
      const looksLikeNet = len > 1_000_000 || (len === 0 && !/html/i.test(type));
      const ok = res.ok && looksLikeNet;
      if (!ok) {
        console.warn(
          `[engine] NNUE net not served at ${nnueNetUrl()} (HTTP ${res.status}, ` +
            `content-length ${len}); falling back to the classical evaluator. ` +
            'Run `npm run nnue:stage`.',
        );
      }
      return ok;
    } catch (err) {
      console.warn('[engine] NNUE net probe failed; using classical', err);
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
