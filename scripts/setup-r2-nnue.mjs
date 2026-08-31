#!/usr/bin/env node
/**
 * Stand up the R2 bucket that serves Stockfish's NNUE network, end to end,
 * through `wrangler`. No dashboard clicking.
 *
 * ── Why this replaces a click-through ────────────────────────────────────
 *
 * Production cannot serve the 38.3 MiB net from the app's own origin (Cloudflare
 * Pages caps a single asset at 25 MiB), so it lives on an object store and
 * `VITE_NNUE_NET_URL` points the app there — see DEPLOY.md § The NNUE network.
 *
 * Every step of that setup has a `wrangler` command, including the two that look
 * like dashboard-only settings:
 *
 *   bucket            wrangler r2 bucket create
 *   public access     wrangler r2 bucket dev-url enable
 *   the public URL    wrangler r2 bucket dev-url get   ← so nobody has to read it
 *                                                        off a dashboard and risk
 *                                                        guessing wrong
 *   CORS rule         wrangler r2 bucket cors set
 *   the net itself    wrangler r2 object put   (via `npm run nnue:upload`)
 *
 * Reading the URL rather than assuming it matters for the same reason it does for
 * the Pages hostname (DEPLOY.md § Production host): `pub-<hash>.r2.dev` contains
 * an account-specific hash and is not derivable from the bucket name.
 *
 * ── What this script cannot do ───────────────────────────────────────────
 *
 * Two things, both stated plainly rather than papered over:
 *
 *  1. **Authenticate, or enable R2 on the account.** `wrangler login` opens a
 *     browser, and an API token is a credential this script has no business
 *     inventing. Separately, R2 itself is a one-time account-level opt-in that the
 *     CLI cannot perform — until someone enables it in the dashboard, every R2 API
 *     call returns error 10042. Both cases are detected and reported with the fix
 *     rather than passed through as a generic API failure.
 *  2. **Set a Pages *build* environment variable.** `wrangler pages` has no
 *     command for it (only `pages secret`, which is for runtime Function secrets,
 *     not build-time `VITE_*` inlining). So by default this script writes the
 *     value to `.env.production` instead, which is Vite's documented home for
 *     non-secret build configuration and needs no dashboard at all. A real
 *     environment variable still outranks that file, so setting it in Pages later
 *     overrides the committed default without a code change. `--no-write-env`
 *     skips the write and just prints the value.
 *
 * ── Usage ────────────────────────────────────────────────────────────────
 *
 *   npm run nnue:setup                    # do it
 *   npm run nnue:setup -- --dry-run       # print every command, change nothing
 *   npm run nnue:setup -- --bucket=my-nets
 *   npm run nnue:setup -- --origin=https://chess.example.com   # repeatable
 *   npm run nnue:setup -- --no-write-env
 *
 * Idempotent: re-running is how you recover from a half-finished setup, and how
 * you re-upload after a Stockfish upgrade changes the net's filename.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readNetFileName } from './nnue-net-config.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const DEFAULT_BUCKET = 'chess-coach-nnue';
/** The production origin from DEPLOY.md § Production host. A CORS rule naming the
 *  wrong origin fails exactly like no rule at all, so this is a real default
 *  rather than a placeholder — override with `--origin=`. */
const DEFAULT_ORIGINS = ['https://chess-coach-bip.pages.dev', 'http://localhost:5173'];

function fail(msg) {
  console.error(`\n[nnue-setup] ✗ ${msg}`);
  process.exit(1);
}
const ok = (m) => console.log(`[nnue-setup] ✓ ${m}`);
const info = (m) => console.log(`[nnue-setup]   ${m}`);
const step = (m) => console.log(`\n[nnue-setup] ── ${m}`);

/* ---------------------------------------------------------------- args --- */

let bucket = DEFAULT_BUCKET;
let dryRun = false;
let writeEnv = true;
const origins = [];

