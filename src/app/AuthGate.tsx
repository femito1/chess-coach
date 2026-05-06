import { useAuth } from '@clerk/clerk-react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { isE2EBypass } from '@/lib/testAuth';

/**
 * Route-level auth gate. Wraps the protected app tree (everything under
 * the main `<AppLayout>`) and:
 *
 * - Renders nothing while Clerk is still booting (`isLoaded === false`).
 *   This is intentional — we don't want a flash of the dashboard before
 *   Clerk has had a chance to restore the session, and we don't want a
 *   flash of the sign-in page either. A short blank moment on cold start
 *   is the least-bad option.
 * - Redirects to `/sign-in` when the user isn't signed in, preserving
 *   the originally-requested location in the `redirect_url` query string
 *   so we can bounce them back after sign-in (Clerk handles
 *   `redirect_url` natively).
 * - Otherwise renders the nested route (`<Outlet />`).
 *
 * Per `PROJECT_STATUS.md` §10 Phase 2 the whole app requires sign-in, so
 * there's no "anonymous mode" branch here. If we ever decide to support
 * a guest mode, this is the only place that needs to learn about it.
 */
export function AuthGate() {
  const { isLoaded, isSignedIn } = useAuth();
  const location = useLocation();

  // Dev-only test bypass. Production builds can never hit this branch
  // (the helper checks `import.meta.env.MODE === 'development'` first).
  if (isE2EBypass()) {
    return <Outlet />;
  }

  if (!isLoaded) {
    return <div className="min-h-screen" aria-busy="true" aria-label="Loading" />;
  }

  if (!isSignedIn) {
    const target = `${location.pathname}${location.search}${location.hash}`;
    const redirect = target && target !== '/sign-in' ? `?redirect_url=${encodeURIComponent(target)}` : '';
    return <Navigate to={`/sign-in${redirect}`} replace />;
  }

  return <Outlet />;
}
