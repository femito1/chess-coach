/**
 * Dev-only auth bypass for browser-driven tests.
 *
 * Background: every existing integration / e2e / live test in
 * `scripts/test/` opens a route that's now behind `<AuthGate>`, and the
 * gate redirects unauthenticated visitors to `/sign-in`. There's no way
 * to script a real Clerk OAuth handshake in headless Chromium without
 * baking real Google / GitHub credentials into the harness, which we
 * neither want nor need.
 *
 * Solution: a build-time-gated bypass that — only in development mode,
 * only when explicitly opted in — replaces Clerk's `useAuth` / `useUser`
 * with a synthetic identity and the Supabase client with an in-memory
 * stub. Production builds can never reach this code path because both
 * gates have to be true:
 *
 *   1. `import.meta.env.MODE === 'development'` — Vite sets this to
 *      `'production'` for `vite build`.
 *   2. `VITE_E2E_AUTH_BYPASS === 'true'` OR the URL has
 *      `?e2e_auth_bypass=1`.
 *
 * The query-string trigger means tests can opt in per-page-load without
 * restarting the dev server (Playwright simply navigates with the flag
 * appended). The env-var trigger is here for future-proofing; today we
 * use the query string everywhere because it composes more cleanly with
 * the existing harness.
 *
 * Read `PASS4_PLAN.md § Auth-bypass test mode` for the full design.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export const BYPASS_USER_ID = 'e2e_bypass_user';

const QUERY_FLAG = 'e2e_auth_bypass';

/**
 * Whether the current page load should bypass real auth. Pure read of
 * `import.meta.env` + `window.location` — never throws, safe to call
 * from anywhere.
 *
 * Cached for the lifetime of the page so flipping the URL via
 * `history.replaceState` mid-session can't toggle it (we don't want a
 * click on a link that happens to drop the query string to suddenly
 * eject the test back to `/sign-in`).
 */
let cached: boolean | null = null;
export function isE2EBypass(): boolean {
  if (cached !== null) return cached;
  cached = computeBypass();
  return cached;
}

/** Test seam — lets unit tests reset the cache between cases. */
export function _resetE2EBypassCache(): void {
  cached = null;
}

/**
 * Storage key used to persist the bypass flag across in-app navigations
 * and reloads once it's been activated. Without this, a test would have
 * to append `?e2e_auth_bypass=1` to every URL it navigates to — and any
 * `<Navigate to="/dashboard">` redirect baked into the router (we have
 * one at `/`) would silently strip the query and bounce the user back
 * to `/sign-in`.
 *
 * Sticky-once: any URL that includes the query flag flips this on for
 * the rest of the browser session. Reloads preserve it (sessionStorage
 * survives reloads). Closing the tab clears it (sessionStorage doesn't
 * survive tab close), which is the right safety boundary — a developer
 * who accidentally hit a bypass URL once doesn't carry that into their
 * next session.
 */
const STICKY_KEY = '__chess_e2e_auth_bypass';

function computeBypass(): boolean {
  const env = import.meta.env as Record<string, string | undefined>;
  if (env.MODE !== 'development') return false;
  if (env.VITE_E2E_AUTH_BYPASS === 'true') return true;
  if (typeof window === 'undefined') return false;
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get(QUERY_FLAG) === '1') {
      try {
        window.sessionStorage.setItem(STICKY_KEY, '1');
      } catch {
        /* sessionStorage may be unavailable in some sandboxes */
      }
      return true;
    }
    // Sticky check: if the flag was set earlier this session (e.g. on
    // the first navigation), honor it across in-app navigations.
    try {
      return window.sessionStorage.getItem(STICKY_KEY) === '1';
    } catch {
      return false;
    }
  } catch {
    return false;
  }
}

/**
 * Synthetic Clerk identity returned by {@link useEffectiveAuth} /
 * {@link useEffectiveUser} when the bypass is active. Shape matches the
 * fields we actually read from `@clerk/clerk-react` — anything else
 * stays undefined.
 */
export const BYPASS_USER = {
  id: BYPASS_USER_ID,
  username: 'e2e',
  firstName: 'E2E',
  lastName: null as string | null,
  primaryEmailAddress: {
    emailAddress: 'e2e@example.com',
  },
} as const;

export interface EffectiveAuth {
  isLoaded: boolean;
  isSignedIn: boolean;
  userId: string | null;
  getToken: () => Promise<string | null>;
}

export interface EffectiveUser {
  id: string;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
  primaryEmailAddress: { emailAddress: string } | null;
}

