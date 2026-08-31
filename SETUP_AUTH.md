# Auth setup — Clerk + Supabase

> How to stand up the auth infrastructure the app needs. Follow this
> end-to-end before running the app: without these three env vars,
> `src/lib/env.ts` throws at module load and nothing boots.
> Estimated time: ~15 minutes.

The app uses **Clerk** (auth: sign-in, session management, user identity) and
**Supabase** (Postgres for the `profiles` table that holds linked chess
usernames). Clerk is wired to Supabase as a **third-party auth provider** —
the modern replacement for the deprecated "JWT template" approach. Supabase
trusts Clerk's JWKS directly; JWT secrets are never copied between the two.

Heavy user data (games, analyses, eval cache) stays in IndexedDB on the
client. Supabase stores only the small `profiles` row, so nothing in steps 1-4
needs to scale with a user's game count. Section 5 adds optional, per-account
cloud sync for the heavy data — that one *does* scale with game count, which is
exactly why it is gated to specific accounts.

---

## 1. Clerk (~5 min)

1. Go to <https://dashboard.clerk.com> and click **Create application**.
2. **Name**: `Chess Coach` (or whatever you like).
3. **Authentication providers**: enable
   - **Google**
   - **GitHub**
   - **Email** → in the email sub-options, enable **Email link** (magic link). Disable **Email code** unless you want both.

   Disable everything else (password, phone, etc.) — fewer attack surfaces
   and a simpler sign-in UI.
4. Click **Create application**.
5. **Enable username as an optional field.** From the left nav, open
   **User & Authentication → Email, Phone, Username**. Find the
   **Username** row, toggle it on, and set it to **Optional** (not
   Required).

   Why: most chess players reuse the same handle across services, so a
   Clerk username is a great candidate for "is this your Chess.com
   account?" suggestion at onboarding. Making it *optional* (not
   required) keeps the sign-in flow one-click for users who don't want
   to bother. Sign-ups via GitHub auto-fill it with the user's GitHub
   handle, which in practice matches their Chess.com handle a lot of
   the time. The onboarding flow always confirms with an
   avatar-and-country card before linking — Clerk's username is a hint,
   never proof.
6. From the left nav, open **API Keys**. Copy the **Publishable key** —
   starts with `pk_test_…` for development. Save it; you'll paste it into
   `.env.local` in step 3.
7. From the left nav, open **Domains**. You'll see the **Frontend API URL**
   — looks like `https://<something>.clerk.accounts.dev`. Save it; Supabase
   needs it in the next step.
8. *(Skip)* Don't create a JWT Template. We're using third-party auth,
   which is configured on Supabase's side.

## 2. Supabase (~10 min)

1. Go to <https://supabase.com/dashboard> and click **New project**.
2. **Name**: `chess-coach`. Pick the region closest to you. Set a strong
   database password (you won't need it after this — Supabase manages
   the connection for you in the dashboard).
3. Wait ~2 minutes for the project to provision.
4. Once provisioned, open **Project Settings → API**. Copy:
   - **Project URL** (e.g. `https://xxxxxxxxxxxx.supabase.co`)
   - **Publishable key** — starts with `sb_publishable_…`. This is the
     current Supabase key format, which supersedes the older `anon` JWT
     key. It's safe to ship to the browser; it only grants the
     low-privilege `anon` Postgres role.

     Older Supabase projects may still show an **anon public** key as a
     long `eyJhbGc…` JWT instead. If that's all the dashboard offers,
     use it — it works identically. Either way it goes in
     `VITE_SUPABASE_ANON_KEY`.

     **Do NOT** use the `service_role` / `secret` key. That one bypasses
     Row-Level Security and must never ship to the browser.

   Save both for `.env.local`.

5. Configure **Clerk as third-party auth**:
   - Left nav → **Authentication → Providers**.
   - Scroll to **Third-party Auth** (separate from the OAuth list).
   - Click **Add provider → Clerk**.
   - Paste the Clerk **Frontend API URL** you saved in step 7 of the
     Clerk section. Save.

   This tells Supabase to trust JWTs issued by your Clerk instance.
   Supabase fetches Clerk's JWKS automatically; nothing to copy by hand.

6. Create the `profiles` table + RLS policies. Open the **SQL Editor**
   in the left nav, paste the block below, and click **Run**:

   ```sql
   create table public.profiles (
     id text primary key,
     display_name text,
     chesscom_username text,
     lichess_username text,
     created_at timestamptz default now() not null,
     updated_at timestamptz default now() not null
   );

   alter table public.profiles enable row level security;

   create policy "profiles_select_own"
     on public.profiles for select
     using (auth.jwt() ->> 'sub' = id);

   create policy "profiles_insert_own"
     on public.profiles for insert
     with check (auth.jwt() ->> 'sub' = id);

   create policy "profiles_update_own"
     on public.profiles for update
     using (auth.jwt() ->> 'sub' = id);

   -- Optional but recommended: keep updated_at honest.
   create or replace function public.set_updated_at()
   returns trigger language plpgsql as $$
   begin
     new.updated_at = now();
     return new;
   end;
   $$;

   create trigger profiles_set_updated_at
     before update on public.profiles
     for each row execute function public.set_updated_at();
   ```

   Notes:
   - `id` is `text`, not `uuid`. Clerk user IDs are strings like
     `user_2abc…`, not UUIDs.
   - The three RLS policies pin every row access to the signed-in user's
     own row. `auth.jwt() ->> 'sub'` is Clerk's user id when Clerk is
     configured as the third-party auth provider.
   - There is intentionally no `delete` policy: the browser client must
     not be able to drop rows. Account deletion belongs out-of-band, via
     a Clerk `user.deleted` webhook (see the production checklist below).

