import { createBrowserRouter, Navigate } from 'react-router-dom';
import { AppLayout } from './AppLayout';
import { AuthGate } from './AuthGate';
import { ClerkRootLayout } from '@/lib/clerk';
import { DashboardPage } from '@/features/dashboard/DashboardPage';
import { ImportPage } from '@/features/import/ImportPage';
import { ImportAndReviewPage } from '@/features/import/ImportAndReviewPage';
import { GamesPage } from '@/features/games/GamesPage';
import { ReviewPage } from '@/features/review/ReviewPage';
import { SettingsPage } from '@/features/settings/SettingsPage';
import { PuzzlesPage } from '@/features/puzzles/PuzzlesPage';
import { RepertoirePage } from '@/features/repertoire/RepertoirePage';
import { RepertoireTrainer } from '@/features/repertoire/RepertoireTrainer';
import { PracticePage, PracticeRedirect } from '@/features/repertoire/PracticePage';
import { LibraryPage } from '@/features/openings/LibraryPage';
import { SignInPage } from '@/features/auth/SignInPage';
import { OnboardingPage } from '@/features/onboarding/OnboardingPage';
import { OnboardingGate } from '@/features/onboarding/OnboardingGate';
import { PrivacyPage } from '@/features/legal/PrivacyPage';

/**
 * Route tree:
 *
 *   ClerkRootLayout                  ← <ClerkProvider> + <Outlet />
 *   ├── /sign-in                     ← public
 *   └── AuthGate                     ← gates everything below on auth
 *       └── AppLayout                ← header / nav / boot banner
 *           └── /dashboard, /games, ...
 *
 * The split between `ClerkRootLayout` and `AuthGate` is intentional:
 * Clerk's provider must wrap the sign-in page too (otherwise `<SignIn />`
 * has no Clerk context), but the auth gate must NOT wrap it (otherwise
 * unauthenticated users get redirected to /sign-in from /sign-in, looping).
 */
/**
 * Note: we use `createBrowserRouter` (real paths) rather than
 * `createHashRouter` (hash-encoded paths). Clerk's OAuth flow returns to
 * a real path-based URL (e.g. `/sign-in/sso-callback`) which a hash router
 * never matches — the result is an infinite redirect loop between Clerk
 * and our auth gate. Real paths fix it. Static deploys need a SPA
 * fallback (every URL → `index.html`); Vite dev handles it automatically,
 * Cloudflare Pages / Netlify / Vercel via a one-line `_redirects` rule.
 */
export const router = createBrowserRouter([
  {
    path: '/',
    element: <ClerkRootLayout />,
    children: [
      { path: 'sign-in/*', element: <SignInPage /> },
      // Public privacy policy. Outside AuthGate so the Chrome Web
      // Store reviewer (and search engines) can load it without
      // signing in. The URL `/privacy` is what we paste into the
      // dev console's "Privacy policy" field.
      { path: 'privacy', element: <PrivacyPage /> },
      {
        element: <AuthGate />,
        children: [
          // The onboarding wizard sits OUTSIDE the OnboardingGate (so
          // it doesn't redirect itself in a loop) and outside AppLayout
          // (so the nav header doesn't appear during the focused flow).
          { path: 'onboarding', element: <OnboardingPage /> },
          {
            element: <OnboardingGate />,
            children: [
              {
                element: <AppLayout />,
                children: [
                  { index: true, element: <Navigate to="/dashboard" replace /> },
                  { path: 'dashboard', element: <DashboardPage /> },
                  { path: 'import', element: <ImportPage /> },
                  { path: 'review-by-url', element: <ImportAndReviewPage /> },
                  { path: 'games', element: <GamesPage /> },
                  { path: 'review/:id', element: <ReviewPage /> },
                  { path: 'puzzles', element: <PuzzlesPage /> },
                  { path: 'repertoire', element: <RepertoirePage /> },
                  { path: 'repertoire/:id/train', element: <RepertoireTrainer /> },
                  { path: 'repertoire/:id/drill', element: <PracticePage /> },
                  { path: 'practice', element: <PracticeRedirect /> },
                  { path: 'openings', element: <LibraryPage /> },
                  { path: 'settings', element: <SettingsPage /> },
                ],
              },
            ],
          },
        ],
      },
    ],
  },
]);
