# Deployment — Cloudflare Pages + GitHub Actions

> How to stand Chess Coach up on Cloudflare Pages, and the operational
> reference for keeping it running. Companion to `SETUP_AUTH.md`.
> From-scratch setup: ~20 minutes.

## Production host

**`https://chess-coach-bip.pages.dev`**

The Cloudflare Pages *project* is named `chess-coach`, but the hostname
Cloudflare assigned it is `chess-coach-bip.pages.dev`: Cloudflare
appends a suffix when the plain `<project>.pages.dev` subdomain is
already taken. **The assigned hostname is not derivable from the project
name — never guess it**, or you will end up poking at an unrelated
third-party app that happens to own the subdomain you assumed. The
authoritative sources are:

- the project's page in the Cloudflare Pages dashboard, which lists the
  assigned domain; or
- the **Cloudflare Pages** check on any recent commit on `main` in
  GitHub — its check summary prints the deployment URL.

## How a deploy happens

```
                           ┌─────────────────────────────────┐
                           │   git push to main / open PR    │
                           └────────────┬────────────────────┘
                                        │
                  ┌─────────────────────┴─────────────────────┐
                  ▼                                           ▼
   ┌────────────────────────────┐            ┌──────────────────────────────┐
   │   GitHub Actions (tests)   │            │  Cloudflare Pages (deploy)   │
   │                            │            │  via CF's GitHub integration │
   │  • npm run typecheck       │            │  — NOT a GitHub Action       │
   │  • npm run build           │            │                              │
   │  • npm test (unit + integ) │            │  • npm run build             │
   │  • npm run test:e2e        │            │  • upload dist/ to CDN       │
   │                            │            │  • preview URL on PRs        │
   │  Status checks on PR       │            │  • production deploy on main │
   └────────────────────────────┘            └──────────────────────────────┘

            Tests report status. They do not gate the deploy.
```

Two independent pipelines. CF Pages does what it's good at (build + CDN
upload + preview URLs); GitHub Actions does what *it*'s good at (running
the test suite with full Linux + Playwright + Stockfish WASM access).

**There is no gate between them.** The production branch is `main`, and
Cloudflare's GitHub integration deploys the moment a commit lands there
— it neither waits for CI nor cares whether CI passed, and `main` carries
no branch-protection rule to hold anything back (§4). Two things push to
`main`:

- you, merging or pushing directly;
- `.github/workflows/openings-refresh.yml`, a monthly scheduled job that
  refreshes the bundled opening data. It verifies before it pushes,
  precisely because a push to `main` ships instantly. (ARCHITECTURE.md
  documents how it works.)

Anything that must not ship must not land on `main`.

## The NNUE network and the 25 MiB asset cap

**Cloudflare Pages refuses any single asset larger than 25 MiB.** Stockfish's
NNUE network is 38.3 MiB (40,119,326 bytes), and `prebuild` stages it into
`public/stockfish/` on every build, from where Vite copies it into `dist/`. The
result is a **failing deployment**: the live site keeps serving the last build
that predates the network, and `curl` on `/stockfish/nn-*.nnue` returns the
SPA fallback HTML rather than the file. Two of those three are directly
observable — the deploy of the commit that first staged the net failed while its
parent succeeded, and the file is not served. That the cap is the *reason* is an
inference from it being the only published limit the file breaks, so read the
dashboard build log before acting on it.

Nothing crashes when the network is absent — `nnueNetAvailable()` in
`src/engine/nnue.ts` probes for it and falls back to Stockfish's classical
evaluator with a console warning. The cost is silent and analytical: classical
misjudges quiet and endgame positions, which is where a coaching app draws its
conclusions.

So, until this is resolved, hold two facts together: **`main` deploys are red,
and production evaluations are classical.** Check
`gh api repos/:owner/:repo/commits/<sha>/check-runs` for the `Cloudflare Pages`
conclusion after any push, and read the real build log from the dashboard link
in that check — only the dashboard shows why a Pages build failed.

Three ways out, in rising order of work:

