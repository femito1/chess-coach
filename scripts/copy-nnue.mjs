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
 */

import { copyFileSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = join(repoRoot, 'node_modules', 'stockfish', 'src');
const destDir = join(repoRoot, 'public', 'stockfish');
const constantFile = join(repoRoot, 'src', 'engine', 'nnue.ts');

function fail(msg) {
  console.error(`[copy-nnue] ${msg}`);
  process.exit(1);
}

/** The filename the app will ask Stockfish for. */
function expectedNetName() {
  const src = readFileSync(constantFile, 'utf8');
  const m = /export const NNUE_NET_FILE = '([^']+)'/.exec(src);
  if (!m) fail(`could not find NNUE_NET_FILE in ${constantFile}`);
  return m[1];
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

const want = expectedNetName();
const shipped = shippedNets();

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

const from = join(srcDir, want);
const to = join(destDir, want);
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
