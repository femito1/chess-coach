import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readdirSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';

// @ts-expect-error -- plain-JS build helper, shared with scripts/copy-nnue.mjs
// and scripts/upload-nnue.mjs so all three agree on where the net comes from.
import { netTarget } from './scripts/nnue-net-config.mjs';

/** Cloudflare Pages refuses to deploy a build containing any single asset
 *  larger than this. Not configurable by us; see DEPLOY.md. */
const PAGES_ASSET_CAP_BYTES = 25 * 1024 * 1024;

/**
 * Last line of defence on where the 38.3 MiB NNUE network ends up.
 *
 * `scripts/copy-nnue.mjs` (`prebuild`) already decides whether to stage the net
 * at all, and in remote mode deletes any stale copy. This plugin exists because
 * that script is skippable: `npx vite build` runs no npm lifecycle hooks, so a
 * working tree with the net staged from an earlier `npm run dev` would quietly
 * ship an over-cap asset and fail the deploy with a message that says nothing
 * about NNUE. Checking `dist/` after the fact catches every route in.
 *
 * Remote mode strips it; same-origin mode warns rather than fails, because
 * self-hosting somewhere without a 25 MiB cap is a legitimate configuration and
 * the net genuinely belongs in `dist/` there.
 */
const nnueNetBuildGuard = {
  name: 'nnue-net-build-guard',
  apply: 'build' as const,
  closeBundle() {
    // Via the shared resolver, not `process.env` directly: Vite bakes
    // `VITE_NNUE_NET_URL` into the bundle from `.env.local` too, and npm does not
    // put that in `process.env`. Reading it the narrow way would let a local
    // production build ship a bundle pointing at R2 *and* a 38.3 MiB net in
    // `dist/` — over the cap and baffling to debug.
    const target = netTarget(__dirname);
    const remote = target.remote && !target.error ? target.url : null;
    const dir = path.resolve(__dirname, 'dist', 'stockfish');

    if (target.remote && target.error) {
      // `prebuild` fails on this, so reaching here means `vite build` was run
      // directly. Say so rather than silently treating it as same-origin.
      console.warn(
        `[nnue] VITE_NNUE_NET_URL (from ${target.from}) ${target.error}\n` +
          '[nnue]   Treating the net as same-origin. Run `npm run build` to have ' +
          'this fail the build instead.',
      );
    }

    let nets: string[];
    try {
      nets = readdirSync(dir).filter((f) => f.endsWith('.nnue'));
    } catch {
      nets = [];
    }

    if (remote) {
      for (const f of nets) {
        const bytes = statSync(path.join(dir, f)).size;
        unlinkSync(path.join(dir, f));
        console.warn(
          `[nnue] removed dist/stockfish/${f} (${mib(bytes)}): VITE_NNUE_NET_URL is ` +
            'set, so the net is served from there and must not be in the bundle. ' +
            '(Running `npm run build` rather than `vite build` avoids this.)',
        );
      }
      console.log(`[nnue] net served remotely from ${remote}`);
      return;
    }

    const oversize = nets
      .map((f) => ({ f, bytes: statSync(path.join(dir, f)).size }))
      .filter(({ bytes }) => bytes > PAGES_ASSET_CAP_BYTES);
    for (const { f, bytes } of oversize) {
      console.warn(
        `\n[nnue] WARNING: dist/stockfish/${f} is ${mib(bytes)}, over Cloudflare ` +
          `Pages' ${mib(PAGES_ASSET_CAP_BYTES)} per-asset cap.\n` +
          "[nnue]   A Pages deploy of this build WILL fail, and the live site will keep\n" +
          '[nnue]   serving the previous one. Set VITE_NNUE_NET_URL to serve the net from\n' +
          '[nnue]   an object store instead — see DEPLOY.md § The NNUE network.\n' +
          '[nnue]   Ignore this if you are deploying somewhere without that cap.\n',
      );
    }
    if (nets.length === 0) {
      console.warn(
        '[nnue] no net in dist/stockfish/ and VITE_NNUE_NET_URL is unset — the ' +
          'deployed app will fall back to the classical evaluator. Run ' +
          '`npm run build` (not `vite build`) to stage it.',
      );
    }
  },
};

function mib(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

// Enables SharedArrayBuffer so threaded Stockfish can run in dev / self-hosted.
// GitHub Pages can't send these headers; we fall back to single-threaded there.
const crossOriginIsolationHeaders = {
  name: 'cross-origin-isolation',
  configureServer(server: {
    middlewares: {
      use: (
        fn: (
          req: { url?: string },
          res: { setHeader: (k: string, v: string) => void },
          next: () => void,
        ) => void,
      ) => void;
    };
  }) {
    server.middlewares.use((req, res, next) => {
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
      // With COEP=require-corp, any resource (including wasm fetched by our own
      // Stockfish worker) must opt into being loadable. Same-origin assets need
      // an explicit CORP header even when same-origin; we mark everything.
      res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
      // Cache Stockfish's NNUE network the way production does.
      //
      // Vite serves everything under `public/` with `Cache-Control: no-cache`,
      // so the 40 MB net is revalidated on every worker start. Production marks
      // `/stockfish/*` immutable (`public/_headers`), and that header is what
      // makes the net a genuinely one-time download: measured via CDP against a
      // persistent profile, a warm visit reports `fromDiskCache: true` with
      // `encodedDataLength: 0`, and a whole pool of workers shares that single
      // cached copy. Matching it here keeps dev honest about prod behaviour and
      // stops local analysis paying for revalidation on every worker.
      //
      // (In a throwaway browser context — which is what every Playwright test
      // uses — there is no persistent disk cache, so each worker does fetch its
      // own 40 MB copy regardless. That is a property of the profile, not of
      // this header.)
      //
      // `immutable` is as truthful here as it is there: the filename carries
      // Stockfish's own hash of the network's contents, so new weights can only
      // ever appear at a new URL.
      const url = (req as { url?: string }).url ?? '';
      if (url.startsWith('/stockfish/') && url.includes('.nnue')) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      }
      next();
    });
  },
};

export default defineConfig({
  plugins: [react(), crossOriginIsolationHeaders, nnueNetBuildGuard],
  base: process.env.GITHUB_PAGES ? '/chess-coach/' : '/',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  // IndexedDB is keyed by origin. If Vite silently moves to :5174 because
  // :5173 is occupied, the new origin starts with an empty database and
  // the user thinks their imported games "vanished". Fail loudly instead.
  server: {
    port: 5173,
    strictPort: true,
  },
  preview: {
    port: 5173,
    strictPort: true,
  },
  worker: {
    format: 'es',
  },
  optimizeDeps: {
    exclude: ['stockfish'],
  },
});