for (const a of process.argv.slice(2)) {
  if (a === '--dry-run') dryRun = true;
  else if (a === '--no-write-env') writeEnv = false;
  else if (a.startsWith('--bucket=')) bucket = a.slice('--bucket='.length);
  else if (a.startsWith('--origin=')) origins.push(a.slice('--origin='.length));
  else if (a === '-h' || a === '--help') {
    console.log(
      'Usage: npm run nnue:setup [-- flags]\n\n' +
        `  --bucket=NAME     R2 bucket (default ${DEFAULT_BUCKET})\n` +
        '  --origin=URL      Allowed CORS origin; repeatable. Defaults to\n' +
        `                    ${DEFAULT_ORIGINS.join(' and ')}\n` +
        '  --no-write-env    Do not write .env.production; just print the value\n' +
        '  --dry-run         Print every command and change nothing\n',
    );
    process.exit(0);
  } else fail(`unknown argument ${a}`);
}

const corsOrigins = origins.length ? origins : DEFAULT_ORIGINS;
const want = readNetFileName(repoRoot);

console.log(`[nnue-setup] net      ${want}`);
console.log(`[nnue-setup] bucket   ${bucket}`);
console.log(`[nnue-setup] origins  ${corsOrigins.join(', ')}`);
if (dryRun) console.log('[nnue-setup] DRY RUN — nothing will be created or uploaded');

/* ------------------------------------------------------------- wrangler --- */

/**
 * Run a wrangler subcommand.
 *
 * `capture` returns stdout instead of streaming it, for the commands whose output
 * we need to parse. `tolerate` is a regex of stderr text that means "already in
 * the desired state" — creating a bucket that exists is success for an idempotent
 * setup, not failure.
 */
function wrangler(args, { capture = false, tolerate = null, label } = {}) {
  const printable = `npx wrangler ${args.join(' ')}`;
  if (dryRun) {
    info(`would run: ${printable}`);
    return { dryRun: true, stdout: '' };
  }
  const res = spawnSync('npx', ['--yes', 'wrangler@4', ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: capture ? ['inherit', 'pipe', 'pipe'] : 'inherit',
  });
  if (res.error) fail(`could not run wrangler (${res.error.message})`);
  if (res.status !== 0) {
    const err = `${res.stdout ?? ''}${res.stderr ?? ''}`;
    if (tolerate && tolerate.test(err)) return { tolerated: true, stdout: res.stdout ?? '' };

    // R2 is opt-in per account and cannot be enabled from the CLI — the API
    // answers 10042 until someone activates it in the dashboard. Worth catching by
    // name, because the generic "a request to the Cloudflare API failed" reads like
    // a credentials or networking fault and sends you looking in the wrong place.
    if (/\b10042\b|enable R2 through the Cloudflare Dashboard/i.test(err)) {
      fail(
        'R2 is not enabled on this Cloudflare account.\n' +
          '  It is a one-time account-level activation and the CLI cannot do it:\n' +
          '    dash.cloudflare.com → R2 → enable R2\n' +
          '  The free tier covers this comfortably, but Cloudflare still wants a card\n' +
          '  on file. The net is ~$0.0006/month of storage and zero egress.\n' +
          '  Then re-run `npm run nnue:setup` — it does everything else.',
      );
    }

    // Reported wherever it surfaces, not just at `whoami`: a token can be valid
    // and still lack R2 scopes.
    if (/not authenticated|Authentication error|\b10000\b/i.test(err)) {
      fail(
        'wrangler could not authenticate for this operation.\n' +
          '  Run `npx wrangler login`, or set CLOUDFLARE_API_TOKEN to a token with\n' +
          '  "Workers R2 Storage: Edit" on this account, then re-run.',
      );
    }

    if (capture && err) console.error(err);
    fail(`${label ?? printable} failed (exit ${res.status})`);
  }
  return { stdout: res.stdout ?? '' };
}

