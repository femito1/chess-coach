// Pack the chrome extension into a versioned zip ready for sideload
// or for upload to the Chrome Web Store dashboard.
//
// Usage:
//   node scripts/build-extension.mjs                            # → dist-extension/chess-coach-<version>.zip with default localhost origin
//   node scripts/build-extension.mjs --coach-origin=https://x.y # → bakes that URL as the default in options
//   node scripts/build-extension.mjs --output=foo.zip           # → custom output path
//
// Why we have this:
//   - The chrome.storage.sync default in `options.js` is
//     `http://localhost:5173`. That's correct for personal dev use
//     but wrong as a shipping default for anyone who installs the
//     extension from the Web Store and expects it to "just work"
//     against your hosted Chess Coach origin. `--coach-origin`
//     templates the production URL into a fresh `options.js` so a
//     first-install user lands with a sensible default that they
//     don't have to discover and type in.
//   - The Chrome Web Store wants a zip whose root is the manifest,
//     not a parent folder. We assemble that shape here so you don't
//     have to remember which directory layout to upload.
//
// The script is intentionally dependency-free: pure node + the
// already-installed `archiver`-equivalent (we use the built-in
// `zlib` + a tiny home-grown zip writer? no — `archiver` isn't a
// repo dep. Use Deno-style Node 20 streams + a tiny zip helper via
// the `node:zlib`/`fflate` chain... actually we just shell out to
// `zip`, which is available on Linux/macOS/WSL and is the documented
// approach in the Chrome extension docs).

import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const EXT_SRC = path.join(REPO_ROOT, 'extension');
const DEFAULT_OUT_DIR = path.join(REPO_ROOT, 'dist-extension');

/**
 * @typedef {Object} Args
 * @property {string} [coachOrigin]
 * @property {string} [output]
 */

/** @param {string[]} argv @returns {Args} */
function parseArgs(argv) {
  /** @type {Args} */
  const args = {};
  for (const a of argv) {
    if (a.startsWith('--coach-origin=')) args.coachOrigin = a.slice('--coach-origin='.length);
    else if (a.startsWith('--output=')) args.output = a.slice('--output='.length);
    else if (a === '--help' || a === '-h') {
      // eslint-disable-next-line no-console
      console.log(
        [
          'node scripts/build-extension.mjs [options]',
          '',
          'Options:',
          '  --coach-origin=<URL>   Bake <URL> into options.js as the default coachOrigin',
          '                         (overrides the built-in localhost default for the zip).',
          '  --output=<path>        Output zip path (default: dist-extension/chess-coach-<version>.zip).',
          '  -h, --help             Show this help.',
        ].join('\n'),
      );
      process.exit(0);
    }
  }
  return args;
}

async function readManifestVersion() {
  const raw = await fs.readFile(path.join(EXT_SRC, 'manifest.json'), 'utf8');
  /** @type {{ version?: string }} */
  const json = JSON.parse(raw);
  if (!json.version) throw new Error('extension/manifest.json is missing a version field');
  return json.version;
}

/** Recursively copy `src` into `dst`, skipping anything matched by
 *  `skip(rel)` (where `rel` is the slash-separated path relative to
 *  `src`).
 *  @param {string} src @param {string} dst
 *  @param {(rel: string) => boolean} skip */
async function copyTree(src, dst, skip) {
  await fs.mkdir(dst, { recursive: true });
  await walk(src, dst, '', skip);
}

/** @param {string} src @param {string} dst @param {string} rel
 *  @param {(rel: string) => boolean} skip */
async function walk(src, dst, rel, skip) {
  const entries = await fs.readdir(path.join(src, rel), { withFileTypes: true });
  for (const e of entries) {
    const childRel = rel ? `${rel}/${e.name}` : e.name;
    if (skip(childRel)) continue;
    const srcPath = path.join(src, childRel);
    const dstPath = path.join(dst, childRel);
    if (e.isDirectory()) {
      await fs.mkdir(dstPath, { recursive: true });
      await walk(src, dst, childRel, skip);
    } else if (e.isFile()) {
      await fs.copyFile(srcPath, dstPath);
    }
    // Symlinks etc. are deliberately skipped — extensions don't ship them.
  }
}

/**
 * Rewrite the `DEFAULT_COACH_ORIGIN` constant in options.js to the
 * provided URL. We intentionally do this with a string substitution
 * rather than a real JS parser: the line is one-shot, the value is
 * fully URL-encoded already, and a malformed URL would have been
 * rejected by the URL constructor in the calling `main`.
 *
 * NOTE: we ONLY rewrite options.js. The content script's default in
 * `content.js` is irrelevant to first-install behaviour because the
 * extension's `chrome.storage.sync` is seeded by the options page on
 * first save (or by the user opening options); we deliberately keep
 * the dev default (localhost) in the *source* so a maintainer
 * checking out the repo and loading the extension as unpacked still
 * gets localhost as the in-memory fallback.
 */