| Option | Effect |
|---|---|
| Keep the net out of the deployed `public/` (stage it for `dev` only) | Deploys go green immediately; production stays on classical eval, deliberately and documented. |
| Serve the net from R2 (or any host that allows a 40 MB object) | Production gets NNUE. The engine fetches the net from inside a Worker under `COEP: require-corp`, so that host must send CORS **and** `Cross-Origin-Resource-Policy: cross-origin`, and `EvalFile` currently passes a bare filename that Stockfish resolves next to the worker script — an off-origin net needs that path handling changed too. |
| Move hosting off Pages | Removes the cap, but re-opens every `_headers` / `_redirects` assumption in §8. |

Whichever is chosen, re-run the §3 net check afterwards, and delete this
section's premise from the docs rather than leaving it to rot.

---

## 0. Quick checklist

The short path from nothing to a live app plus Chrome extension. Each
step links to the section that goes deep:

1. **Deploy the app** (§1–§3): create the CF Pages project, paste in
   the three Clerk + Supabase env vars, deploy. Then read the assigned
   hostname off the project page rather than assuming it. Expect the
   build to fail on the 38.3 MiB NNUE network until that is dealt with —
   see "The NNUE network and the 25 MiB asset cap" above.
2. **Verify the deploy** (§3): one console check
   (`crossOriginIsolated === true`), one `curl` for the NNUE network,
   one hard-refresh check, one sign-in round-trip. Five minutes.
3. **Update Clerk allow-list**: add the production hostname (and any
   custom domain) to Clerk → Domains and to every OAuth provider's
   redirect URLs. Without this, sign-in loops.
4. **(Optional) Custom domain** (§5): if you want `chess.example.com`
   instead of the `.pages.dev` hostname, do this **before** sharing the
   URL with anyone — IndexedDB is keyed by origin, so changing origins
   later leaves every user's imported games behind on the old one.
5. **Build the chrome extension for that origin**:
   ```bash
   npm run extension:build -- --coach-origin=https://chess-coach-bip.pages.dev
   ```
   Produces `dist-extension/chess-coach-<version>.zip` with the
   production URL baked in as the default `coachOrigin`. Fresh installs
   land with the right URL preconfigured — no options-page visit
   required for a working install.
6. **Distribute the extension** (§9):
   - **Personal / a few friends**: send them the zip. They unzip
     locally and Load Unpacked from `chrome://extensions`.
   - **Public install**: upload the zip to the Chrome Web Store
     dashboard (`https://chrome.google.com/webstore/devconsole`).
     One-time $5 developer registration; review takes ~1–3 days.
7. **Smoke-test the live loop** end-to-end: open Chrome with the
   extension installed, finish any chess.com game, click "Review",
   confirm the deep link opens
   `https://chess-coach-bip.pages.dev/review-by-url?…`, lands on
   `/review/<id>`, and analysis kicks off.

Everything below is the deeper version of these steps plus
operational notes (rolling back, cache busting, troubleshooting).

---

## 1. Prerequisites

- A GitHub repo for this project (push access).
- A Cloudflare account (free tier is fine).
- A Clerk app set up per `SETUP_AUTH.md` §1.
- A Supabase project set up per `SETUP_AUTH.md` §2.
- Optionally: a custom domain you control (recommended -- see §5).

## 2. Cloudflare Pages — connect the repo (~5 min)

1. Go to <https://dash.cloudflare.com>, pick your account, and open
   **Workers & Pages** → **Create** → **Pages** → **Connect to Git**.
2. Authorize Cloudflare to access your GitHub. Pick the chess repo.
3. **Project name**: `chess-coach` (or whatever; you can rename later).
   The project name is *not* necessarily the hostname you'll get — see
   **Production host** above.
4. **Production branch**: `main`. Every commit that lands on `main`
   deploys to production with no further gate.
5. **Build configuration**:

   | Field                       | Value          |
   | --------------------------- | -------------- |
   | Framework preset            | `Vite`         |
   | Build command               | `npm run build` |
   | Build output directory      | `dist`         |
   | Root directory              | `/` (default)  |

   **The build command must be `npm run build`, not `vite build`.** The
   `prebuild` lifecycle hook (`scripts/copy-nnue.mjs`) is what stages
   Stockfish's 40 MB NNUE network into `public/stockfish/`, and Vite
   copies `public/` into `dist/` verbatim. A bare `vite build` skips npm
   lifecycle scripts, so `dist/stockfish/nn-*.nnue` never exists, the
   app's runtime probe finds no net, and every analysis silently drops
   to Stockfish's weaker classical evaluator. Nothing about the page
   looks broken — the evals are just wrong. `npm ci` supplies the net in
   `node_modules`, so no extra download or build secret is involved.