/* ------------------------------------------------------------------ 0 ---- */
step('checking wrangler auth');
if (dryRun) {
  info('would run: npx wrangler whoami');
} else {
  const who = wrangler(['whoami'], { capture: true, label: 'wrangler whoami' });
  const email = /([\w.+-]+@[\w.-]+\.\w+)/.exec(who.stdout);
  ok(`authenticated${email ? ` as ${email[1]}` : ''}`);
  if (/You are not authenticated/i.test(who.stdout)) {
    fail(
      'wrangler is not logged in.\n' +
        '  Run `npx wrangler login` (it opens a browser), or set CLOUDFLARE_API_TOKEN\n' +
        '  to a token with R2 read/write on this account, then re-run this script.',
    );
  }
}

/* ------------------------------------------------------------------ 1 ---- */
step(`creating bucket ${bucket}`);
const created = wrangler(['r2', 'bucket', 'create', bucket], {
  capture: true,
  // Already existing is the normal case on a re-run.
  tolerate: /already exists|10004|already owned by you/i,
  label: `wrangler r2 bucket create ${bucket}`,
});
ok(created.tolerated ? `bucket ${bucket} already exists` : `bucket ${bucket} ready`);

/* ------------------------------------------------------------------ 2 ---- */
step('enabling public access (r2.dev)');
wrangler(['r2', 'bucket', 'dev-url', 'enable', bucket, '--force'], {
  capture: true,
  tolerate: /already enabled/i,
  label: 'wrangler r2 bucket dev-url enable',
});
ok('public access enabled');

/* ------------------------------------------------------------------ 3 ---- */
step('reading the public URL');
let publicBase = null;
if (dryRun) {
  info('would run: npx wrangler r2 bucket dev-url get ' + bucket);
  publicBase = 'https://pub-<hash>.r2.dev';
  info(`would then use: ${publicBase}`);
} else {
  const got = wrangler(['r2', 'bucket', 'dev-url', 'get', bucket], {
    capture: true,
    label: 'wrangler r2 bucket dev-url get',
  });
  // Read it rather than construct it: the hash is account-specific.
  const m = /(https?:\/\/pub-[a-z0-9]+\.r2\.dev)/i.exec(got.stdout);
  if (!m) {
    fail(
      'could not find a pub-*.r2.dev URL in `wrangler r2 bucket dev-url get` output:\n' +
        `----\n${got.stdout.trim()}\n----\n` +
        '  Read the Public Development URL off the bucket\'s Settings page instead and\n' +
        '  pass it to `npm run nnue:upload` via VITE_NNUE_NET_URL.',
    );
  }
  publicBase = m[1];
  ok(`public URL ${publicBase}`);
}

/* ------------------------------------------------------------------ 4 ---- */
step('setting the CORS rule');
// The one header that actually matters. Measured: both the app's HEAD probe and
// Stockfish's own net download are CORS-mode requests, and a CORS response
// satisfies `COEP: require-corp` by itself — so no CORP, no custom domain, no
// Transform Rule is needed. See DEPLOY.md § The only header that matters is CORS.
//
// NOTE THE SHAPE. R2 accepts two different JSON schemas for the same policy, and
// they are not interchangeable:
//
//   wrangler / the R2 API   { "rules": [ { "allowed": { "origins", "methods",
//                                          "headers" }, "maxAgeSeconds" } ] }
//   the dashboard's paste   [ { "AllowedOrigins", "AllowedMethods", … } ]   (S3 style)
//
// Feeding the dashboard's PascalCase form to wrangler fails with "must contain a
// 'rules' array". If you copy a policy out of an S3 tutorial or the R2 dashboard,
// it needs translating first.
const corsPolicy = {
  rules: [
    {
      allowed: {
        origins: corsOrigins,
        methods: ['GET', 'HEAD'],
        // Not load-bearing: a GET/HEAD with no custom request headers is a
        // "simple" request and never triggers a preflight. Kept permissive so a
        // future caller that does send a header doesn't fail mysteriously.
        headers: ['*'],
      },
      maxAgeSeconds: 86400,
    },
  ],
};
const corsFile = join(repoRoot, '.r2-cors.json');
if (dryRun) {
  info(`would write ${corsFile}:`);
  console.log(JSON.stringify(corsPolicy, null, 2).replace(/^/gm, '                '));
  info(`would run: npx wrangler r2 bucket cors set ${bucket} --file .r2-cors.json`);
} else {
  writeFileSync(corsFile, `${JSON.stringify(corsPolicy, null, 2)}\n`);
  try {
    wrangler(['r2', 'bucket', 'cors', 'set', bucket, '--file', corsFile, '--force'], {
      capture: true,
      label: 'wrangler r2 bucket cors set',
    });
    ok(`CORS allows ${corsOrigins.join(', ')}`);
  } finally {
    // A temp file, not config: the policy is generated from flags above, and a
    // stale copy on disk would be a second source of truth.
    try {
      const { unlinkSync } = await import('node:fs');
      unlinkSync(corsFile);
    } catch {
      /* already gone */
    }
  }
}

