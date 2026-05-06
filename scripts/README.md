# Scripts

Two kinds of scripts live here:

1. **Test scripts** under `scripts/test/{integration,e2e,live}/`. Managed by the unified runner.
2. **Build / data scripts** (`build-openings.mjs`, `check-errors.mjs`, etc).

## Tests — start here

The single source of truth for the test system is **`TESTING.md`** at the repo root. Read it before adding or changing tests. Quick reference:

```bash
npm test                  # default: unit + integration (requires `npm run dev` for integration)
npm run test:unit         # vitest only — pure logic, no browser
npm run test:integration  # browser scripts with synthetic data
npm run test:e2e          # browser scripts driving the real UI
npm run test:live         # browser scripts hitting the live Chess.com API
npm run test:all          # everything (slow, CI-style)
npm run test:watch        # vitest in watch mode
```

Run a single browser-driven script by name:

```bash
node scripts/run-tests.mjs --only=eval-cache
node scripts/run-tests.mjs --only=knight-arrow-toggle
```

Names come from `scripts/test/manifest.mjs`. See `TESTING.md` for the full catalog and conventions.

### Layout

- `scripts/run-tests.mjs` — single entry point (categories: unit, integration, e2e, live).
- `scripts/test/harness.mjs` — shared Playwright bootstrap, `runBrowserTest()`, `expect()`, polling helpers. Every browser script uses it.
- `scripts/test/manifest.mjs` — registry of every browser-driven script and its category.
- `scripts/test/integration/*.mjs` — synthetic-data browser tests.
- `scripts/test/e2e/*.mjs` — real-UI browser tests.
- `scripts/test/live/*.mjs` — Chess.com-API-dependent browser tests.
- `src/**/*.test.ts` — Vitest unit tests next to source.

### Requirements

For any browser category (integration / e2e / live):

```bash
npx playwright install chromium   # one-time
npm run dev                       # leave it running on :5173
```

Override the URL with `URL=http://localhost:5174/` if your dev server is elsewhere. Override the Chess.com username for live tests with `USER_CC=...`.

## Other scripts

```bash
node scripts/build-openings.mjs   # regenerate src/data/openings.generated.ts from data/openings/*.tsv
node scripts/check-errors.mjs     # ad-hoc DB diagnostic
```
