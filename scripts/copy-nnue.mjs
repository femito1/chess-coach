#!/usr/bin/env node
/**
 * Stage Stockfish's NNUE network into `public/stockfish/` so the browser engine
 * can load it.
 *
 * ── Why a build step instead of a committed file ─────────────────────────
 *
 * The net is 40 MB. Committing it would add 40 MB to every clone, forever, and
 * another 40 MB blob on each Stockfish upgrade — git stores binaries whole, so
 * the history only grows. Against that, this copy costs ~200 ms once per build.
 *
 * The copy can't fail for want of its source, either: the net ships inside the
 * `stockfish` npm package we already depend on, and both places that build this
 * app (`npm ci` on GitHub Actions, `npm ci` on Cloudflare Pages) populate
 * `node_modules` before running `npm run build`. So `prebuild` always has the
 * file to hand. `predev` covers `npm run dev`.
 *
 * Not covered: starting Vite directly (`npx vite`), which skips npm lifecycle
 * scripts — run this script yourself first, or the app degrades to the
 * classical evaluator (see `nnueNetAvailable` in src/engine/nnue.ts, which
 * probes for exactly this case rather than letting Stockfish die on it).
 *
 * ── Coherence with the app ───────────────────────────────────────────────
 *
 * The filename lives in `src/engine/nnue.ts` as `NNUE_NET_FILE`, because that
 * is the string the app sends over UCI. This script parses it out of that file
 * rather than repeating it, and fails loudly if `node_modules` ships a
 * different net — otherwise a Stockfish upgrade would silently leave the app
 * asking for a file nobody copies, and every eval would quietly go classical.
 *
 * Idempotent: an existing destination of the right size is left alone, so
 * repeated builds and `predev` after `prebuild` cost a `stat`.
 *
 * ── When the net is served from somewhere else ────────────────────────────
 *
 * Cloudflare Pages rejects any single asset over 25 MiB, so production cannot
 * serve a 38.3 MiB net from the app's own origin at all. Setting
 * `VITE_NNUE_NET_URL` points the app at an object store instead, and this
 * script then **skips the copy** — staging it would only put an
 * over-cap file into `dist/` and fail the deploy.
 *
 * This script is also the STRICT half of validating that variable. The runtime
 * (`resolveNetLocation` in src/engine/nnue.ts) is deliberately forgiving: a
 * typo'd URL there logs and falls back to classical rather than white-screening
 * the app. That forgiveness is only safe because a typo can't reach production
 * without passing through here first, where it fails the build loudly. Keep the
 * two in step — same rules, opposite severities.
 */

import {
  copyFileSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { netTarget, readNetFileName } from './nnue-net-config.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = join(repoRoot, 'node_modules', 'stockfish', 'src');
const destDir = join(repoRoot, 'public', 'stockfish');

function fail(msg) {
  console.error(`[copy-nnue] ${msg}`);
  process.exit(1);
}

/** The net(s) the installed Stockfish package actually ships. */
function shippedNets() {
  let entries;
  try {
    entries = readdirSync(srcDir);
  } catch {
    fail(
      `${srcDir} does not exist. Run \`npm ci\` (or \`npm install\`) first — the ` +
        'net ships inside the `stockfish` package.',
    );
  }
  return entries.filter((f) => f.endsWith('.nnue'));
}

const want = readNetFileName(repoRoot);
const shipped = shippedNets();
const to = join(destDir, want);

if (shipped.length === 0) {
  fail(`no .nnue file in ${srcDir} — did the stockfish package change layout?`);
}
if (!shipped.includes(want)) {
  fail(
    `stockfish ships ${shipped.join(', ')} but src/engine/nnue.ts asks for ${want}.\n` +
      `  Update NNUE_NET_FILE in src/engine/nnue.ts to match, then re-run.\n` +
      '  (Leaving them out of step would make every browser eval silently fall\n' +
      '   back to the classical evaluator.)',
  );
}

// Resolved through the shared build-side module, so this script, the upload
// script and the Vite build guard cannot disagree about whether the net is
// remote — including when the variable lives only in `.env.local`, which npm
// does not put in `process.env`.
const target = netTarget(repoRoot, want);

if (target.remote && target.error) {
  fail(
    `VITE_NNUE_NET_URL (from ${target.from}) ${target.error}\n` +
      '  Nothing was staged. Fix the variable or unset it to serve the net from\n' +
      '  this origin (which Cloudflare Pages will reject at 38.3 MiB — see DEPLOY.md).',
  );
}

const remote = target.remote ? target.url : null;

// Cloudflare Pages sets CF_PAGES=1 in its build container. Staging a 38.3 MiB
// asset there guarantees a failed deployment, and Pages reports it as a generic
// asset-size error with no hint about NNUE — the exact failure that cost a
// previous session an hour. Fail here instead, in the first second of the build,
// with the fix in the message.
//
// Deliberately NOT a silent fallback to classical: which evaluator production
// uses is a decision for a human, not something a missing env var should quietly
// settle. See DEPLOY.md § If you would rather not for how to choose classical on
// purpose.
if (!remote && process.env.CF_PAGES) {
  fail(
    'VITE_NNUE_NET_URL is not set, and this is a Cloudflare Pages build.\n' +
      `  Staging ${want} (38.3 MiB) would exceed the 25 MiB per-asset cap and the\n` +
      '  deployment would fail — so this build stops now instead.\n' +
      '\n' +
      '  Fix: put the net on R2 and set VITE_NNUE_NET_URL in this project\n' +
      "  environment (Production AND Preview). It's about ten minutes:\n" +
      '    DEPLOY.md § The NNUE network and the 25 MiB asset cap\n' +
      '\n' +
      '  Or, to ship deliberately WITHOUT NNUE in the browser, see\n' +
      '  DEPLOY.md § If you would rather not — that is a real choice, but it has\n' +
      '  to be made on purpose rather than by leaving a variable unset.',
  );
}

if (remote) {
  // Remote mode: the net must NOT end up in `dist/`. Vite copies `public/`
  // verbatim, so a copy left over from an earlier same-origin `npm run dev` in
  // this working tree would ride along and breach the 25 MiB cap — the exact
  // failure this mode exists to avoid. Remove it rather than warn: it is a
  // regenerable build artifact (`npm run nnue:stage` puts it back), never
  // something a human authored.
  let removed = null;
  try {
    removed = statSync(to).size;
    unlinkSync(to);
  } catch {
    /* nothing staged, which is the normal case on a fresh checkout */
  }
  console.log(
    `[copy-nnue] VITE_NNUE_NET_URL is set (${target.from}) — not staging ${want}.\n` +
      `[copy-nnue]   the app will load the net from ${remote}\n` +
      `[copy-nnue]   that host MUST send Access-Control-Allow-Origin; verify with ` +
      '`npm run nnue:upload -- --verify-only`' +
      (removed === null
        ? ''
        : `\n[copy-nnue]   removed a previously staged copy from public/stockfish/ (${mb(removed)})`),
  );
  process.exit(0);
}

const from = join(srcDir, want);
const srcSize = statSync(from).size;

let existing = null;
try {
  existing = statSync(to).size;
} catch {
  /* not staged yet */
}

if (existing === srcSize) {
  console.log(`[copy-nnue] ${want} already staged (${mb(srcSize)})`);
  process.exit(0);
}

const t0 = Date.now();
mkdirSync(destDir, { recursive: true });
copyFileSync(from, to);
console.log(
  `[copy-nnue] ${want} → public/stockfish/ (${mb(srcSize)} in ${Date.now() - t0} ms)`,
);

function mb(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