## 3. Local environment file

1. Copy `.env.example` to `.env.local` at the repo root:

   ```bash
   cp .env.example .env.local
   ```

2. Fill in the three values you collected above:

   ```
   VITE_CLERK_PUBLISHABLE_KEY=pk_test_xxx...
   VITE_SUPABASE_URL=https://xxxxxxxxxxxx.supabase.co
   VITE_SUPABASE_ANON_KEY=sb_publishable_xxx...
   ```

   All three are required. `src/lib/env.ts` throws on a missing or
   prefix-invalid value at module load, so a typo here fails the app at
   boot rather than at first sign-in.

3. Restart `npm run dev` if it was already running. Vite only reads
   env files at startup.

`.env.local` is gitignored. `.env.example` (placeholder values only) is
checked in so contributors know which variables they need.

## 4. Verify

You can confirm the whole wiring works without writing any code:

1. `npm run dev`, open the app — you should see a sign-in screen instead
   of the dashboard.
2. Sign in via Google, GitHub, or magic link.
3. After sign-in, the app routes to onboarding.
4. Open the Supabase dashboard → **Table Editor → profiles**. You should
   see exactly one row, with `id` matching your Clerk user id.
5. Refresh the app. You should stay signed in.
6. Sign out from the user button. You should be sent back to sign-in.

If a step fails, with `npm run dev` running in another terminal, run:

```bash
node scripts/run-tests.mjs --only=auth-bypass
```

That test (`scripts/test/integration/auth-bypass.mjs`) drives the same
auth gate with a synthetic identity and a stubbed Supabase, and asserts
the signed-in layout renders. Because it stubs the backends, it splits
the failure in two:

- **It passes** → the app and your env vars are fine, and the problem is
  dashboard configuration (Clerk domains / OAuth redirect URLs, the
  third-party auth provider, or the `profiles` table and its policies).
- **It fails** → the problem is local. A malformed publishable key shows
  up as `@clerk/clerk-react: The publishableKey passed to Clerk is
  invalid` in the page-error log.

## 5. Cloud sync (optional, per-account)

By default Supabase holds only the small `profiles` row, and all heavy user data
(games, analyses, puzzle progress) stays in IndexedDB on whichever device
produced it. **Cloud sync** mirrors that heavy data to Postgres so it survives a
cleared browser and follows you between devices.

It is deliberately opt-in **per account**, enforced in the database:

1. Open the **SQL Editor** in the Supabase dashboard.
2. Paste the whole of [`supabase/cloud-sync.sql`](supabase/cloud-sync.sql) and
   click **Run**. It is idempotent — re-running it changes nothing.
3. The last statement prints the allowlist. You should see exactly one row, for
   the account you want to sync. If it prints none, the lookup found no matching
   profile; the file's closing comment explains how to insert the id by hand.
4. Reload the app and open **Settings**. A **Cloud sync** card appears, with the
   last run and a **Sync now** button. It appears *only* for enrolled accounts.

The first sync uploads your whole reviewed library, so it can take a few minutes
and move tens of megabytes; the card shows progress. Every sync after that moves
only what changed.

**Why the allowlist exists.** An analysis row is ~30 KB, so a thousand reviewed
games is ~30 MB before compression. If every user of a deployed instance synced,
Supabase's 500 MB free tier would disappear fast. Gating in RLS rather than in
the client is the point: the publishable key ships in the browser bundle by
design, so anyone holding it could call the REST API directly — only a database
policy actually stops that.

**What sync does not do.** There is no `delete` policy on any cloud table, so the
mirror only ever grows. Deleting a game locally does not remove the cloud copy,
and a later sync restores it. That is the intended behaviour for a backup; prune
from the dashboard if you ever need to.

---

## Production checklist

None of these matter for local dev. They all matter for the deployed app
(see `DEPLOY.md`, whose production host is
`https://chess-coach-bip.pages.dev`).

- [ ] Clerk → **Domains**: add the production hostname, plus the
      `*.chess-coach-bip.pages.dev` wildcard for CF Pages preview
      deploys, so OAuth redirects work there.
- [ ] Clerk → **API Keys**: use a `pk_live_…` key for production
      (separate Clerk app, or the "Production" instance of the same one).
- [ ] Supabase → **Authentication → URL Configuration**: add the
      production hostname to the allowed redirect list.
- [ ] Confirm RLS is enabled on `profiles`. The `enable row level
      security` line above is durable, but a table recreated by hand
      without it is world-readable to anyone holding the publishable key.
- [ ] Set up a Clerk webhook for `user.deleted` so Supabase rows get
      cleaned up when accounts are removed — the RLS policies above
      deliberately give the client no way to do this itself.
