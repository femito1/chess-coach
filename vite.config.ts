import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// Enables SharedArrayBuffer so threaded Stockfish can run in dev / self-hosted.
// GitHub Pages can't send these headers; we fall back to single-threaded there.
const crossOriginIsolationHeaders = {
  name: 'cross-origin-isolation',
  configureServer(server: {
    middlewares: {
      use: (fn: (req: unknown, res: { setHeader: (k: string, v: string) => void }, next: () => void) => void) => void;
    };
  }) {
    server.middlewares.use((_req, res, next) => {
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
      // With COEP=require-corp, any resource (including wasm fetched by our own
      // Stockfish worker) must opt into being loadable. Same-origin assets need
      // an explicit CORP header even when same-origin; we mark everything.
      res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
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
  worker: {
    format: 'es',
  },
  optimizeDeps: {
    exclude: ['stockfish'],
  },
});
