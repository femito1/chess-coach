import { defineConfig } from 'vitest/config';
import path from 'node:path';

// Vitest config for the unit-test layer (pure-TS / pure-logic tests that
// don't need a real browser). Browser-driven tests live under scripts/test/
// and are run via `npm run test:integration` / `:e2e` / `:live`.
//
// Conventions:
//   - Unit tests live next to the source file as `*.test.ts`.
//   - They must NOT import anything that touches Dexie, IndexedDB, Web
//     Workers, chessground (DOM-dependent), or Stockfish. Anything that
//     does belongs in the Playwright layer.
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    globals: false,
    reporters: ['default'],
    passWithNoTests: false,
    pool: 'threads',
  },
});
