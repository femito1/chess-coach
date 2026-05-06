import { useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { useSupabase } from '@/lib/supabase';
import { useEffectiveAuth, useEffectiveUser, type EffectiveUser } from '@/lib/testAuth';
import { db, getSettings, updateSettings } from '@/db/schema';
import {
  decideBindAction,
  type BindAction,
  type CloudProfile,
} from './profileBind';

/**
 * Status surfaced to the UI so we can render a non-blocking warning when
 * a different Clerk user signs in on the same browser. The other states
 * are mostly for debugging — the UI doesn't render anything for them.
 */
export type ProfileSyncStatus =
  | { kind: 'idle' }
  | { kind: 'syncing' }
  | { kind: 'synced'; action: BindAction['kind'] }
  | { kind: 'error'; message: string }
  | { kind: 'mismatch'; boundUserId: string; attemptedUserId: string };

/**
 * One-shot profile-sync handshake on sign-in.
 *
 * Runs the pure `decideBindAction` reducer (`profileBind.ts`) against the
 * three inputs (Clerk identity, Supabase profile row, local Settings) and
 * applies the resulting action. Designed to be mounted exactly once high
 * in the tree (`AppLayout`).
 *
 * Re-runs whenever the Clerk user id changes (e.g. user signs out and a
 * different user signs in in the same tab). Idempotent: a returning
 * signed-in user with already-aligned state lands in `bindOnly` and
 * touches no I/O.
 */
export function useProfileSync(): ProfileSyncStatus {
  const { isLoaded, isSignedIn, userId } = useEffectiveAuth();
  const { user } = useEffectiveUser();
  const supabase = useSupabase();
  const [status, setStatus] = useState<ProfileSyncStatus>({ kind: 'idle' });

  useEffect(() => {
    if (!isLoaded || !isSignedIn || !userId) {
      setStatus({ kind: 'idle' });
      return;
    }

    let cancelled = false;
    setStatus({ kind: 'syncing' });

    runProfileSync({
      supabase,
      clerkUserId: userId,
      displayName: buildDisplayName(user),
    })
      .then((result) => {
        if (cancelled) return;
        if (result.kind === 'mismatch') {
          setStatus({
            kind: 'mismatch',
            boundUserId: result.boundClerkUserId,
            attemptedUserId: result.attemptedClerkUserId,
          });
          return;
        }
        setStatus({ kind: 'synced', action: result.actionKind });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console
        console.error('[profile-sync] failed:', err);
        setStatus({ kind: 'error', message });
      });

    return () => {
      cancelled = true;
    };
    // We intentionally key only on `userId` (not the user object — its
    // reference changes on every Clerk re-fetch even when identity
    // hasn't moved).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoaded, isSignedIn, userId]);

  return status;
}

/**
 * Build a display name for the empty profile insert. Tries Clerk's full
 * name → first name → primary email's local-part → undefined. Used as a
 * starting point for the user's profile; they can edit it later.
 */
function buildDisplayName(user: EffectiveUser | null): string | undefined {
  if (!user) return undefined;
  const full = `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim();
  if (full.length > 0) return full;
  if (user.firstName) return user.firstName;
  const email = user.primaryEmailAddress?.emailAddress;
  if (email) {
    const localPart = email.split('@')[0];
    if (localPart) return localPart;
  }
  return undefined;
}

interface SyncDeps {
  supabase: SupabaseClient;
  clerkUserId: string;
  displayName?: string;
}

type SyncResult =
  | { kind: 'applied'; actionKind: BindAction['kind'] }
  | {
      kind: 'mismatch';
      actionKind: 'refuseMismatch';
      boundClerkUserId: string;
      attemptedClerkUserId: string;
    };

/**
 * Imperative shell around `decideBindAction`. Reads the current cloud
 * profile + local settings, decides the action, and executes it. Returns
 * a structured result so the caller (the React hook above, or the
 * integration test, or any future imperative consumer) can branch on the
 * outcome without poking around in Dexie/Supabase a second time.
 */
export async function runProfileSync({
  supabase,
  clerkUserId,
  displayName,
}: SyncDeps): Promise<SyncResult> {
  const [cloud, settings] = await Promise.all([
    fetchCloudProfile(supabase, clerkUserId),
    getSettings(),
  ]);

  const priorBoundUserId = settings.boundClerkUserId;
  const action = decideBindAction(
    { userId: clerkUserId, displayName },
    cloud,
    { username: settings.username, boundClerkUserId: priorBoundUserId },
  );

  function patchForBind(
    newBoundId: string,
    extra: Parameters<typeof updateSettings>[0] = {},
  ): Parameters<typeof updateSettings>[0] {
    return shouldResetOnboardingOnBind(priorBoundUserId, newBoundId)
      ? { ...extra, boundClerkUserId: newBoundId, onboardingCompletedAt: undefined }
      : { ...extra, boundClerkUserId: newBoundId };
  }

  switch (action.kind) {
    case 'refuseMismatch':
      return {
        kind: 'mismatch',
        actionKind: action.kind,
        boundClerkUserId: action.boundClerkUserId,
        attemptedClerkUserId: action.attemptedClerkUserId,
      };
    case 'noop':
      return { kind: 'applied', actionKind: action.kind };
    case 'bindOnly':
      await updateSettings(patchForBind(action.bindClerkUserId));
      return { kind: 'applied', actionKind: action.kind };
    case 'insertProfile': {
      const { error } = await supabase.from('profiles').insert(action.profile);
      // RLS may legitimately fail an insert if the row already exists
      // from a concurrent tab — fall back to upsert by primary key.
      if (error && error.code === '23505') {
        const { error: upsertErr } = await supabase
          .from('profiles')
          .upsert(action.profile, { onConflict: 'id' });
        if (upsertErr) throw new Error(`profile upsert: ${upsertErr.message}`);
      } else if (error) {
        throw new Error(`profile insert: ${error.message}`);
      }
      await updateSettings(patchForBind(action.bindClerkUserId));
      return { kind: 'applied', actionKind: action.kind };
    }
    case 'pushUsernameToCloud': {
      const { error } = await supabase
        .from('profiles')
        .update({ chesscom_username: action.chesscomUsername })
        .eq('id', action.userId);
      if (error) throw new Error(`profile update: ${error.message}`);
      await updateSettings(patchForBind(action.bindClerkUserId));
      return { kind: 'applied', actionKind: action.kind };
    }
    case 'pullUsernameFromCloud': {
      await updateSettings(
        patchForBind(action.bindClerkUserId, { username: action.chesscomUsername }),
      );
      return { kind: 'applied', actionKind: action.kind };
    }
  }
}

/**
 * Pure helper: should we clear `onboardingCompletedAt` when binding the
 * device to `newBoundId`?
 *
 * Yes IFF the device was previously bound to a *different* Clerk user.
 * Fresh devices (`priorBoundUserId === undefined`) must NOT reset —
 * a user who hits "skip" in the wizard sets `onboardingCompletedAt`
 * to "now" before the first sign-in's bind handshake completes; if we
 * cleared it on every initial bind, the wizard's skip would loop them
 * back to onboarding forever. Same-user re-binds (re-running the
 * handshake on a new tab in an already-bound browser) are a no-op for
 * onboarding state.
 *
 * Pure / no I/O so it's covered by a fast unit test in
 * `useProfileSync.test.ts`.
 */
export function shouldResetOnboardingOnBind(
  priorBoundUserId: string | undefined,
  newBoundUserId: string,
): boolean {
  return priorBoundUserId !== undefined && priorBoundUserId !== newBoundUserId;
}

async function fetchCloudProfile(
  supabase: SupabaseClient,
  userId: string,
): Promise<CloudProfile | null> {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, display_name, chesscom_username, lichess_username')
    .eq('id', userId)
    .maybeSingle();
  if (error) {
    throw new Error(`profile fetch: ${error.message}`);
  }
  return (data as CloudProfile | null) ?? null;
}

/**
 * Test seam: lets integration tests reset the local sync state to the
 * "never signed in" condition without nuking the entire Dexie DB.
 */
export async function clearLocalProfileBinding(): Promise<void> {
  const settings = await getSettings();
  if (settings.boundClerkUserId === undefined) return;
  await db.settings.put({ ...settings, boundClerkUserId: undefined });
}
