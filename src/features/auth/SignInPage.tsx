import { SignIn } from '@clerk/clerk-react';

/**
 * Full-page sign-in. Renders Clerk's hosted-style `<SignIn />` component
 * inline so the user never leaves our domain. Clerk's component handles
 * Google / GitHub / email-magic-link UI internally based on the providers
 * enabled in the Clerk dashboard (see SETUP_AUTH.md §1).
 *
 * Post-sign-in, Clerk redirects to `signInForceRedirectUrl` (the dashboard
 * by default; if the user was bounced here from a deep link, the auth gate
 * in `AppLayout` will route them to the right place after sign-in
 * because Clerk supports `redirect_url` query param out of the box).
 *
 * We use `routing="path"` (the default). Clerk's `<SignIn>` mounts at
 * `/sign-in` and owns its sub-paths (`/sign-in/factor-one`,
 * `/sign-in/sso-callback`, etc) — that's why our route is registered as
 * `sign-in/*` so React Router lets Clerk handle the rest.
 */
export function SignInPage() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-6 py-12 bg-bg">
      <div className="text-center mb-8">
        <h1 className="text-3xl font-semibold tracking-tight">
          <span className="text-accent">♞</span> Chess Coach
        </h1>
        <p className="text-sm text-text-muted mt-2 max-w-sm">
          Sign in to import your games, track your weaknesses, and build a
          repertoire that actually sticks.
        </p>
      </div>
      <SignIn
        path="/sign-in"
        routing="path"
        signUpUrl="/sign-in"
        forceRedirectUrl="/dashboard"
      />
    </div>
  );
}