/** @param {string} stagingDir @param {string} newOrigin */
async function rewriteDefaultOrigin(stagingDir, newOrigin) {
  const file = path.join(stagingDir, 'src', 'options.js');
  const original = await fs.readFile(file, 'utf8');
  const re = /const DEFAULT_COACH_ORIGIN = ['"][^'"]*['"];/;
  if (!re.test(original)) {
    throw new Error(
      `options.js: could not find the DEFAULT_COACH_ORIGIN constant to rewrite. ` +
        `Expected a line like: const DEFAULT_COACH_ORIGIN = '...';`,
    );
  }
  const escaped = JSON.stringify(newOrigin); // canonicalises quoting + escapes anything weird
  const rewritten = original.replace(re, `const DEFAULT_COACH_ORIGIN = ${escaped};`);
  await fs.writeFile(file, rewritten);
  // eslint-disable-next-line no-console
  console.log(`  ✓ stamped DEFAULT_COACH_ORIGIN = ${escaped} into options.js`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // Validate origin early so we don't half-build before bailing.
  if (args.coachOrigin) {
    try {
      new URL(args.coachOrigin);
    } catch {
      throw new Error(`--coach-origin is not a valid URL: ${args.coachOrigin}`);
    }
    // Strip trailing slash for canonical storage; matches what
    // options.js does on save.
    args.coachOrigin = args.coachOrigin.replace(/\/$/, '');
  }

  const version = await readManifestVersion();
  const outZip = path.resolve(
    args.output ?? path.join(DEFAULT_OUT_DIR, `chess-coach-${version}.zip`),
  );
  const outDir = path.dirname(outZip);
  const stagingRoot = path.join(outDir, `.staging-${version}-${Date.now()}`);
  const stagingDir = path.join(stagingRoot, 'chess-coach');

  // Clean output dir for the zip (don't nuke a user-specified custom
  // path's parent — only clear our staging folder).
  await fs.mkdir(outDir, { recursive: true });
  await fs.rm(stagingDir, { recursive: true, force: true });
  await fs.rm(outZip, { force: true });

  // eslint-disable-next-line no-console
  console.log(`Building extension v${version}…`);
  // eslint-disable-next-line no-console
  console.log(`  staging: ${stagingDir}`);
  // eslint-disable-next-line no-console
  console.log(`  output:  ${outZip}`);

  // Copy extension/ into staging, dropping things the Web Store
  // doesn't need or doesn't accept.
  await copyTree(EXT_SRC, stagingDir, (rel) => {
    // Drop docs / dotfiles / OS junk. The Web Store doesn't read them
    // and including them gives the reviewer extra surface area to
    // question. Source directory keeps them for repo readers.
    if (rel === 'README.md') return true;
    if (rel === 'WEB_STORE_LISTING.md') return true;
    if (rel.startsWith('.')) return true;
    if (rel.endsWith('.DS_Store')) return true;
    return false;
  });

  if (args.coachOrigin) {
    await rewriteDefaultOrigin(stagingDir, args.coachOrigin);
  } else {
    // eslint-disable-next-line no-console
    console.log('  (no --coach-origin specified — keeping localhost default)');
  }

  // Zip from the staging root so the manifest sits at the zip root.
  // Chrome Web Store specifically requires the manifest to be at the
  // top level of the archive.
  try {
    await execFileP('zip', ['-r', '-q', outZip, '.'], { cwd: stagingDir });
  } catch (err) {
    throw new Error(
      `Failed to create zip — is the \`zip\` binary on $PATH? ` +
        `(Underlying error: ${err instanceof Error ? err.message : String(err)})`,
    );
  }

  // Clean up staging.
  await fs.rm(stagingRoot, { recursive: true, force: true });

  const stat = await fs.stat(outZip);
  // eslint-disable-next-line no-console
  console.log(`\n✓ wrote ${outZip} (${(stat.size / 1024).toFixed(1)} KB)`);
  // eslint-disable-next-line no-console
  console.log('\nNext steps:');
  // eslint-disable-next-line no-console
  console.log('  • Sideload locally: chrome://extensions → Developer mode → Load unpacked → select extension/');
  // eslint-disable-next-line no-console
  console.log('  • Or upload the zip to the Chrome Web Store dashboard.');
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