6. **Environment variables** — click **Add variable** for each. CF Pages
   distinguishes **Production** and **Preview** environments; set each
   variable for **both**. The values are the same as your local
   `.env.local` (see `SETUP_AUTH.md`):

   - `VITE_CLERK_PUBLISHABLE_KEY`
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
   - `NODE_VERSION` = `20` (pins the build container to Node 20; the
     container default is not guaranteed to match, and must not be
     relied on).

   Do **not** set `VITE_E2E_AUTH_BYPASS` here. The bypass is gated on
   `import.meta.env.MODE === 'development'` in `src/lib/testAuth.ts`, so
   production builds can't reach it -- but defense in depth: the var
   simply must not exist on prod.

7. Save and deploy. A build takes 2-4 minutes.

## 3. Verify a deploy (isolation, engine assets, SPA fallback)

CF assigns the project a `*.pages.dev` hostname —
`chess-coach-bip.pages.dev` for this project — plus a preview URL per
branch. Open the production URL and run this checklist. It's worth
re-running after any change to `public/_headers`, `public/_redirects`,
or the engine files.

1. **Cross-origin isolation is on** (multi-thread Stockfish enabled):

   - Open DevTools console, run `crossOriginIsolated`. Must return `true`.
   - If `false`, something is stripping COOP/COEP. Check the response
     headers on `/`:
     ```bash
     curl -I https://chess-coach-bip.pages.dev/
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

3. **The NNUE network shipped**:

   ```bash
   curl -sI https://chess-coach-bip.pages.dev/stockfish/nn-5af11540bbfe.nnue \
     | grep -iE 'content-length|cache-control|embedder'
   ```

   Expect `content-length: 40119326`, `cache-control: public,
   max-age=31536000, immutable`, and **exactly one**
   `cross-origin-embedder-policy` line (two makes worker loads fail —
   see §7).

   **This check currently fails**, returning `content-type: text/html`
   (the SPA fallback) because the file exceeds Pages' 25 MiB asset cap
   and the deploy never uploaded it — see "The NNUE network and the
   25 MiB asset cap" above. The app falls back to the classical
   evaluator with a console warning rather than crashing, so this will
   not surface on its own. A local build is the way to confirm the
   staging step itself works:
   `npm run build && ls -l dist/stockfish/nn-*.nnue`.

   The filename is a content hash of the network, so it changes when
   Stockfish is upgraded. Read the current one from `NNUE_NET_FILE` in
   `src/engine/nnue.ts` rather than copying it from here.

4. **SPA fallback works**:

   - Visit `https://chess-coach-bip.pages.dev/dashboard` directly (hard
     refresh, not via in-app navigation). It must render the dashboard,
     not a 404. If it 404s, `public/_redirects` didn't deploy.

5. **Sign-in works end-to-end**:

   - Add the production URL to Clerk's **Allowed origins**:
     <https://dashboard.clerk.com> → your app → **Domains** → add
     `chess-coach-bip.pages.dev`.
   - Add `chess-coach-bip.pages.dev` to **OAuth redirect URLs** for any
     enabled providers (Google, GitHub).
   - For preview URLs, add the wildcard `*.chess-coach-bip.pages.dev`
     (Clerk supports `*.` as a single-level wildcard).
   - Try Sign in with Google. You should land on `/dashboard` with the
     `<UserButton />` rendered in the header.

6. **Onboarding wizard runs**:

   - On first sign-in you should be redirected to `/onboarding`.
   - Confirm a Chess.com username. The "Is this you?" card with avatar
     should render -- which proves Chess.com API calls work from the
     production origin.
   - Pick the 1m import preset. Confirm games land in the dashboard.

