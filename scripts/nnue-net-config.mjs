/**
 * Build-side answers to "which net, and where is it served from" — shared by
 * everything that runs outside the browser.
 *
 * Three consumers, one set of rules: `scripts/copy-nnue.mjs` (decides whether to
 * stage the net), `scripts/upload-nnue.mjs` (puts it on the object store and
 * verifies it), and the `nnueNetBuildGuard` plugin in `vite.config.ts` (last
 * check that no over-cap asset reaches `dist/`). They disagreeing is exactly the
 * failure this module prevents: a build whose bundle points at R2 while `dist/`
 * also carries a 38.3 MiB net is both over the Pages cap and confusing to debug.
 *
 * ── Relationship to the runtime resolver ─────────────────────────────────
 *
 * `resolveNetLocation()` in `src/engine/nnue.ts` applies the same rules in the
 * browser, and the two are deliberately NOT shared: this module runs in plain
 * Node before Vite exists and must not import a TS module that reaches
 * `@/lib/usePersistedState`, and — more importantly — the two differ in severity
 * on purpose. Here a bad value is FATAL, because a typo must not reach
 * production. There it falls back with a logged error, because an env-var typo
 * must not white-screen the app. Runtime forgiving, build time strict. Change one,
 * change the other; `src/engine/nnue.test.ts` pins the runtime half and
 * `scripts/test/integration/nnue-remote-net.mjs` pins the browser behaviour.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The net filename this build asks Stockfish for, parsed out of
 * `src/engine/nnue.ts`.
 *
 * Parsed rather than repeated because that constant is the string the app
 * actually sends over UCI. A second copy of the hash anywhere would let a
 * Stockfish upgrade leave the two out of step, and every eval would silently
 * fall back to the classical evaluator.
 */
export function readNetFileName(repoRoot) {
  const file = join(repoRoot, 'src', 'engine', 'nnue.ts');
  const m = /export const NNUE_NET_FILE = '([^']+)'/.exec(readFileSync(file, 'utf8'));
  if (!m) throw new Error(`could not find NNUE_NET_FILE in ${file}`);
  return m[1];
}

/**
 * `VITE_NNUE_NET_URL` as Vite would see it, for a given mode.
 *
 * Reading the dotenv files matters and is easy to skip. Vite loads them
 * automatically and bakes `VITE_*` into the bundle, but npm does not put them in
 * `process.env` — so a script that only checked `process.env` would conclude
 * "same-origin" and stage a 38.3 MiB net into a bundle that is meanwhile pointing
 * at an object store. Only this one key is parsed; anything more deserves a dotenv
 * dependency we don't otherwise need.
 *
 * **`mode` is load-bearing, not decoration.** Vite only reads `.env.[mode]` in
 * that mode, and the whole design leans on it: `.env.production` carries the
 * object-store URL, while `npm run dev` must NOT see it — otherwise every local
 * engine start would pull 38.3 MiB across the network instead of using the staged
 * copy, and dev would stop working offline. Hence `predev` passes
 * `--mode=development` and `prebuild` passes `--mode=production`.
 *
 * Precedence matches Vite's, highest first: the real process environment, then
 * `.env.[mode].local`, `.env.[mode]`, `.env.local`, `.env`. The process
 * environment winning is what lets a Cloudflare Pages variable override a
 * committed `.env.production` with no code change.
 *
 * Returns `{ value, from }` so callers can say *where* a bad value came from, or
 * null when it is genuinely unset.
 */
function readConfiguredNetUrl(repoRoot, mode) {
  const fromEnv = (process.env.VITE_NNUE_NET_URL ?? '').trim();
  if (fromEnv) return { value: fromEnv, from: 'environment' };

  for (const name of [`.env.${mode}.local`, `.env.${mode}`, '.env.local', '.env']) {
    const path = join(repoRoot, name);
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (/^\s*#/.test(line)) continue;
      const m = /^\s*VITE_NNUE_NET_URL\s*=\s*(.*?)\s*$/.exec(line);
      if (m && m[1]) {
        return { value: m[1].replace(/^["']|["']$/g, ''), from: name };
      }
    }
  }
  return null;
}

/**
 * Validate a configured value and turn it into the absolute net URL.
 *
 * Returns `{ url }` or `{ error }` — never throws and never exits, so each
 * caller picks its own severity (`copy-nnue.mjs` fails the build; the Vite plugin
 * only needs to know whether to strip the net).
 *
 * `raw` may be a directory (`https://host/nets`) or the full net URL
 * (`https://host/nets/nn-<hash>.nnue`), the latter being what you get by copying
 * a link out of an object-store dashboard. A full URL naming a DIFFERENT net is
 * rejected: that is the silent-classical trap the local coherence guard exists to
 * prevent, one origin over, where no local file exists to catch it.
 */
function resolveRemoteNetUrl(raw, netFile) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return {
      error:
        `${JSON.stringify(raw)} is not an absolute URL.\n` +
        '  It needs a scheme, e.g. https://pub-<hash>.r2.dev',
    };
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { error: `must be an http(s) URL, got protocol ${parsed.protocol}` };
  }

  if (parsed.search !== '' || parsed.hash !== '') {
    return {
      error:
        'must not carry a query string or fragment.\n' +
        '  A signed URL cannot work here: every engine worker re-fetches the net,\n' +
        '  long after a short-lived signature would have expired.',
    };
  }

  if (parsed.pathname.endsWith('.nnue')) {
    if (!parsed.pathname.endsWith(`/${netFile}`)) {
      const named = parsed.pathname.slice(parsed.pathname.lastIndexOf('/') + 1);
      return {
        error:
          `names ${named}, but this build asks Stockfish for ${netFile}.\n` +
          '  Upload the net this build expects, or drop the filename from the\n' +
          '  variable and let the app append it.',
      };
    }
    return { url: parsed.href };
  }

  return { url: `${parsed.href.replace(/\/+$/, '')}/${netFile}` };
}

/**
 * The whole build-side question in one call: is the net remote, and where?
 *
 * `mode` is Vite's mode — `'production'` for a build, `'development'` for the dev
 * server. See `readConfiguredNetUrl`: passing the wrong one makes dev fetch the
 * net over the network, or makes a production build ship an over-cap asset.
 *
 * `{ remote: false }` when unset, `{ remote: true, url, from }` when usable, and
 * `{ remote: true, error, from }` when configured but broken — callers must handle
 * that third case rather than treating it as same-origin, since a broken remote
 * URL is a misconfiguration to report, not a request for local staging.
 */
export function netTarget(repoRoot, mode, netFile = readNetFileName(repoRoot)) {
  if (mode !== 'production' && mode !== 'development') {
    throw new Error(
      `netTarget: mode must be 'production' or 'development', got ${JSON.stringify(mode)}`,
    );
  }
  const configured = readConfiguredNetUrl(repoRoot, mode);
  if (!configured) return { remote: false, netFile, mode };
  const resolved = resolveRemoteNetUrl(configured.value, netFile);
  return { remote: true, netFile, mode, from: configured.from, ...resolved };
}
