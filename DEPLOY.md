# Deployment — Cloudflare Pages + GitHub Actions

> One-time setup to deploy Chess Coach to Cloudflare Pages with a
> GitHub-Actions-driven CI pipeline. Companion to `SETUP_AUTH.md`.
> Estimated time: ~20 minutes.

## What we're building

```
                           ┌─────────────────────────────────┐
                           │   git push to main / open PR    │
                           └────────────┬────────────────────┘
                                        │
                  ┌─────────────────────┴─────────────────────┐
                  ▼                                           ▼
   ┌────────────────────────────┐            ┌──────────────────────────────┐
   │   GitHub Actions (tests)   │            │  Cloudflare Pages (deploy)   │
   │                            │            │                              │
   │  • npm run typecheck       │            │  • npm run build             │
   │  • npm test (unit + integ) │            │  • upload dist/ to CDN       │
   │  • npm run test:e2e        │            │  • preview URL on PRs        │
   │                            │            │  • production deploy on main │
   │  Status checks on PR       │            │  Status check on PR          │
   └────────────────────────────┘            └──────────────────────────────┘
                  │                                           │
                  └────────────┬──────────────────────────────┘
                               ▼
              Branch protection: all checks must pass to merge
```

Two pipelines, one branch-protection rule. CF Pages does what it's good
at (build + CDN upload + preview URLs); GitHub Actions does what *it*'s
good at (running the test suite with full Linux + Playwright + Stockfish
WASM access).

---

## 0. Going live — quick checklist

The fastest "make Chess Coach + the chrome extension live for real
people" path. Each step links to the section that goes deep:

1. **Deploy the app** (§1–§3): create the CF Pages project, paste in
   the three Clerk + Supabase env vars, click Deploy. First green
   build gets you a `https://<project>.pages.dev` URL.
2. **Verify the deploy** (§3): one console check
   (`crossOriginIsolated === true`), one hard-refresh check, one
   sign-in round-trip. Five minutes.
3. **Update Clerk allow-list**: add the `pages.dev` URL (and any
   custom domain) to Clerk → Domains and to every OAuth provider's
   redirect URLs. Without this, sign-in loops.
4. **(Optional) Custom domain** (§5): if you want `chess.example.com`
   instead of the `.pages.dev` URL, do this **before** sharing the
   URL with anyone — IndexedDB is keyed by origin and migrating
   later costs each user a backup-export-restore.
5. **Build the chrome extension for that origin**:
   ```bash
   npm run extension:build -- --coach-origin=https://<your-prod-host>
   ```
   Produces `dist-extension/chess-coach-<version>.zip` with your
   production URL baked in as the default `coachOrigin`. First-time
   installs land with the right URL preconfigured — no options-page
   visit required for a working install.
6. **Distribute the extension**:
   - **Personal / a few friends**: send them the zip. They unzip
     locally and Load Unpacked from `chrome://extensions`.
   - **Public install**: upload the zip to the Chrome Web Store
     dashboard (`https://chrome.google.com/webstore/devconsole`).
     One-time $5 developer registration; review takes ~1–3 days.
7. **Smoke-test the live loop** end-to-end: open Chrome with the
   extension installed, finish any chess.com game, click "Review",
   confirm the deep link lands on `https://<your-prod-host>/review/<id>`
   and analysis kicks off.

Everything below is the deeper version of these steps plus
operational notes (rolling back, cache busting, troubleshooting).

---

## 1. Prerequisites

- A GitHub repo for this project (push access).
- A Cloudflare account (free tier is fine).
- A Clerk app set up per `SETUP_AUTH.md` §1.
- A Supabase project set up per `SETUP_AUTH.md` §2.
- Optionally: a custom domain you control (recommended -- see §6).

## 2. Cloudflare Pages — connect the repo (~5 min)

1. Go to <https://dash.cloudflare.com>, pick your account, and open
   **Workers & Pages** → **Create** → **Pages** → **Connect to Git**.