/* ------------------------------------------------------------------ 5 ---- */
step('uploading the net and verifying the browser can load it');
if (dryRun) {
  info(`would run: VITE_NNUE_NET_URL=${publicBase} node scripts/upload-nnue.mjs --bucket=${bucket}`);
} else {
  const up = spawnSync(
    process.execPath,
    [join(repoRoot, 'scripts', 'upload-nnue.mjs'), `--bucket=${bucket}`],
    {
      cwd: repoRoot,
      stdio: 'inherit',
      // Passed through the environment so the upload script resolves exactly the
      // URL we just read, rather than whatever is configured on this machine.
      env: { ...process.env, VITE_NNUE_NET_URL: publicBase },
    },
  );
  if (up.status !== 0) {
    fail(
      'upload/verify failed — see the output above. The bucket and CORS rule are\n' +
        '  already set up, so re-running this script is safe.',
    );
  }
}

/* ------------------------------------------------------------------ 6 ---- */
step('recording the URL for production builds');

const envProdPath = join(repoRoot, '.env.production');
const line = `VITE_NNUE_NET_URL=${publicBase}`;

if (!writeEnv) {
  info('--no-write-env: not touching .env.production. Set this yourself:');
  console.log(`\n    ${line}\n`);
  info('either in .env.production, or as a Pages build environment variable.');
} else if (dryRun) {
  info(`would ensure ${envProdPath} contains:`);
  console.log(`\n    ${line}\n`);
} else {
  const header = `# Committed production build config. NOT secrets — every VITE_* value here is
# inlined into the client bundle and readable by anyone using the app.
#
# Vite reads this file for \`vite build\` (mode=production) and NOT for
# \`npm run dev\`, which is exactly what we want: production loads the NNUE net
# from R2, while dev keeps using the copy staged into public/stockfish/ and so
# still works offline.
#
# A real environment variable outranks this file, so setting VITE_NNUE_NET_URL in
# the Cloudflare Pages environment overrides the value below without a code
# change.
#
# Written by \`npm run nnue:setup\`. See DEPLOY.md § The NNUE network.
`;
  let next;
  if (existsSync(envProdPath)) {
    const current = readFileSync(envProdPath, 'utf8');
    next = /^\s*VITE_NNUE_NET_URL\s*=/m.test(current)
      ? current.replace(/^\s*VITE_NNUE_NET_URL\s*=.*$/m, line)
      : `${current.replace(/\n*$/, '\n')}${line}\n`;
  } else {
    next = `${header}\n${line}\n`;
  }
  writeFileSync(envProdPath, next);
  ok(`.env.production now sets ${line}`);
  info('commit it — that is what makes production builds pick the net up.');
}

/* ---------------------------------------------------------------- done --- */

console.log(
  `\n[nnue-setup] ${dryRun ? 'dry run complete.' : 'done.'}\n` +
    (dryRun
      ? '[nnue-setup] Re-run without --dry-run to actually do it.\n'
      : '[nnue-setup] Next: commit .env.production and push. Then confirm on the live\n' +
        '[nnue-setup] site that analysis reports stockfish-16-nnue and the network panel\n' +
        `[nnue-setup] shows one 38.3 MiB GET to ${publicBase ?? 'the bucket'}.\n`),
);