/**
 * Real-vs-bypass-aware wrappers around Clerk's hooks.
 *
 * These hooks are imported lazily so that under bypass the test page
 * never even reaches into `@clerk/clerk-react` (which would be fine in
 * principle but adds noise to the bundle). In practice we always import
 * the real hooks; the bypass branch just ignores their output.
 */
import { useAuth as useClerkAuth, useUser as useClerkUser } from '@clerk/clerk-react';

export function useEffectiveAuth(): EffectiveAuth {
  const real = useClerkAuth();
  if (isE2EBypass()) {
    return {
      isLoaded: true,
      isSignedIn: true,
      userId: BYPASS_USER_ID,
      getToken: async () => null,
    };
  }
  return {
    isLoaded: real.isLoaded,
    isSignedIn: Boolean(real.isSignedIn),
    userId: real.userId ?? null,
    getToken: async () => {
      try {
        return await real.getToken();
      } catch {
        return null;
      }
    },
  };
}

export function useEffectiveUser(): { user: EffectiveUser | null } {
  const real = useClerkUser();
  if (isE2EBypass()) {
    return {
      user: {
        id: BYPASS_USER.id,
        username: BYPASS_USER.username,
        firstName: BYPASS_USER.firstName,
        lastName: BYPASS_USER.lastName,
        primaryEmailAddress: { emailAddress: BYPASS_USER.primaryEmailAddress.emailAddress },
      },
    };
  }
  if (!real.user) return { user: null };
  return {
    user: {
      id: real.user.id,
      username: real.user.username ?? null,
      firstName: real.user.firstName ?? null,
      lastName: real.user.lastName ?? null,
      primaryEmailAddress: real.user.primaryEmailAddress
        ? { emailAddress: real.user.primaryEmailAddress.emailAddress }
        : null,
    },
  };
}

/* =======================================================================
 *  In-memory Supabase stub
 * =======================================================================
 *
 *  The bypass replaces the real Supabase client with this minimal
 *  fluent-builder that supports exactly the methods `useProfileSync` /
 *  `runProfileSync` actually call:
 *
 *    supabase.from('profiles').select('...').eq('id', X).maybeSingle();
 *    supabase.from('profiles').insert(row);
 *    supabase.from('profiles').upsert(row, { onConflict: 'id' });
 *    supabase.from('profiles').update(patch).eq('id', X);
 *
 *  The shape of return values mirrors the real client: `{ data, error }`
 *  for `select`, `{ error }` for write ops. RLS is a no-op — tests don't
 *  exercise it, and the real Postgres path is covered by the manual sign-in
 *  smoke documented in `SETUP_AUTH.md` §4.
 *
 *  Storage is module-level so multiple page loads in the same test run
 *  (rare; harness resets the browser context between scripts but not
 *  module state) share the same map. That's a feature: it lets a single
 *  script first "insert" a profile and then "select" it back without
 *  juggling stub state.
 */

interface ProfileRow {
  id: string;
  display_name: string | null;
  chesscom_username: string | null;
  lichess_username: string | null;
}

const profileTable = new Map<string, ProfileRow>();

/** Test seam — lets the unit test wipe the table between cases. */
export function _resetBypassSupabaseTables(): void {
  profileTable.clear();
}

interface BypassSelectBuilder {
  eq(column: string, value: string): BypassSelectBuilder;
  maybeSingle(): Promise<{ data: ProfileRow | null; error: null }>;
}

interface BypassUpdateBuilder {
  eq(
    column: string,
    value: string,
  ): Promise<{ error: null | { message: string; code?: string } }>;
}

interface BypassFromBuilder {
  select(_columns?: string): BypassSelectBuilder;
  insert(
    row: Partial<ProfileRow> & { id: string },
  ): Promise<{ error: null | { message: string; code?: string } }>;
  upsert(
    row: Partial<ProfileRow> & { id: string },
    opts?: { onConflict?: string },
  ): Promise<{ error: null | { message: string; code?: string } }>;
  update(patch: Partial<ProfileRow>): BypassUpdateBuilder;
}

function mergeRow(prev: ProfileRow | undefined, patch: Partial<ProfileRow> & { id: string }): ProfileRow {
  return {
    id: patch.id,
    display_name: patch.display_name ?? prev?.display_name ?? null,
    chesscom_username: patch.chesscom_username ?? prev?.chesscom_username ?? null,
    lichess_username: patch.lichess_username ?? prev?.lichess_username ?? null,
  };
}

