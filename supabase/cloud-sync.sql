-- ===========================================================================
--  Cloud sync — schema, RLS, and the per-account allowlist
-- ===========================================================================
--
--  Run this once, whole, in the Supabase dashboard's SQL Editor. It is
--  idempotent: re-running it is safe and changes nothing.
--
--  What it sets up: a cloud mirror of the heavy user data that until now lived
--  only in IndexedDB, so reviewed games + their Stockfish analyses + puzzle
--  progress survive a cleared browser and follow you between devices.
--
--  ── Why this is gated, and gated HERE ─────────────────────────────────────
--
--  An analysis row is ~30 KB. A thousand reviewed games is ~30 MB before
--  Postgres compression. If every user of the deployed app synced, the free
--  tier's 500 MB would be gone quickly and the bill would be a surprise.
--
--  So writes require membership in `cloud_sync_allowlist`, enforced in RLS —
--  not in the client. Client-side gating would be cosmetic: anyone holding the
--  publishable key (which ships in the browser bundle, by design) could call
--  the REST API directly. Enforcing it in a policy means the database refuses
--  the write regardless of what the caller does.
--
--  The allowlist itself is client-readable but not client-writable: it has a
--  SELECT policy and no INSERT/UPDATE/DELETE policy, and under RLS an
--  operation with no permissive policy is denied. So the app can ask "am I
--  allowed?" (to show the right UI) but cannot enrol itself. Only the
--  dashboard, running as `postgres`, can add rows — see step 5.
--
--  This is why the flag is a separate table rather than a `profiles` column:
--  column-level REVOKE does not subtract from a table-level GRANT, so a
--  `profiles.cloud_sync_enabled` column would still be settable by a client
--  crafting its own insert. A separate table has no such hole.

-- ---------------------------------------------------------------------------
-- 1. Allowlist
-- ---------------------------------------------------------------------------

create table if not exists public.cloud_sync_allowlist (
  -- Clerk user id (`user_2abc…`), matching `profiles.id`. Text, not uuid.
  user_id    text primary key,
  -- Free-text reminder of who this is, for whoever reads this table in a year.
  note       text,
  created_at timestamptz not null default now()
);

alter table public.cloud_sync_allowlist enable row level security;

drop policy if exists "allowlist_select_own" on public.cloud_sync_allowlist;
create policy "allowlist_select_own"
  on public.cloud_sync_allowlist for select
  using (auth.jwt() ->> 'sub' = user_id);
-- Deliberately NO insert / update / delete policy. See the header.

-- ---------------------------------------------------------------------------
-- 2. Gate helper
-- ---------------------------------------------------------------------------

-- `security definer` so the check works regardless of the caller's own read
-- access to the allowlist, and `stable` so Postgres evaluates it once per
-- statement rather than once per row — which matters when a policy using it is
-- applied to a 2 000-row upsert.
--
-- `set search_path` is not optional on a security-definer function: without it
-- a caller could shadow `cloud_sync_allowlist` with a same-named table in a
-- schema earlier on their own search_path and defeat the gate.
create or replace function public.cloud_sync_enabled()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.cloud_sync_allowlist
    where user_id = auth.jwt() ->> 'sub'
  );
$$;

-- ---------------------------------------------------------------------------
-- 3. Mirror tables
-- ---------------------------------------------------------------------------
--
-- Shape note: each row keeps the full Dexie record in a `data` jsonb column,
-- plus the few fields the sync algorithm needs to make decisions.
--
-- Why a blob and not a column per field: this is a mirror, not a queryable
-- model — nothing server-side reads inside a game or an analysis. The Dexie
-- schema is on version 12 and gains fields regularly; with a blob, adding
-- `Game.brilliantCount` needs no Postgres migration at all. The trade is that
-- you can't write ad-hoc SQL against game internals, which we don't do.
--
-- The metadata columns exist so a sync can diff without downloading blobs:
-- `select game_id, analysis_status` over 1 000 games is ~60 KB, versus ~30 MB
-- if `data` came along. That difference is the whole reason sync is usable.
--
-- Large `data` values are TOASTed and compressed by Postgres automatically
-- (anything over ~2 KB), so a ~30 KB analysis lands closer to ~10 KB on disk.
-- No client-side compression needed.

create table if not exists public.cloud_games (
  user_id         text        not null,
  game_id         text        not null,
  -- Denormalized for diffing: a pull prefers whichever side has a finished
  -- analysis, so this has to be readable without fetching `data`.
  analysis_status text        not null,
  end_time        bigint      not null,
  updated_at      timestamptz not null default now(),
  data            jsonb       not null,
  primary key (user_id, game_id)
);

