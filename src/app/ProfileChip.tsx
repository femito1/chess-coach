import { UserButton } from '@clerk/clerk-react';

/**
 * Header profile chip. Renders Clerk's `<UserButton />` — opens a popover
 * with account info, "Manage account", and "Sign out".
 *
 * Phase 1 (off-plan additions in `PROJECT_STATUS.md`) shipped a hand-built
 * chip that linked to the Backup page when a username was set, or showed
 * a "Sign in" placeholder otherwise. Phase 2 swaps both behaviours for
 * Clerk's component while keeping the same header slot dimensions so the
 * layout doesn't reflow.
 *
 * The slot is sized for the existing 28-px chip; Clerk's UserButton lays
 * out at the same height by default so no width adjustment is needed.
 *
 * Note: this component is rendered *inside* `<AuthGate>`, which means
 * `useAuth().isSignedIn` is always true here. We don't need a fallback
 * for the signed-out case (the sign-in page renders a different layout).
 */
export function ProfileChip() {
  return (
    <div className="flex items-center">
      <UserButton
        appearance={{
          elements: {
            // Keep the avatar small enough to match the existing nav line
            // height (h-14 header → ~28 px avatar).
            avatarBox: 'w-7 h-7',
          },
        }}
      />
    </div>
  );
}
