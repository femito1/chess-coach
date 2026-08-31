import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

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
  plugins: [react(), crossOriginIsolationHeaders],
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
