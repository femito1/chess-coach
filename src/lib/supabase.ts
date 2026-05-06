import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { useAuth } from '@clerk/clerk-react';
import { useMemo } from 'react';
import { authEnv } from './env';
import { getBypassedSupabaseClient, isE2EBypass } from './testAuth';

/**
 * Supabase client bound to the current Clerk session.
 *
 * Per Supabase's third-party-auth model, we hand it an `accessToken`
 * resolver that returns Clerk's current JWT. Supabase calls this on every
 * request, so token refresh is handled implicitly — the resolver gets
 * Clerk's *current* token each time, not a snapshot.
 *
 * Caveats:
 * - `supabase.auth.*` methods will throw when the `accessToken` option is
 *   set (Supabase enforces "one source of truth" for auth). That's fine —
 *   we use Clerk for sign-in / session and Supabase only for the
 *   `profiles` table.
 * - Anonymous (signed-out) calls return `null` from the resolver, which
 *   Supabase treats as no auth → RLS evaluates with the `anon` role and
 *   blocks all reads/writes against `profiles` (by design).
 */

let anonymousClient: SupabaseClient | null = null;

/**
 * Build a Supabase client whose JWT comes from Clerk's `getToken()`.
 *
 * Pure factory — does not call Clerk hooks. Designed to be invoked from a
 * React component that already has access to a `getToken` function (e.g.
 * via `useAuth()`), or from non-React code that holds a token resolver.
 */
export function buildSupabaseClient(
  getToken: () => Promise<string | null>,
): SupabaseClient {
  return createClient(authEnv.supabaseUrl, authEnv.supabaseAnonKey, {
    accessToken: async () => (await getToken()) ?? null,
    auth: {
      // We're not using Supabase Auth at all — Clerk owns the session.
      // Disabling these prevents the SDK from spinning up its own auth
      // state machine in the background (it would otherwise try to read
      // / write `localStorage` even though we never call `signIn`).
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}

/**
 * Anonymous (no Clerk session) client. Used by integration tests and the
 * sign-in page itself — anywhere we need the SDK shape but RLS will
 * (correctly) refuse to return any rows. Cached in a module-level singleton
 * because there's no token to vary by request.
 */
export function getAnonymousSupabaseClient(): SupabaseClient {
  if (!anonymousClient) {
    anonymousClient = createClient(authEnv.supabaseUrl, authEnv.supabaseAnonKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    });
  }
  return anonymousClient;
}

/**
 * React hook: returns a Supabase client bound to the *current* Clerk
 * session, recomputing only when the user identity changes (not on every
 * render). Components inside `<ClerkProvider>` can call this freely.
 */
export function useSupabase(): SupabaseClient {
  const { getToken, userId } = useAuth();

  return useMemo(() => {
    if (isE2EBypass()) {
      return getBypassedSupabaseClient();
    }
    return buildSupabaseClient(async () => {
      try {
        return await getToken();
      } catch {
        return null;
      }
    });
    // We intentionally key the memo on `userId` rather than `getToken`:
    // Clerk's `getToken` reference changes more often than the user
    // identity, and rebuilding the client on every render would defeat
    // any per-client caching Supabase does internally.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);
}
