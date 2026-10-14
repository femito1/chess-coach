import { SignIn } from '@clerk/clerk-react';
import { useTranslation } from 'react-i18next';

/**
 * Full-page sign-in. Renders Clerk's hosted-style `<SignIn />` component
 * inline so the user never leaves our domain. Clerk's component handles
 * Google / GitHub / email-magic-link UI internally based on the providers
 * enabled in the Clerk dashboard (see SETUP_AUTH.md §1).
 *
 * Post-sign-in, Clerk honours the `redirect_url` query param that
 * `AuthGate` / `OnboardingGate` attach when they bounce a deep link here,
 * and only falls back to the dashboard when there is none. That is why
 * this is `fallbackRedirectUrl`, not `forceRedirectUrl`: Clerk ranks a
 * force URL above the search param, so a signed-out extension link
 * (`/review-by-url?…`) used to land on the dashboard instead.
 *
 * We use `routing="path"` (the default). Clerk's `<SignIn>` mounts at
 * `/sign-in` and owns its sub-paths (`/sign-in/factor-one`,
 * `/sign-in/sso-callback`, etc) — that's why our route is registered as
 * `sign-in/*` so React Router lets Clerk handle the rest.
 */
export function SignInPage() {
  const { t } = useTranslation();
  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-6 py-12 bg-bg">
      <div className="text-center mb-8">
        <h1 className="text-3xl font-semibold tracking-tight">
          <span className="text-accent">♞</span> Chess Coach
        </h1>
        <p className="text-sm text-text-muted mt-2 max-w-sm">
          {t('signIn.tagline')}
        </p>
      </div>
      <SignIn
        path="/sign-in"
        routing="path"
        signUpUrl="/sign-in"
        fallbackRedirectUrl="/dashboard"
      />
    </div>
  );
}
