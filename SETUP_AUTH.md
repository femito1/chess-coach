# Auth setup — Clerk + Supabase

> One-time setup to stand up the Phase 2 auth infrastructure. Follow this
> end-to-end before running the app for the first time after Phase 2 lands.
> Estimated time: ~15 minutes.

The app uses **Clerk** (auth: sign-in, session management, user identity) and
**Supabase** (Postgres for the `profiles` table that holds linked chess
usernames). Clerk is wired to Supabase as a **third-party auth provider** —
the modern replacement for the deprecated "JWT template" approach. Supabase
trusts Clerk's JWKS directly; we never copy JWT secrets between the two.

Heavy user data (games, analyses, eval cache) stays in IndexedDB on the
client — Supabase only stores the small `profiles` row. Phase 3 adds cloud
backup for the heavy data.

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
     current Supabase key format (replaces the older `anon` JWT key,
     which is being phased out by late 2026). It's safe to ship to the
     browser; it only grants the low-privilege `anon` Postgres role.

     Older Supabase projects may still show an **anon public** key as a
     long `eyJhbGc…` JWT instead. If that's all you have, use it — it
     works identically. New projects only get the `sb_publishable_…`
     format.

     **Do NOT** use the `service_role` / `secret` key. That one bypasses
     Row-Level Security and must never ship to the browser.

   Save both for `.env.local`.

5. Configure **Clerk as third-party auth**:
   - Left nav → **Authentication → Providers**.
   - Scroll to **Third-party Auth** (separate from the OAuth list).
   - Click **Add provider → Clerk**.
   - Paste your Clerk **Frontend API URL** from step 6 of the Clerk
     section. Save.

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
   - There is intentionally no `delete` policy — accounts get deleted via
     a Clerk webhook (future work).

## 3. Local environment file

1. Copy `.env.example` to `.env.local` at the repo root:

   ```bash
   cp .env.example .env.local
   ```

2. Fill in the three values you collected above:

   ```
   VITE_CLERK_PUBLISHABLE_KEY=pk_test_xxx...
   VITE_SUPABASE_URL=https://xxxxxxxxxxxx.supabase.co
   VITE_SUPABASE_ANON_KEY=eyJhbGciOi...
   ```

3. Restart `npm run dev` if it was already running. Vite only reads
   env files at startup.

`.env.local` is gitignored. `.env.example` (placeholder values only) is
checked in so contributors know which variables they need.

## 4. Verify

After Phase 2 code lands, you can verify the wiring works without writing
any code:

1. `npm run dev`, open the app — you should see a sign-in screen instead
   of the dashboard.
2. Sign in via Google, GitHub, or magic link.
3. After sign-in, the app routes to onboarding.
4. Open the Supabase dashboard → **Table Editor → profiles**. You should
   see exactly one row, with `id` matching your Clerk user id.
5. Refresh the app. You should stay signed in.
6. Sign out from the user button. You should be sent back to sign-in.

If any step fails, the integration test `auth-gate.mjs` (Phase 2 Pass 2)
runs the same flow programmatically with stubbed credentials and gives a
clearer error than the UI does.

---

## Production checklist (when you're ready to deploy)

These don't matter for local dev; flag them for the eventual public deploy.

- [ ] Clerk → **Domains**: add the production domain (e.g.
      `chess-coach.<something>`) so OAuth redirects work there.
- [ ] Clerk → **API Keys**: switch to a `pk_live_…` key for production
      (separate Clerk app or "Production" instance of the same one).
- [ ] Supabase → **Authentication → URL Configuration**: add the
      production domain to the allowed redirect list.
- [ ] Confirm RLS is still enabled on `profiles` (it should be — the
      `enable row level security` line above is durable).
- [ ] Set up a Clerk webhook for `user.deleted` so Supabase rows get
      cleaned up when accounts are removed. (Out of scope for Phase 2.)