2. Authorize Cloudflare to access your GitHub. Pick the chess repo.
3. **Project name**: `chess-coach` (or whatever; you can rename later).
4. **Production branch**: `main`.
5. **Build configuration**:

   | Field                       | Value          |
   | --------------------------- | -------------- |
   | Framework preset            | `Vite`         |
   | Build command               | `npm run build` |
   | Build output directory      | `dist`         |
   | Root directory              | `/` (default)  |

6. **Environment variables** — click **Add variable** for each. CF Pages
   distinguishes **Production** and **Preview** environments; set each
   variable for **both**. The values are the same as your local
   `.env.local` (see `SETUP_AUTH.md`):

   - `VITE_CLERK_PUBLISHABLE_KEY`
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
   - `NODE_VERSION` = `20` (forces the build container to Node 20; the
     default has historically been older).

   Do **not** set `VITE_E2E_AUTH_BYPASS` here. The bypass is gated on
   `import.meta.env.MODE === 'development'` in `src/lib/testAuth.ts`, so
   production builds can't reach it -- but defense in depth: the var
   simply must not exist on prod.

7. Click **Save and Deploy**. The first build takes 2-4 minutes.

## 3. Verify the first deploy (cross-origin isolation + SPA fallback)

CF assigns `<project>.pages.dev` (e.g. `chess-coach.pages.dev`) and a
preview URL per branch. Open the production URL and run this checklist:

1. **Cross-origin isolation is on** (multi-thread Stockfish enabled):

   - Open DevTools console, run `crossOriginIsolated`. Must return `true`.
   - If `false`, something is stripping COOP/COEP. Check the response
     headers on `/`:
     ```bash
     curl -I https://chess-coach.pages.dev/
     ```
     `cross-origin-opener-policy: same-origin` and
     `cross-origin-embedder-policy: require-corp` must be present.
     If either is missing, the `public/_headers` file didn't get
     deployed -- confirm it's in `dist/_headers` after a local
     `npm run build`.

2. **Multi-thread Stockfish loads** (not the single-thread fallback):

   - DevTools → Network → reload the page → trigger any analysis.
   - You should see `stockfish-nnue-16.js` and its `.wasm`, **not**
     `stockfish-nnue-16-single.js`.

3. **SPA fallback works**:

   - Visit `https://chess-coach.pages.dev/dashboard` directly (hard
     refresh, not via in-app navigation). It must render the dashboard,
     not a 404. If it 404s, `public/_redirects` didn't deploy.

4. **Sign-in works end-to-end**:

   - Add the production URL to Clerk's **Allowed origins**:
     <https://dashboard.clerk.com> → your app → **Domains** → add
     `chess-coach.pages.dev`.
   - Add `chess-coach.pages.dev` to **OAuth redirect URLs** for any
     enabled providers (Google, GitHub).
   - For preview URLs, add the wildcard `*.chess-coach.pages.dev`
     (Clerk supports `*.` as a single-level wildcard).
   - Try Sign in with Google. You should land on `/dashboard` with the
     `<UserButton />` rendered in the header.

5. **Onboarding wizard runs**:

   - On first sign-in you should be redirected to `/onboarding`.
   - Confirm a Chess.com username. The "Is this you?" card with avatar
     should render -- which proves Chess.com API calls work from the
     production origin.
   - Pick the 1m import preset. Confirm games land in the dashboard.

If step 1 fails specifically because **Clerk's sign-in widget is
broken under COEP** (you'll see `NotSameOriginAfterDefaultedToSameOriginByCoep`
errors in the console), swap `Cross-Origin-Embedder-Policy: require-corp`
to `Cross-Origin-Embedder-Policy: credentialless` in `public/_headers`.
`credentialless` still enables `SharedArrayBuffer` (Stockfish keeps
working multi-threaded) but is more permissive about cross-origin
loads. Document the swap here if you have to do it.

## 4. GitHub Actions — already in the repo

Two workflows ship with this repo:

