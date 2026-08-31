#!/usr/bin/env node
/**
 * Put Stockfish's NNUE network on an object store, and verify that the browser
 * will actually be able to load it from there.
 *
 * ── Why this exists ──────────────────────────────────────────────────────
 *
 * Cloudflare Pages rejects any single asset over 25 MiB and the net is 38.3 MiB,
 * so production cannot serve it from the app's own origin. `VITE_NNUE_NET_URL`
 * points the app at an object store instead (see DEPLOY.md § The NNUE network).
 *
 * The upload half is one `wrangler` call and barely needs a script. The
 * VERIFY half is the reason this file exists, because every way this setup fails
 * fails silently or fatally, never helpfully:
 *
 *   - No `Access-Control-Allow-Origin` on the host → the browser's fetch throws
 *     `TypeError: Failed to fetch` with no detail, and Stockfish, whose net
 *     download fails the same way, calls `exit(EXIT_FAILURE)` at the first `go`.
 *     Analysis dies mid-search rather than degrading. (The app's HEAD probe
 *     catches this and falls back to classical — but then evals are quietly
 *     worse, which is the thing we were trying to fix.)
 *   - Wrong net uploaded → the app asks for a filename that 404s.
 *   - `http:` URL on an `https:` page → blocked as mixed content.
 *
 * So: `--verify-only` answers "will the browser load this?" against the real
 * URL, over the network, with the same checks the app makes. Run it after any
 * change to the bucket, and after any Stockfish upgrade.
 *
 * ── Usage ────────────────────────────────────────────────────────────────
 *
 *   npm run nnue:upload                      # upload, then verify
 *   npm run nnue:upload -- --verify-only     # just check what's live
 *   npm run nnue:upload -- --bucket=my-nets  # non-default bucket name
 *
 * Reads the target URL from `VITE_NNUE_NET_URL` (env or `.env.local`), because
 * that is the same value the app is built with — verifying a different URL than
 * the app uses would prove nothing.
 *
 * Requires `wrangler` on PATH for the upload half (`npx wrangler` works);
 * `--verify-only` needs nothing but network.
 */

import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { netTarget } from './nnue-net-config.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = join(repoRoot, 'node_modules', 'stockfish', 'src');

const DEFAULT_BUCKET = 'chess-coach-nnue';
/** The app treats anything under this as "not the net" (see `nnueNetAvailable`). */
const MIN_PLAUSIBLE_NET_BYTES = 1_000_000;

function fail(msg) {
  console.error(`\n[nnue-upload] ✗ ${msg}`);
  process.exit(1);
}
function ok(msg) {
  console.log(`[nnue-upload] ✓ ${msg}`);
}
function info(msg) {
  console.log(`[nnue-upload]   ${msg}`);
}

/* ---------------------------------------------------------------- args --- */

const args = process.argv.slice(2);
let verifyOnly = false;
let bucket = DEFAULT_BUCKET;
for (const a of args) {
  if (a === '--verify-only') verifyOnly = true;
  else if (a.startsWith('--bucket=')) bucket = a.slice('--bucket='.length);
  else if (a === '-h' || a === '--help') {
    console.log(
      'Usage: npm run nnue:upload [-- --verify-only] [-- --bucket=NAME]\n\n' +
        '  --verify-only   Skip the upload; just check the live URL.\n' +
        `  --bucket=NAME   R2 bucket to upload into (default ${DEFAULT_BUCKET}).\n`,
    );
    process.exit(0);
  } else fail(`unknown argument ${a}`);
}

/* ------------------------------------------------------- configuration --- */

// Resolved through the same module `copy-nnue.mjs` and the Vite build guard use,
// so this script cannot verify a different URL than the app is built with —
// which would prove nothing at all.
const target = netTarget(repoRoot);
const want = target.netFile;

if (!target.remote) {
  fail(
    'VITE_NNUE_NET_URL is not set (checked the environment, .env.local and .env).\n' +
      "  Set it to your bucket's public base URL, e.g.\n" +
      '    VITE_NNUE_NET_URL=https://pub-<hash>.r2.dev\n' +
      '  See DEPLOY.md § The NNUE network for how to get that URL.',
  );
}
if (target.error) {
  fail(`VITE_NNUE_NET_URL (from ${target.from}) ${target.error}`);
}

const netUrl = target.url;
const parsedNetUrl = new URL(netUrl);
/** The object key is whatever follows the host — so a base URL with a path
 *  prefix (`https://host/nets`) uploads to `nets/<file>`, matching what the app
 *  will request. */
const objectKey = parsedNetUrl.pathname.replace(/^\/+/, '');

console.log(`[nnue-upload] net       ${want}`);
console.log(`[nnue-upload] target    ${netUrl}`);
console.log(`[nnue-upload] from      VITE_NNUE_NET_URL (${target.from})`);

/* -------------------------------------------------------------- upload --- */

