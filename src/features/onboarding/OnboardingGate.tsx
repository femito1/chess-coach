import { useEffect, useState } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { getSettings } from '@/db/schema';
import { isE2EBypass } from '@/lib/testAuth';

/**
 * Once the user is signed in (the auth gate has already run), redirect
 * them to `/onboarding` until they've finished the wizard. After that,
 * the gate is a no-op and the inner `<Outlet />` (the real app layout)
 * renders normally.
 *
 * "Finished" = `Settings.onboardingCompletedAt` is set. The wizard
 * writes this on both successful and skipped exits, so a user who hits
 * "I'll do this later" lands on an empty dashboard rather than getting
 * looped back to the wizard on every reload.
 *
 * We deliberately read settings via a one-shot async effect rather than
 * `useLiveQuery`. `useLiveQuery` re-fires on every Dexie write (the
 * analyzer fires hundreds per minute) which would re-evaluate the
 * navigation decision constantly; for our purposes the value only
 * changes at exactly one moment per session (the wizard exit), so we
 * just read once on mount and trust it for the rest of the session.
 *
 * On the wizard route itself we render nothing — `<OnboardingPage>`
 * isn't a child of this gate. The parent routes file places it as a
 * sibling so it can render outside `<AppLayout>`.
 */
export function OnboardingGate() {
  const { t } = useTranslation();
  const location = useLocation();
  const [decided, setDecided] = useState<{ needs: boolean } | null>(null);

  // Auth-bypass test mode: skip onboarding entirely so existing
  // browser-driven tests can hit `/dashboard`, `/games`, etc. without
  // first having to script the wizard. Production builds can never
  // reach this branch (isE2EBypass() is gated on dev mode).
  const bypass = isE2EBypass();

  useEffect(() => {
    if (bypass) {
      setDecided({ needs: false });
      return;
    }
    let cancelled = false;
    void getSettings().then((s) => {
      if (cancelled) return;
      setDecided({ needs: typeof s.onboardingCompletedAt !== 'number' });
    });
    return () => {
      cancelled = true;
    };
    // We deliberately re-run on path change so that returning to the
    // app after completing onboarding reflects the new settings value
    // without a full reload. The fetch is one-shot per visit.
  }, [location.pathname, bypass]);

  if (decided === null) {
    return <div className="min-h-screen" aria-busy="true" aria-label={t('common.loading')} />;
  }

  if (decided.needs) {
    const target = `${location.pathname}${location.search}${location.hash}`;
    const redirect = target ? `?redirect_url=${encodeURIComponent(target)}` : '';
    return <Navigate to={`/onboarding${redirect}`} replace />;
  }

  return <Outlet />;
}