- **`.github/workflows/ci.yml`** — runs on every push to `main` and every
  PR targeting `main`. Two jobs in sequence:

  - `Typecheck + unit + integration`: `npm run typecheck`, `npm run
    test:unit`, then starts a background `npm run dev` and runs `npm
    run test:integration` against it.
  - `Playwright e2e` (depends on the unit job passing): same dev-server
    pattern, runs `npm run test:e2e`.

  Both jobs upload Playwright traces + the dev-server log on failure
  (`test-results/`, retained 7 days).

- **`.github/workflows/live.yml`** — runs daily at 06:17 UTC, plus
  `workflow_dispatch` for manual runs. Hits the real Chess.com API
  (`npm run test:live`). Uses `continue-on-error: true` because Chess.com
  occasionally rate-limits or has transient outages, and we don't want
  that flake to page anyone or block a deploy.

### CI env vars (why real values, not dummies)

Both workflows read three GitHub Actions secrets:

```yaml
VITE_CLERK_PUBLISHABLE_KEY: ${{ secrets.VITE_CLERK_PUBLISHABLE_KEY }}
VITE_SUPABASE_URL: ${{ secrets.VITE_SUPABASE_URL }}
VITE_SUPABASE_ANON_KEY: ${{ secrets.VITE_SUPABASE_ANON_KEY }}
```

These need to be set as **repository secrets** at
`https://github.com/<owner>/chess-coach/settings/secrets/actions`. Copy
the values from your local `.env.local`.

Why real values, not dummies: `<ClerkProvider>` mounts at the router
root in `src/lib/clerk.tsx` regardless of the auth-bypass flag — the
bypass replaces the auth *hooks* (`useAuth` / `useUser`), not the
provider. Clerk's provider eagerly validates the publishable key on
mount; not just the prefix check we do in `src/lib/env.ts`, but a
deeper decode of the embedded Frontend API URL. A made-up `pk_test_…`
string passes our prefix check and then crashes inside
`ClerkProviderBase`, which takes down the React tree, which means
`<AppLayout>` never mounts, which means `startAnalysisQueue()` never
fires — and tests like `full-queue` / `heal` time out waiting for
games to be analyzed.

These values are public-by-design (they already ship in every user's
browser bundle in production). Putting them in repo secrets is
operational hygiene, not a security boundary, and lets us rotate keys
without a workflow edit.

If this ever breaks because someone forgets to add the secrets, the
canary failure pattern is: `auth-bypass` fails the
`AppLayout header rendered: expected true, got false` assertion, with
`@clerk/clerk-react: The publishableKey passed to Clerk is invalid` in
the page-error log on every failed test that depends on the React tree
mounting.

### Branch protection (the gating step)

In GitHub repo settings → **Branches** → **Add rule** for `main`:

- ☑ Require a pull request before merging
- ☑ Require status checks to pass before merging
- Required status checks (these names must match the job names):
  - `Typecheck + unit + integration`
  - `Playwright e2e`
  - `Cloudflare Pages — chess-coach (Preview)` (CF auto-creates this
    check once the repo is connected; click **Search for status checks**
    after the first preview deploy lands)
- ☑ Require branches to be up to date before merging
- ☐ Do not allow bypassing the above settings (toggle on if you want
  the rule to apply to admins too; for a solo project you may want this
  off so you can hot-fix without ceremony)

## 5. Custom domain (recommended)

**The IndexedDB-origin pin matters in production too.** IndexedDB is
keyed by origin; if you migrate users from `chess-coach.pages.dev` to
`yourchess.app` later, their imported games will look "missing" on the
new origin. The `BackupPage` makes this recoverable (export → re-import)
but you don't want to ask real users to do that.

So: **decide your production hostname before sharing the URL with anyone
real.** If you'll use a custom domain eventually, do it now.

In the CF Pages dashboard:

1. Open your project → **Custom domains** → **Set up a custom domain**.
2. Enter the hostname (e.g. `chess.example.com` or apex `example.com`).
3. CF will instruct you to either move DNS to Cloudflare or add a CNAME.
4. Wait for the cert to provision (usually <2 min).
5. Update Clerk **Allowed origins** + **OAuth redirect URLs** to add the
   new hostname.
