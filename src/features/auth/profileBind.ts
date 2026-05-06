/**
 * Pure logic for the "bind Clerk user ↔ Supabase profile ↔ local
 * Settings" handshake that runs once on every sign-in.
 *
 * Lives in its own file (with no I/O imports) so the policy is exhaustive,
 * deterministic, and unit-testable. The only consumer is `useProfileSync`,
 * which executes the actions this reducer returns against Supabase + Dexie.
 *
 * State machine (see `PROJECT_STATUS.md` §10 Phase 2):
 *
 *  | local username | cloud username    | bound user      | action          |
 *  | -------------- | ----------------- | --------------- | --------------- |
 *  | set            | unset             | unset           | push local→cloud, bind |
 *  | unset          | unset             | unset           | insert empty profile, bind |
 *  | set            | set, same         | unset           | bind (already aligned) |
 *  | unset          | set               | unset           | pull cloud→local, bind |
 *  | set, same      | set, same         | matches         | no-op (steady state) |
 *  | set, different | set               | matches         | push local→cloud (user edited locally) |
 *  | set            | set, different    | matches         | pull cloud→local (other device wrote it) |
 *  | any            | any               | DIFFERENT clerk | refuse (mismatch) |
 *
 * Cloud wins when local and cloud disagree on a returning user. Phase 3
 * (cross-device cloud backup) makes "cloud is the source of truth" the
 * formal contract; Phase 2 already follows it so behaviour doesn't change
 * once Phase 3 ships.
 */

export interface ClerkIdentity {
  /** Clerk's stable user id (e.g. `user_2abc...`). */
  userId: string;
  /** Display name for the empty profile insert. Optional — Clerk doesn't
   *  always have one (magic-link sign-ups have no name initially). */
  displayName?: string;
}

export interface CloudProfile {
  id: string;
  display_name: string | null;
  chesscom_username: string | null;
  lichess_username: string | null;
}

export interface LocalSettingsSnapshot {
  username: string;
  boundClerkUserId?: string;
}

/**
 * The ten possible outcomes of the bind handshake. `kind` discriminates
 * which side-effect(s) the caller should perform.
 */
export type BindAction =
  | { kind: 'noop' }
  | {
      kind: 'insertProfile';
      profile: { id: string; display_name: string | null; chesscom_username: string | null };
      bindClerkUserId: string;
    }
  | {
      kind: 'pushUsernameToCloud';
      userId: string;
      chesscomUsername: string;
      bindClerkUserId: string;
    }
  | {
      kind: 'pullUsernameFromCloud';
      chesscomUsername: string;
      bindClerkUserId: string;
    }
  | { kind: 'bindOnly'; bindClerkUserId: string }
  | {
      kind: 'refuseMismatch';
      boundClerkUserId: string;
      attemptedClerkUserId: string;
    };

const norm = (s: string | null | undefined): string => (s ?? '').trim();

/**
 * Decide what to do given the current sign-in state.
 *
 * @param clerk      Currently-signed-in Clerk identity.
 * @param cloud      The user's `profiles` row from Supabase, or `null` if
 *                   it doesn't exist yet (= first time we've seen this
 *                   Clerk user).
 * @param local      Snapshot of the local Dexie `Settings` row.
 */
export function decideBindAction(
  clerk: ClerkIdentity,
  cloud: CloudProfile | null,
  local: LocalSettingsSnapshot,
): BindAction {
  if (local.boundClerkUserId && local.boundClerkUserId !== clerk.userId) {
    return {
      kind: 'refuseMismatch',
      boundClerkUserId: local.boundClerkUserId,
      attemptedClerkUserId: clerk.userId,
    };
  }

  const localUsername = norm(local.username);

  if (!cloud) {
    if (localUsername.length > 0) {
      return {
        kind: 'insertProfile',
        profile: {
          id: clerk.userId,
          display_name: clerk.displayName ?? null,
          chesscom_username: localUsername,
        },
        bindClerkUserId: clerk.userId,
      };
    }
    return {
      kind: 'insertProfile',
      profile: {
        id: clerk.userId,
        display_name: clerk.displayName ?? null,
        chesscom_username: null,
      },
      bindClerkUserId: clerk.userId,
    };
  }

  const cloudUsername = norm(cloud.chesscom_username);

  if (localUsername === cloudUsername) {
    return { kind: 'bindOnly', bindClerkUserId: clerk.userId };
  }

  if (cloudUsername.length === 0 && localUsername.length > 0) {
    return {
      kind: 'pushUsernameToCloud',
      userId: clerk.userId,
      chesscomUsername: localUsername,
      bindClerkUserId: clerk.userId,
    };
  }

  if (cloudUsername.length > 0) {
    return {
      kind: 'pullUsernameFromCloud',
      chesscomUsername: cloudUsername,
      bindClerkUserId: clerk.userId,
    };
  }

  // Both empty — same as the `localUsername === cloudUsername` branch
  // above; reached only if either side is whitespace-only after trim.
  return { kind: 'bindOnly', bindClerkUserId: clerk.userId };
}