create table if not exists public.cloud_analyses (
  user_id     text        not null,
  game_id     text        not null,
  -- Conflict resolution, in this order: NNUE beats classical, then deeper,
  -- then newer. See `isBetter` in src/features/sync/diff.ts.
  depth       int         not null,
  analyzed_at bigint      not null,
  -- Which evaluator produced this, e.g. `stockfish-16-nnue`. Nullable because
  -- rows written before this column existed came from the browser's classical
  -- build; null is read as classical, which is what they were.
  engine      text,
  -- Which classification-rules version produced this row's *derived* fields
  -- (MoveEval.classification / .motifs / .phase), as opposed to its engine
  -- numbers. Nullable because rows written before this column existed have an
  -- unknown vintage; null is read as 0, i.e. "reprocess it". Lets a restored
  -- device skip reclassifying a library it just pulled down already-correct.
  recompute_version int,
  move_count  int         not null,
  updated_at  timestamptz not null default now(),
  data        jsonb       not null,
  primary key (user_id, game_id)
);

create table if not exists public.cloud_puzzle_attempts (
  user_id           text        not null,
  puzzle_id         text        not null,
  -- Enough to merge two devices' progress without fetching `data`.
  attempts          int         not null,
  solved_clean      boolean     not null,
  hint_used         boolean     not null,
  last_attempted_at bigint      not null,
  rating            int         not null,
  updated_at        timestamptz not null default now(),
  data              jsonb       not null,
  primary key (user_id, puzzle_id)
);

-- `user_id` leads every primary key, so the PK index already serves
-- "everything for this user". No extra indexes needed.

-- Additive migration, for a project that ran an earlier version of this file.
-- `create table if not exists` above is a no-op on an existing table, so the
-- new column has to be added explicitly.
alter table public.cloud_analyses add column if not exists engine text;
alter table public.cloud_analyses add column if not exists recompute_version int;

-- ---------------------------------------------------------------------------
-- 4. RLS
-- ---------------------------------------------------------------------------
--
-- Every table: you may read and write your OWN rows, and only while
-- allowlisted. No DELETE policy anywhere — the browser client must not be able
-- to drop rows, which is the same stance `profiles` takes. Consequence worth
-- knowing: the cloud is an accumulating archive. Deleting a game locally does
-- not remove it from the cloud, and a later sync restores it. That is the
-- intended behaviour for a backup ("permanent"), but it does mean pruning is a
-- deliberate out-of-band action from the dashboard.

-- Defined BEFORE the triggers below reference it. It already exists from the
-- profiles setup in SETUP_AUTH.md; repeated here so this script stands alone,
-- and `create or replace` makes that harmless.
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

do $$
declare
  t text;
begin
  for t in
    select unnest(array['cloud_games', 'cloud_analyses', 'cloud_puzzle_attempts'])
  loop
    execute format('alter table public.%I enable row level security', t);

    execute format('drop policy if exists %I on public.%I', t || '_select_own', t);
    execute format(
      'create policy %I on public.%I for select using (auth.jwt() ->> ''sub'' = user_id and public.cloud_sync_enabled())',
      t || '_select_own', t);

    execute format('drop policy if exists %I on public.%I', t || '_insert_own', t);
    execute format(
      'create policy %I on public.%I for insert with check (auth.jwt() ->> ''sub'' = user_id and public.cloud_sync_enabled())',
      t || '_insert_own', t);

    execute format('drop policy if exists %I on public.%I', t || '_update_own', t);
    execute format(
      'create policy %I on public.%I for update using (auth.jwt() ->> ''sub'' = user_id and public.cloud_sync_enabled()) with check (auth.jwt() ->> ''sub'' = user_id and public.cloud_sync_enabled())',
      t || '_update_own', t);

    -- Keep updated_at honest on every write.
    execute format('drop trigger if exists %I on public.%I', t || '_set_updated_at', t);
    execute format(
      'create trigger %I before update on public.%I for each row execute function public.set_updated_at()',
      t || '_set_updated_at', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 5. Enrol the one account that should sync
-- ---------------------------------------------------------------------------
--
-- Looks the Clerk user id up from the profile row rather than making you paste
-- it. Requires that you have signed in at least once (so `profiles` has your
-- row) and that onboarding recorded your Chess.com username.

insert into public.cloud_sync_allowlist (user_id, note)
select id, 'nandoravioli / fernandorimoli1001@gmail.com'
from public.profiles
where chesscom_username ilike 'nandoravioli'
on conflict (user_id) do nothing;

-- Verify: this should return exactly one row. If it returns none, the lookup
-- above found no matching profile — run
--     select id, display_name, chesscom_username from public.profiles;
-- to find your Clerk id, then insert it directly:
--     insert into public.cloud_sync_allowlist (user_id, note)
--     values ('user_2abc…', 'nandoravioli') on conflict do nothing;
select a.user_id, a.note, p.chesscom_username, a.created_at
from public.cloud_sync_allowlist a
left join public.profiles p on p.id = a.user_id;