6. Re-run the §3 verification checklist on the new hostname.

If you skip the custom domain for now, `chess-coach.pages.dev` is fine
-- just **don't change it later** without warning users.

## 6. Operational notes

### Rolling back

CF Pages keeps every prior deploy. To roll back:

1. Project → **Deployments** → find the last known-good deploy.
2. Click **⋯** → **Rollback**. Production traffic switches in <30s.

This is safe to do at any time. The deploy is atomic (engine + bundle +
headers all roll back together) precisely because everything lives in
the same `dist/` artifact -- which is the architectural reason we keep
Stockfish bundled with the app rather than on a separate origin.

### Cache busting

If you ship a Stockfish version bump, the `immutable` cache rule on
`/stockfish/*` means returning visitors keep the old binary until the
filename changes. Two ways to handle this:

1. **Preferred**: bump the filename when bumping the engine (e.g.
   `stockfish-nnue-17.js`) and update `src/engine/engine.ts` accordingly.
   Atomic, no manual cache work.
2. **Fallback**: in the CF dashboard, **Caching** → **Configuration** →
   **Purge Cache** → **Custom Purge** → enter the absolute URL. Done.

For a normal Vite deploy you don't need to do anything; Vite hashes
asset filenames so old bundles age out automatically.

### Cost ceiling

Free tier covers everything we need today:

- **Bandwidth**: unlimited on Pages.
- **Builds**: 500/month.
- **Concurrent builds**: 1 (sequential queue).
- **Custom domains**: unlimited.
- **GH Actions free minutes**: 2000/mo for public repos, unlimited for
  public repos -- effectively free for this project's CI volume.

If we ever blow past free, the next tier is $5/mo. The architecture
doesn't have to change.

## 7. Troubleshooting

| Symptom                                        | Likely cause                                         | Fix                                                                                                                                                                |
| ---------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `crossOriginIsolated === false` in prod         | `_headers` not deployed or being stripped            | `npm run build && ls dist/_headers`. If absent, confirm the file is in `public/` (Vite auto-copies) and not `.gitignored`. Check headers via `curl -I`.            |
| Sign-in redirects loop                         | OAuth redirect URL not whitelisted in Clerk           | Add the prod hostname (and `*.pages.dev` for previews) to Clerk → Domains and OAuth providers.                                                                     |
| Hard refresh on `/review/<id>` 404s             | `_redirects` not deployed                            | Same fix as `_headers` -- verify `dist/_redirects` exists after build.                                                                                             |
| Stockfish loads single-thread on prod          | COEP not active                                      | `crossOriginIsolated` must be `true`. See first row.                                                                                                               |
| All games error with `Stockfish worker failed to start (worker error)`, `crossOriginIsolated === true`, JS/WASM fetch 200, but `new Worker('/stockfish/...')` fires `error` with empty `message` / `filename` / `lineno` | Duplicate `Cross-Origin-Embedder-Policy` header on `/stockfish/*`. Cloudflare Pages **appends** per-route `_headers` rules on top of the wildcard `/*` block — re-declaring `COEP: require-corp` on `/stockfish/*` produces a response with the header listed twice, which Chromium rejects when loading a worker script. Confirm with `curl -sI /stockfish/stockfish-nnue-16.js \| grep -i embedder` (should show **one** line, not two). | Remove `Cross-Origin-Embedder-Policy: require-corp` from the `/stockfish/*` block in `public/_headers`. The wildcard `/*` already covers it. Keep `Cross-Origin-Resource-Policy: same-origin` on `/stockfish/*` since the wildcard doesn't set CORP. |
| Clerk widget shows blank / console COEP errors | `require-corp` blocking Clerk's cross-origin scripts  | Swap to `Cross-Origin-Embedder-Policy: credentialless` in `public/_headers`.                                                                                       |
| CI fails on dev-server start                   | Port 5173 occupied by something or env var missing    | Check the uploaded `vite.log` artifact. If the error is `ENV missing`, the dummy CI env vars in the workflow regressed.                                            |
| CI integration tests timeout                   | Stockfish init slow under Actions runner              | Already give the harness 60s for dev-server boot + each test has its own timeout. If consistently slow, bump `timeout-minutes` on the `unit` job.                  |
| `pages.dev` works but custom domain 404s       | DNS not pointing to CF or cert still provisioning     | CF dashboard → Custom domains → check status. Wait up to 5 min after first setup.                                                                                  |

