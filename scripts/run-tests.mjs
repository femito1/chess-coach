#!/usr/bin/env node
// Unified test runner. Single entry point for every kind of test we have:
//
//   node scripts/run-tests.mjs                    # default = unit + integration
//   node scripts/run-tests.mjs --unit             # vitest only (no browser)
//   node scripts/run-tests.mjs --integration      # browser scripts (synthetic data)
//   node scripts/run-tests.mjs --e2e              # browser scripts driving real UI
//   node scripts/run-tests.mjs --live             # browser scripts hitting Chess.com
//   node scripts/run-tests.mjs --all              # everything (slow)
//   node scripts/run-tests.mjs --only=eval-cache  # one named browser script
//
// Combine flags freely, e.g. `--unit --integration`. `--all` is a
// shorthand for `--unit --integration --e2e --live`.
//
// The runner expects the dev server to be running (default
// http://localhost:5173/) for any non-unit category. It pings it once
// up front and bails early if it's down.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { BROWSER_TESTS, pickBrowserTests, CATEGORIES } from './test/manifest.mjs';
import { ensureDevServer, DEFAULT_URL } from './test/harness.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

function parseArgs(argv) {
  const flags = {
    unit: false,
    integration: false,
    e2e: false,
    live: false,
    only: null,
    bail: false,
  };
  for (const arg of argv) {
    if (arg === '--all') {
      flags.unit = flags.integration = flags.e2e = flags.live = true;
    } else if (arg === '--unit') flags.unit = true;
    else if (arg === '--integration') flags.integration = true;
    else if (arg === '--e2e') flags.e2e = true;
    else if (arg === '--live') flags.live = true;
    else if (arg === '--bail') flags.bail = true;
    else if (arg.startsWith('--only=')) flags.only = arg.slice('--only='.length);
    else if (arg === '-h' || arg === '--help') {
      printHelp();
      process.exit(0);
    } else {
      console.error(`Unknown arg: ${arg}`);
      printHelp();
      process.exit(2);
    }
  }
  // Default: unit + integration.
  if (!flags.unit && !flags.integration && !flags.e2e && !flags.live && !flags.only) {
    flags.unit = true;
    flags.integration = true;
  }
  return flags;
}

function printHelp() {
  console.log(`Usage: node scripts/run-tests.mjs [flags]

Flags:
  --unit          Run vitest unit tests (no browser).
  --integration   Run browser-driven tests with synthetic data.
  --e2e           Run browser-driven tests that exercise the real UI.
  --live          Run browser-driven tests that hit the live Chess.com API.
  --all           Shorthand for --unit --integration --e2e --live.
  --only=NAME     Run a single browser-driven test by name (see manifest).
  --bail          Stop at the first failing test.

Categories (${CATEGORIES.join(', ')}):
${BROWSER_TESTS.map((t) => `  ${t.category.padEnd(11)} ${t.name}`).join('\n')}
`);
}

async function runVitest() {
  return runChild('npx', ['vitest', 'run', '--reporter=default'], { stdio: 'inherit' });
}

async function runBrowserScript(scriptFile) {
  const abs = resolve(repoRoot, scriptFile);
  if (!existsSync(abs)) {
    return { ok: false, code: 127, error: `script not found: ${scriptFile}` };
  }
  return runChild('node', [abs], {
    stdio: 'inherit',
    env: { ...process.env, URL: process.env.URL ?? DEFAULT_URL },
  });
}

function runChild(cmd, args, opts) {
  return new Promise((resolveP) => {
    const child = spawn(cmd, args, opts);
    child.on('close', (code) => resolveP({ ok: code === 0, code }));
    child.on('error', (err) => resolveP({ ok: false, code: -1, error: err.message }));
  });
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const results = [];

  // --only short-circuits everything else.
  if (flags.only) {
    const t = BROWSER_TESTS.find((t) => t.name === flags.only);
    if (!t) {
      console.error(`No browser test named "${flags.only}". Available:`);
      for (const t of BROWSER_TESTS) console.error(`  ${t.name}`);
      process.exit(2);
    }
    await ensureDevServer();
    console.log(`\n══ ${t.category}: ${t.name} (${t.file}) ══`);
    const r = await runBrowserScript(t.file);
    results.push({ name: `${t.category}/${t.name}`, ok: r.ok });
    return summarize(results);
  }

  if (flags.unit) {
    console.log('\n══ unit tests (vitest) ══');
    const r = await runVitest();
    results.push({ name: 'unit', ok: r.ok });
    if (!r.ok && flags.bail) return summarize(results);
  }

  const browserCategories = [];
  if (flags.integration) browserCategories.push('integration');
  if (flags.e2e) browserCategories.push('e2e');
  if (flags.live) browserCategories.push('live');

  if (browserCategories.length) {
    try {
      await ensureDevServer();
    } catch (err) {
      console.error(`\n✗ ${err.message}`);
      process.exit(1);
    }
  }

  for (const cat of browserCategories) {
    const tests = pickBrowserTests(cat);
    console.log(`\n══ ${cat} (${tests.length} script${tests.length === 1 ? '' : 's'}) ══`);
    for (const t of tests) {
      console.log(`\n── ${t.name} (${t.file}) ──`);
      const r = await runBrowserScript(t.file);
      results.push({ name: `${cat}/${t.name}`, ok: r.ok });
      if (!r.ok && flags.bail) return summarize(results);
    }
  }

  return summarize(results);
}

function summarize(results) {
  const passed = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);
  console.log('\n══ summary ══');
  for (const r of results) {
    console.log(`  ${r.ok ? '✓' : '✗'} ${r.name}`);
  }
  console.log(`\n${passed.length}/${results.length} passed`);
  if (failed.length) {
    console.log(`${failed.length} failed:`);
    for (const r of failed) console.log(`  - ${r.name}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
