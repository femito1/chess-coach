#!/usr/bin/env node
// Bundle the worker (and the slice of src/ it reuses) into one Node ESM file.
//
// Why bundle at all: the worker imports `analyzeGamePgn` and friends straight
// from `src/`, which is TypeScript using the `@/` path alias. Bundling resolves
// both without adding a runtime TS loader, and it means the worker ships as a
// single file with no build step on the server.
//
// `@supabase/supabase-js` stays external so it resolves from node_modules at
// runtime like any other dependency.
import { build } from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

for (const [entry, outfile] of [
  ['scripts/worker/main.ts', 'dist-worker/worker.mjs'],
  ['scripts/worker/verify.ts', 'dist-worker/verify.mjs'],
]) {
  await build({
    entryPoints: [join(root, entry)],
    outfile: join(root, outfile),
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'esm',
    external: ['@supabase/supabase-js'],
    alias: { '@': join(root, 'src') },
    logLevel: 'info',
    // The openings bundle is a large generated module; keeping it inlined is the
    // point (book detection needs it) but no need to also ship a sourcemap.
    sourcemap: false,
  });
}