## 8. What to update if you change deploy infra

- **Different host**: keep the `_headers` / `_redirects` files (Netlify
  uses the same format; Vercel needs a `vercel.json`). Update §1-3 of
  this file.
- **Different Node version**: change the `node-version` in both
  workflows AND the `NODE_VERSION` env var in CF Pages.
- **New build script**: update CF Pages **Build command** AND keep
  `npm run typecheck` / `npm test` working in CI; both pipelines must
  agree on what "build green" means.

## 9. Chrome extension distribution

The extension lives at `extension/` and pairs with the deployed app
via the `/review-by-url` deep-link route. There are three install
paths, ordered from "least friction for you" to "least friction for
your users".

### 9a. Personal / dev install (load-unpacked)

For your own use against `npm run dev`:

1. `chrome://extensions` → Developer mode on → Load unpacked → pick
   `extension/`.
2. Options page opens automatically. Fill in your Chess.com username;
   leave the URL at the localhost default.

The source tree's default origin is `http://localhost:5173`. That's
the right thing for a maintainer running `npm run dev`; it's the
wrong thing for a real user installing from a zip you sent them. For
those, use 9b.

### 9b. Side-loaded zip with production URL baked in

```bash
npm run extension:build -- --coach-origin=https://<your-prod-host>
```

Produces `dist-extension/chess-coach-<version>.zip`. The build
script:

- Copies `extension/` to a clean staging directory (drops
  `README.md`, dotfiles, `.DS_Store`).
- Rewrites the `DEFAULT_COACH_ORIGIN` constant in `options.js` to
  the URL you passed.
- Validates the URL with `new URL(...)`, strips trailing slash,
  fails fast on a typo.
- Zips with the manifest at root (Chrome Web Store requires this).

Recipients unzip the file and Load Unpacked from `chrome://extensions`.
First-time install lands with your production URL preconfigured;
they only need to enter their Chess.com username.

`--output=path/to/foo.zip` overrides the output path if you want to
publish a custom-named zip.

### 9c. Chrome Web Store publish

For wide distribution. One-time setup: create a developer account at
`https://chrome.google.com/webstore/devconsole` ($5 registration).

For each release:

1. Bump `extension/manifest.json`'s `version` field (semver-ish,
   chrome only enforces `x.y.z.w` numeric form).
2. `npm run extension:build -- --coach-origin=https://<your-prod-host>`.
3. Upload `dist-extension/chess-coach-<version>.zip` to the
   developer console → your item → New version → Upload package.
4. First-ever submission also asks for: a 128×128 icon, 1280×800
   screenshots, a privacy policy URL, and a "Single Purpose"
   declaration. The single purpose for this extension is: **"Detect
   the end of a Chess.com game and offer a deep link into the user's
   own Chess Coach review tool."** Keep that wording — it matches
   what the extension actually does, which is the Web Store's
   sole acceptance criterion.
5. Review usually takes 1–3 business days. Updates after the first
   approval are typically auto-approved within hours.

### Updating the live extension

The extension does not auto-pull from the source tree once installed.
If you change `content.js` or `options.html`:

- **Side-loaded users**: send them the new zip; they remove + Load
  Unpacked again, or click "Update" in `chrome://extensions` if they
  loaded from a folder.
- **Web Store users**: bump the manifest version, rebuild, upload.
  Chrome auto-pushes within 24h once approved.

Bumping the manifest version on every change is cheap (one digit)
and pays for itself the first time you have to debug "is the user on
the new content script or the old one?".