if (!verifyOnly) {
  const local = join(srcDir, want);
  let bytes;
  try {
    bytes = statSync(local).size;
  } catch {
    fail(
      `${local} does not exist. Run \`npm ci\` first — the net ships inside the ` +
        '`stockfish` package.',
    );
  }

  console.log(`[nnue-upload] bucket    ${bucket} (key: ${objectKey})`);
  console.log(`[nnue-upload] uploading ${(bytes / 1024 / 1024).toFixed(1)} MiB …`);

  // `--remote` so it goes to the real bucket rather than a local simulation.
  // `--content-type` matters: a net served as text/html would trip the app's own
  // "is this an SPA fallback" check. `--cache-control` is what makes the 40 MB a
  // genuinely one-time cost per device, and it is truthful because the filename
  // carries Stockfish's own hash of the weights.
  const wrangler = spawnSync(
    'npx',
    [
      'wrangler',
      'r2',
      'object',
      'put',
      `${bucket}/${objectKey}`,
      `--file=${local}`,
      '--content-type=application/octet-stream',
      '--cache-control=public, max-age=31536000, immutable',
      '--remote',
    ],
    { stdio: 'inherit', cwd: repoRoot },
  );
  if (wrangler.status !== 0) {
    fail(
      'wrangler upload failed.\n' +
        '  - Logged in?           npx wrangler login\n' +
        `  - Bucket exists?       npx wrangler r2 bucket create ${bucket}\n` +
        '  - Public access + CORS are configured in the dashboard; see DEPLOY.md.',
    );
  }
  ok('uploaded');
}

/* -------------------------------------------------------------- verify --- */

console.log('\n[nnue-upload] verifying what the browser will see …');

if (parsedNetUrl.protocol === 'http:') {
  console.warn(
    '[nnue-upload] ! this URL is http:. An https: page will refuse to load it as ' +
      'mixed content. Fine for a local test host, never for production.',
  );
}

let res;
try {
  // A real cross-origin request: `Origin` set, so the response's CORS headers
  // are the ones a browser would actually get. Without this header a host may
  // legitimately omit `Access-Control-Allow-Origin` and the check would report a
  // failure that the browser would never see.
  res = await fetch(netUrl, {
    method: 'HEAD',
    headers: { Origin: 'https://chess-coach-bip.pages.dev' },
  });
} catch (err) {
  fail(
    `could not reach ${netUrl}\n  ${err instanceof Error ? err.message : String(err)}`,
  );
}

if (!res.ok) {
  fail(
    `HTTP ${res.status} for ${netUrl}\n` +
      (res.status === 404
        ? '  Nothing at that key. Check the bucket name and that public access is on.\n' +
          '  A bucket with public access DISABLED also answers 404 here.'
        : '  Check the bucket\'s public access settings.'),
  );
}
ok(`HTTP ${res.status}`);

const len = Number(res.headers.get('content-length') ?? '0');
const type = res.headers.get('content-type') ?? '(none)';
const acao = res.headers.get('access-control-allow-origin');
const corp = res.headers.get('cross-origin-resource-policy');
const cache = res.headers.get('cache-control') ?? '(none)';

const expectedBytes = (() => {
  try {
    return statSync(join(srcDir, want)).size;
  } catch {
    return null;
  }
})();

if (len === 0) {
  console.warn('[nnue-upload] ! no content-length; cannot check the size');
} else if (len < MIN_PLAUSIBLE_NET_BYTES) {
  fail(
    `content-length is ${len} bytes — far too small to be the net.\n` +
      '  The app treats anything under 1 MB as "not the net" and falls back to classical.',
  );
} else if (expectedBytes !== null && len !== expectedBytes) {
  fail(
    `content-length is ${len} but the installed net is ${expectedBytes} bytes.\n` +
      '  A truncated or stale object. Re-run without --verify-only to re-upload.',
  );
} else {
  ok(`content-length ${len}${expectedBytes === null ? '' : ' (matches node_modules)'}`);
}

info(`content-type ${type}`);
if (/html/i.test(type)) {
  fail(
    'served as HTML. The app rejects this on purpose — it is the signature of a ' +
      '404 page or SPA fallback standing in for the net.',
  );
}

// The one genuinely load-bearing header, measured: both the app's probe and
// Stockfish's own net download are CORS-mode requests, and a CORS response
// satisfies `COEP: require-corp` by itself. A host sending CORP but no CORS
// fails; CORS with no CORP works.
if (!acao) {
  fail(
    'no `Access-Control-Allow-Origin` on the response.\n' +
      '  This is the failure that matters: the browser will refuse the net, and\n' +
      '  because the app is cross-origin isolated the error arrives as an opaque\n' +
      '  `TypeError: Failed to fetch`. Evals then silently drop to classical.\n' +
      '  Fix: add a CORS rule to the bucket allowing GET/HEAD from your app origin.\n' +
      '  See DEPLOY.md § The NNUE network for the exact JSON.',
  );
}
ok(`access-control-allow-origin: ${acao}`);

// Not required — recorded so a future reader can see it was considered rather
// than forgotten, and so a switch to a `no-cors` load path would have a note.
info(
  `cross-origin-resource-policy: ${corp ?? '(none) — not required, CORS covers it'}`,
);

info(`cache-control: ${cache}`);
if (!/immutable|max-age=\d{6,}/.test(cache)) {
  console.warn(
    '[nnue-upload] ! no long-lived cache-control. Every cold page load will\n' +
      '[nnue-upload]   re-download 38.3 MiB, which makes NNUE-by-default a bad\n' +
      '[nnue-upload]   deal. Set `public, max-age=31536000, immutable`; it is\n' +
      '[nnue-upload]   truthful because the filename carries the net\'s own hash.',
  );
}

console.log(
  `\n[nnue-upload] ✓ ${netUrl} looks loadable.\n` +
    '[nnue-upload]   Set VITE_NNUE_NET_URL to this in the Cloudflare Pages\n' +
    '[nnue-upload]   environment (Production AND Preview), then redeploy.\n' +
    '[nnue-upload]   Confirm in the live browser console: no `NNUE net not served`\n' +
    '[nnue-upload]   warning, and analysis reports `stockfish-16-nnue`.',
);
