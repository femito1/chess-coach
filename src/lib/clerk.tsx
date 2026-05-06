import { ClerkProvider } from '@clerk/clerk-react';
import { Outlet, useNavigate } from 'react-router-dom';
import { authEnv } from './env';

/**
 * Root layout that wraps the entire app in `<ClerkProvider>` so any
 * descendant can call Clerk hooks (`useAuth`, `useUser`, `<UserButton />`).
 *
 * Mounted at the router's top-level route (see `src/app/routes.tsx`) so
 * `useNavigate()` is available — Clerk needs it to wire post-sign-in
 * redirects through React Router instead of a full page reload.
 *
 * Visual theming follows the app's dark palette via Clerk's `appearance`
 * API. Kept minimal; can swap in a full theme later.
 */
export function ClerkRootLayout() {
  const navigate = useNavigate();

  return (
    <ClerkProvider
      publishableKey={authEnv.clerkPublishableKey}
      routerPush={(to) => navigate(to)}
      routerReplace={(to) => navigate(to, { replace: true })}
      // Pin Clerk to our in-app sign-in route. Without this, Clerk falls
      // back to its hosted Account Portal (`*.accounts.dev`), which sends
      // the user off-domain. We want the inline `<SignIn />` to handle
      // everything (and own the OAuth `sso-callback` sub-route under
      // `/sign-in/*`).
      signInUrl="/sign-in"
      // Where Clerk lands the user after sign-in if no `redirect_url`
      // query param is set (= the deep-linked path the user was bounced
      // from by the auth gate).
      signInFallbackRedirectUrl="/dashboard"
      signUpFallbackRedirectUrl="/dashboard"
      appearance={{
        // Variables set the global Clerk palette. We keep these aligned
        // with `tailwind.config.js`'s color tokens so Clerk's UI feels
        // native to the app rather than a popup from a different design
        // system.
        variables: {
          colorPrimary: '#7aa2f7', // accent
          colorBackground: '#161a22', // bg.soft — slightly lighter than the page bg so the card stands out
          colorInputBackground: '#1e242f', // bg.raised — inputs need to be lighter than the card
          colorInputText: '#e6e8eb', // text
          colorText: '#e6e8eb', // text
          colorTextSecondary: '#9aa3b2', // text.muted
          colorNeutral: '#9aa3b2',
          colorDanger: '#e06c75', // blunder
          colorSuccess: '#7bc47f', // good
          colorWarning: '#f0c36d', // inaccuracy
          colorShimmer: 'rgba(255, 255, 255, 0.06)',
          borderRadius: '0.5rem',
          fontFamily: 'Inter, system-ui, sans-serif',
        },
        // Per-element overrides for the few spots where the variable
        // palette alone doesn't give enough contrast against our very
        // dark page background.
        elements: {
          // The Clerk card itself: explicit lighter background, visible
          // border, and a subtle shadow lift so it doesn't blend into
          // the page.
          cardBox: {
            backgroundColor: '#161a22',
            border: '1px solid #2a313d',
            boxShadow: '0 10px 30px -15px rgba(0, 0, 0, 0.6)',
          },
          card: {
            backgroundColor: '#161a22',
            boxShadow: 'none',
          },
          // Social provider buttons: brighter border + hover so they're
          // clearly clickable on a dark card.
          socialButtonsIconButton: {
            backgroundColor: '#1e242f',
            border: '1px solid #2a313d',
            '&:hover': { backgroundColor: '#252b38' },
          },
          // Clerk's GitHub icon is a dark-on-transparent SVG that
          // disappears against our dark button background. Invert it to
          // white. (Google + Microsoft icons are full-colour, leave alone.)
          socialButtonsProviderIcon__github: {
            filter: 'invert(1) brightness(1.2)',
          },
          // Form inputs: subtle border so the field outline is visible.
          formFieldInput: {
            border: '1px solid #2a313d',
          },
          // The footer (sign-up link / "Don't have an account?") sits on
          // the page, not the card, in some Clerk layouts. Force the
          // matching bg so it doesn't show a seam.
          footer: {
            backgroundColor: 'transparent',
          },
        },
      }}
    >
      <Outlet />
    </ClerkProvider>
  );
}
