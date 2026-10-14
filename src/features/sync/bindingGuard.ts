import { getSettings } from '@/db/schema';
import { isBoundToOtherUser } from '@/features/auth/profileBind';

/**
 * Refuse to sync a local library that belongs to another account.
 *
 * When user B signs in on a browser bound to user A, the profile handshake
 * refuses to merge and shows a banner — but sync is a separate trigger and used
 * not to ask. It then pushed A's whole library into B's cloud mirror (no DELETE
 * policy, so permanently) and pulled B's into A's local database. Every sync
 * entry point — full, attempt-only and repertoire — calls this first, so a
 * future caller cannot miss it. The rule itself is the handshake's
 * (`isBoundToOtherUser`), not a parallel one.
 */
export class BoundToOtherUser extends Error {
  constructor(
    readonly boundClerkUserId: string,
    readonly attemptedClerkUserId: string,
  ) {
    super(
      "This browser's data belongs to a different account, so cloud sync is paused " +
        'rather than mixing the two libraries. Sign out, or use a separate browser profile.',
    );
    this.name = 'BoundToOtherUser';
  }
}

export async function assertLocalDataBelongsTo(userId: string): Promise<void> {
  const { boundClerkUserId } = await getSettings();
  if (isBoundToOtherUser(boundClerkUserId, userId)) {
    throw new BoundToOtherUser(boundClerkUserId, userId);
  }
}