If step 5 fails specifically because **Clerk's sign-in widget is
broken under COEP** (you'll see `NotSameOriginAfterDefaultedToSameOriginByCoep`
errors in the console), swap `Cross-Origin-Embedder-Policy: require-corp`
to `Cross-Origin-Embedder-Policy: credentialless` in `public/_headers`.
`credentialless` still enables `SharedArrayBuffer` (Stockfish keeps
working multi-threaded) but is more permissive about cross-origin
loads. Note the swap here if you make it, so the next reader knows
which policy prod is on.

## 4. GitHub Actions — already in the repo

Three workflows ship with this repo:

- **`.github/workflows/ci.yml`** — runs on every push to `main` and every
  PR targeting `main`. Two jobs in sequence:

  - `Typecheck + unit + integration`: `npm run typecheck`, `npm run
    build` (production-build parity, so a Vite-only break surfaces here
    rather than in CF's build log), `npm run test:unit`, then starts a
    background `npm run dev` and runs `npm run test:integration`
    against it.
  - `Playwright e2e` (depends on the unit job passing): same dev-server
    pattern, runs `npm run test:e2e`.

  Both jobs upload Playwright traces + the dev-server log on failure
  (`test-results/`, retained 7 days).

- **`.github/workflows/live.yml`** — runs daily at 06:17 UTC, plus
  `workflow_dispatch` for manual runs. Hits the real Chess.com API
  (`npm run test:live`). Uses `continue-on-error: true` because Chess.com
  occasionally rate-limits or has transient outages, and that flake must
  not page anyone or block a deploy.

- **`.github/workflows/openings-refresh.yml`** — scheduled monthly
  (04:41 UTC on the 3rd) plus `workflow_dispatch`. Regenerates the
  bundled opening-frequency data and **pushes the result straight to
  `main`**, which means it can trigger a production deploy. It gates
  itself on typecheck + unit tests before pushing, because there is no
  gate on `main` to catch it afterwards. ARCHITECTURE.md owns the
  details; what matters here is that this workflow is a writer to the
  production branch.

### CI env vars (why real values, not dummies)

All three workflows read the same three GitHub Actions secrets:

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

### Branch protection (optional, currently off)

`main` has **no branch protection rule**. Pushes and merges land
unconditionally, and Cloudflare deploys them. That's a deliberate
trade-off for a solo project — but if you want a gate, add one in GitHub
repo settings → **Branches** → add a rule for `main`:

- ☑ Require a pull request before merging
- ☑ Require status checks to pass before merging
- Required status checks (these names must match the job names exactly):
  - `Typecheck + unit + integration`
  - `Playwright e2e`
  - the Cloudflare Pages preview check, if you want the deploy to be
    part of the gate. GitHub only offers a check name once it has been
    reported at least once, so add it from the status-check search box
    after a preview deploy has run.
- ☑ Require branches to be up to date before merging
- ☐ Do not allow bypassing the above settings (toggle on if you want
  the rule to apply to admins too; for a solo project you may want this
  off so you can hot-fix without ceremony)

Before requiring a check, confirm it actually passes on `main` — a check
with a standing failure makes every PR unmergeable. `npm run test:e2e` is
expected to be fully green; if a test starts failing for environmental
reasons, fix or remove it rather than leaving it required and red.

Whatever you require here, remember it does not gate Cloudflare: CF
deploys from `main` after the merge, so a required check only stops the
merge, and a direct push still ships.

## 5. Custom domain (recommended)

**The IndexedDB-origin pin matters in production too.** IndexedDB is
keyed by origin; if you move users from `chess-coach-bip.pages.dev` to
`yourchess.app` later, every imported game and cached analysis looks
"missing" on the new origin. There is no in-app export/import to dig them
out with. Cloud sync can restore games, analyses and puzzle progress onto
the new origin, but only for an account enrolled in
`cloud_sync_allowlist` — it is not a general migration path, and it does
not carry repertoires, settings or the eval cache.

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

If you skip the custom domain, `chess-coach-bip.pages.dev` is fine
-- just **don't change it later** without warning users.

## 6. Operational notes

### Rolling back

CF Pages keeps every prior deploy. To roll back:

1. Project → **Deployments** → find the last known-good deploy.
2. Click **⋯** → **Rollback**. Production traffic switches in <30s.

This is safe to do at any time. The deploy is atomic — engine + bundle +
headers roll back together — because everything lives in the same
`dist/` artifact. Stockfish must stay bundled with the app rather than
served from a separate origin, because otherwise a rollback would leave
the engine and the code that drives it at mismatched versions.

A rollback only holds until the next commit lands on `main`: that
triggers a fresh production deploy and supersedes it. Revert the bad
commit too, or the rollback is temporary.

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

The NNUE network needs no cache work either, for the same reason but
by construction: its filename contains Stockfish's own hash of its
contents, so a new network can only appear at a new URL. What a
Stockfish upgrade *does* need is `NNUE_NET_FILE` in
`src/engine/nnue.ts` updated to the new filename —
`scripts/copy-nnue.mjs` fails the build if the two disagree, which is
the intended way to find out.

### Cost ceiling

Free tier covers this project's usage:

- **Bandwidth**: unlimited on Pages.
- **Files per site**: 20,000 on the free plan. The deploy is well under
  it (~50 committed puzzle shards plus the Vite output), but the shard
  count scales with the puzzle corpus, so a much larger corpus is the
  one thing that could approach it.
- **Single asset size**: 25 MiB, and this one is *not* comfortable — see
  the NNUE section near the top of this file.
- **Builds**: 500/month.
- **Concurrent builds**: 1 (sequential queue).
- **Custom domains**: unlimited.
- **GH Actions free minutes**: unlimited on public repos; 2000/mo on
  private ones -- either way, effectively free at this CI volume.

Outgrowing the free tier means paying for the next Cloudflare tier. The
architecture doesn't have to change.

## 7. Troubleshooting

| Symptom                                        | Likely cause                                         | Fix                                                                                                                                                                |
| ---------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The "production" URL serves an app that isn't Chess Coach | Wrong hostname — `<project>.pages.dev` was guessed rather than looked up | The assigned host is `chess-coach-bip.pages.dev`. Confirm it on the CF Pages project page, or in the summary of the **Cloudflare Pages** check on a recent `main` commit. |
| `crossOriginIsolated === false` in prod         | `_headers` not deployed or being stripped            | `npm run build && ls dist/_headers`. If absent, confirm the file is in `public/` (Vite auto-copies) and not `.gitignored`. Check headers via `curl -I`.            |
| Sign-in redirects loop                         | OAuth redirect URL not whitelisted in Clerk           | Add the prod hostname (and `*.chess-coach-bip.pages.dev` for previews) to Clerk → Domains and OAuth providers.                                                     |
| Hard refresh on `/review/<id>` 404s             | `_redirects` not deployed                            | Same fix as `_headers` -- verify `dist/_redirects` exists after build.                                                                                             |
| Stockfish loads single-thread on prod          | COEP not active                                      | `crossOriginIsolated` must be `true`. See first row.                                                                                                               |
| All games error with `Stockfish worker failed to start (worker error)`, `crossOriginIsolated === true`, JS/WASM fetch 200, but `new Worker('/stockfish/...')` fires `error` with empty `message` / `filename` / `lineno` | Duplicate `Cross-Origin-Embedder-Policy` header on `/stockfish/*`. Cloudflare Pages **appends** per-route `_headers` rules on top of the wildcard `/*` block — re-declaring `COEP: require-corp` on `/stockfish/*` produces a response with the header listed twice, which Chromium rejects when loading a worker script. Confirm with `curl -sI /stockfish/stockfish-nnue-16.js \| grep -i embedder` (should show **one** line, not two). | Remove `Cross-Origin-Embedder-Policy: require-corp` from the `/stockfish/*` block in `public/_headers`. The wildcard `/*` already covers it. Keep `Cross-Origin-Resource-Policy: same-origin` on `/stockfish/*` since the wildcard doesn't set CORP. |
| Clerk widget shows blank / console COEP errors | `require-corp` blocking Clerk's cross-origin scripts  | Swap to `Cross-Origin-Embedder-Policy: credentialless` in `public/_headers`.                                                                                       |
| Console warns `NNUE net not served at …`, and evals look off (quiet positions read as equal) | The 40 MB network is missing from the deploy, so the engine fell back to the classical evaluator | On production this is the 25 MiB asset cap (see the section above), not a build misconfiguration. Locally it means `prebuild` was skipped — run `npm run nnue:stage`. |
| Cloudflare Pages check is red while GitHub Actions is green | The two pipelines are independent; a failed Pages **build** leaves the previous deploy live, so the site keeps working and only the check goes red | Read the dashboard log linked from the check. If it is the NNUE network, see the section above — a docs-only or code-only commit will not fix it. |
| Every game errors as soon as analysis starts, with no useful message | Stockfish 16 `exit()`s at the first `go` when `Use NNUE` is on and the net did not load. The app probes for this, so reaching it means the probe passed and the load still failed — e.g. a truncated or wrong-sized `.nnue` | Compare `content-length` against the file in `node_modules/stockfish/src/`. Purge the CF cache for `/stockfish/*` if the sizes differ.                              |
| CI fails on dev-server start                   | Port 5173 occupied by something or env var missing    | Check the uploaded `vite.log` artifact. If the error is `ENV missing`, one of the three repository secrets is unset — see "CI env vars" above.                     |
| CI integration tests timeout                   | Stockfish init slow under Actions runner              | Already give the harness 60s for dev-server boot + each test has its own timeout. If consistently slow, bump `timeout-minutes` on the `unit` job.                  |
| `pages.dev` works but custom domain 404s       | DNS not pointing to CF or cert still provisioning     | CF dashboard → Custom domains → check status. Wait up to 5 min after first setup.                                                                                  |

## 8. What to update if you change deploy infra

- **Different host**: keep the `_headers` / `_redirects` files (Netlify
  uses the same format; Vercel needs a `vercel.json`). Update the
  **Production host** block and §1-3 of this file, plus the hint string
  in `extension/src/options.html` and the fixtures in
  `scripts/screenshot-extension.mjs`.
- **Different Node version**: change the `node-version` in both
  workflows AND the `NODE_VERSION` env var in CF Pages.
- **New build script**: update CF Pages **Build command** AND keep
  `npm run typecheck` / `npm test` working in CI; both pipelines must
  agree on what "build green" means. Whatever the command becomes, it
  must still run `scripts/copy-nnue.mjs` (today via `prebuild`) or the
  deploy ships without the NNUE network.
- **Different Stockfish version**: update `NNUE_NET_FILE` in
  `src/engine/nnue.ts`, the engine filenames in `src/engine/engine.ts`,
  and the `/stockfish/*` note in `public/_headers`. Re-run §3's net
  check on the deploy.

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
npm run extension:build -- --coach-origin=https://chess-coach-bip.pages.dev
```

Produces `dist-extension/chess-coach-<version>.zip`. The build
script:

- Copies `extension/` to a clean staging directory (drops
  `README.md`, `WEB_STORE_LISTING.md`, dotfiles, `.DS_Store`).
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
2. `npm run extension:build -- --coach-origin=https://chess-coach-bip.pages.dev`.
3. Upload `dist-extension/chess-coach-<version>.zip` to the
   developer console → your item → new version → upload the package.
4. A submission for an item that has never been reviewed also asks
   for: a 128×128 icon, 1280×800 screenshots, a privacy policy URL,
   and a "Single Purpose" declaration. The single purpose for this
   extension is: **"Detect the end of a Chess.com game and offer a
   deep link into the user's own Chess Coach review tool."** Keep that
   wording — it matches what the extension actually does, which is the
   Web Store's sole acceptance criterion. `extension/WEB_STORE_LISTING.md`
   holds the full copy-paste set of answers.
5. Review usually takes 1–3 business days; subsequent updates are
   typically approved within hours.

### Updating the live extension

The extension does not auto-pull from the source tree once installed.
If you change `extension/src/content.js` or `extension/src/options.html`:

- **Side-loaded users**: send them the new zip; they remove + Load
  Unpacked again, or click "Update" in `chrome://extensions` if they
  loaded from a folder.
- **Web Store users**: bump the manifest version, rebuild, upload.
  Chrome auto-pushes within 24h once approved.

Bumping the manifest version on every change is cheap (one digit)
and pays for itself the first time you have to debug "is the user on
the new content script or the old one?".