/**
 * Build the in-memory stub. Returns the real `SupabaseClient` type
 * because all the bypass-aware code paths consume it via that interface;
 * the runtime shape is just enough to satisfy our actual call sites.
 */
/**
 * Cloud-sync tables, which the stub answers as "empty and not enrolled".
 *
 * The bypass stub throws for unknown tables on purpose — it should be loud
 * about a call site it doesn't model. But cloud sync is mounted in `AppLayout`,
 * so under bypass it runs in EVERY browser test, and an exception there would
 * surface as an unhandled rejection in all of them.
 *
 * Answering the allowlist query with "no row" puts the sync hook into its
 * `disabled` state, which is exactly the right behaviour for a synthetic test
 * identity: no requests, no UI, no interference. A test that wants to exercise
 * sync for real should drive `runCloudSync` with its own stub rather than rely
 * on this one.
 *
 * The builder also has to answer *count* queries (`select('*', { count:
 * 'exact', head: true })`) and be awaitable, because the cloud-progress readout
 * issues those — see `emptyCloudBuilder`.
 */
const CLOUD_SYNC_TABLES = new Set([
  'cloud_sync_allowlist',
  'cloud_games',
  'cloud_analyses',
  'cloud_puzzle_attempts',
]);

function emptyCloudBuilder(): BypassFromBuilder {
  // The empty answer, in the shape every consumer here reads it: `data` for row
  // queries, `count` for the head-only count queries the Settings card's cloud
  // progress readout issues (`cloudProgress.ts`).
  const empty = { data: [], count: 0, error: null };
  const selectBuilder = {
    eq: () => selectBuilder,
    in: () => selectBuilder,
    like: () => selectBuilder,
    range: async () => empty,
    maybeSingle: async () => ({ data: null, error: null }),
    // Thenable, so `await supabase.from(t).select('*', { count: 'exact', head:
    // true }).eq(...)` resolves instead of yielding the builder object. PostgREST
    // builders are themselves promises; the stub has to be one too, or a count
    // query reads `count` off a builder and renders `undefined`. Cloud sync is
    // mounted in `AppLayout`, so this path runs in EVERY browser test.
    then: (
      onFulfilled?: (v: typeof empty) => unknown,
      onRejected?: (e: unknown) => unknown,
    ) => Promise.resolve(empty).then(onFulfilled, onRejected),
  } as unknown as BypassSelectBuilder;
  return {
    select: () => selectBuilder,
    insert: async () => ({ error: null }),
    upsert: async () => ({ error: null }),
    update: () => ({ eq: async () => ({ error: null }) }),
  };
}

export function getBypassedSupabaseClient(): SupabaseClient {
  const stub = {
    from(table: string): BypassFromBuilder {
      if (CLOUD_SYNC_TABLES.has(table)) return emptyCloudBuilder();
      if (table !== 'profiles') {
        throw new Error(`[testAuth] bypass stub does not implement table "${table}"`);
      }
      const filters: Array<{ column: string; value: string }> = [];

      const selectBuilder: BypassSelectBuilder = {
        eq(column, value) {
          filters.push({ column, value });
          return selectBuilder;
        },
        async maybeSingle() {
          const idFilter = filters.find((f) => f.column === 'id');
          if (!idFilter) {
            return { data: null, error: null };
          }
          const row = profileTable.get(idFilter.value) ?? null;
          return { data: row, error: null };
        },
      };

      return {
        select() {
          return selectBuilder;
        },
        async insert(row) {
          if (profileTable.has(row.id)) {
            return { error: { message: 'duplicate key', code: '23505' } };
          }
          profileTable.set(row.id, mergeRow(undefined, row));
          return { error: null };
        },
        async upsert(row) {
          profileTable.set(row.id, mergeRow(profileTable.get(row.id), row));
          return { error: null };
        },
        update(patch) {
          return {
            async eq(column, value) {
              if (column !== 'id') {
                return { error: { message: `[testAuth] update only supports .eq('id', ...) — got ${column}` } };
              }
              const prev = profileTable.get(value);
              if (!prev) {
                // Real Postgres would return 0 rows affected without an
                // error; mirror that.
                return { error: null };
              }
              profileTable.set(value, { ...prev, ...patch, id: value });
              return { error: null };
            },
          };
        },
      };
    },
  };
  // The runtime shape is a subset of SupabaseClient; cast through unknown
  // because TS can't see that our consumers only touch `.from('profiles')`.
  return stub as unknown as SupabaseClient;
}
