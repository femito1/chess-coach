import { useClerk } from '@clerk/clerk-react';
import { useTranslation } from 'react-i18next';
import { useProfileSync } from './useProfileSync';

/**
 * Top-of-page warning rendered only when the profile-sync handshake
 * detects that a *different* Clerk user has signed in on a browser whose
 * local DB is bound to someone else. We refuse to silently merge the
 * data — instead the user sees this banner with two ways out: sign out,
 * or use a different browser profile.
 *
 * In every other state (idle / syncing / synced / transient error) this
 * component renders nothing. We deliberately don't surface the synced
 * action — Phase 3 will add a more deliberate "data sync" affordance and
 * we don't want a false-positive "your data was synced!" toast for what
 * is, in practice, a no-op handshake on the steady-state boot.
 */
export function ProfileSyncBanner() {
  const { t } = useTranslation();
  const status = useProfileSync();
  const clerk = useClerk();

  if (status.kind !== 'mismatch') return null;

  return (
    <div
      role="alert"
      className="mx-auto max-w-screen-2xl px-4 lg:px-8 mt-4 rounded-md border border-blunder/40 bg-blunder/10 text-sm py-3 flex items-start gap-3"
    >
      <div className="flex-1">
        <div className="font-medium text-text">{t('profileSync.differentAccount')}</div>
        <p className="text-text-muted mt-1 leading-relaxed">
          {t('profileSync.differentAccountDesc', { boundUserId: status.boundUserId, attemptedUserId: status.attemptedUserId })}
        </p>
      </div>
      <button
        type="button"
        onClick={() => void clerk.signOut()}
        className="shrink-0 self-start text-xs px-3 py-1.5 rounded border border-border bg-bg-soft hover:bg-bg-raised transition-colors"
      >
        {t('profileSync.signOut')}
      </button>
    </div>
  );
}
