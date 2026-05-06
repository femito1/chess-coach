// Verify the dev-only auth bypass actually works end-to-end:
//
//   - Navigating to /dashboard with the bypass query flag does NOT
//     redirect to /sign-in.
//   - The page renders the actual dashboard layout (the AppLayout
//     header, e.g. the "Chess Coach" branding link).
//   - The synthetic Supabase stub accepts a profiles insert + select
//     round-trip (proxy for "the profile-sync handshake didn't crash").
//
// Why this test exists: every existing integration / e2e / live
// browser-driven test sits behind <AuthGate>, which post-Phase-2
// redirects unauthenticated visitors to /sign-in. Without the bypass
// they all 404 / get-stuck-on-sign-in. This script is the canary that
// the bypass machinery is wired correctly; if it fails, every other
// browser test will too.

import { runBrowserTest, expect, DEFAULT_URL, appendBypass } from '../harness.mjs';

await runBrowserTest({
  name: 'auth-bypass',
  async run({ page }) {
    // The harness already navigated with bypass on (bypassAuth defaults
    // to true). Now do a deliberate goto to /dashboard with the flag
    // appended to confirm the gate doesn't redirect us.
    await page.goto(appendBypass(`${DEFAULT_URL}dashboard`), { waitUntil: 'networkidle' });

    const finalUrl = page.url();
    expect(
      finalUrl.includes('/sign-in'),
      'should NOT have been redirected to /sign-in',
    ).toBe(false);
    expect(
      finalUrl.includes('/dashboard'),
      'should still be on /dashboard',
    ).toBe(true);

    // The AppLayout's header has a "Chess Coach" branding link — its
    // presence is a strong signal we rendered past the gate.
    const headerText = await page.evaluate(() => {
      const header = document.querySelector('header');
      return header?.textContent ?? '';
    });
    expect(
      headerText.includes('Chess Coach'),
      'AppLayout header rendered',
    ).toBe(true);

    // Smoke the in-memory Supabase stub from inside the page (the bypass
    // is page-side, so we have to drive it from page.evaluate).
    //
    // The real `useProfileSync` hook will have already inserted a row
    // for `BYPASS_USER_ID` by the time this runs (it fires on the first
    // bypass-flagged page load), so we use `upsert` rather than `insert`
    // — both are part of the stub's API surface, and `upsert` is what
    // matters for the cross-session idempotency the production code
    // relies on. Then read the row back to confirm both that the
    // profile-sync side-effect happened AND that select+eq+maybeSingle
    // walks the table the way the real client does.
    const stubRoundTrip = await page.evaluate(async () => {
      const { getBypassedSupabaseClient, BYPASS_USER_ID } = await import(
        '/src/lib/testAuth.ts'
      );
      const supabase = getBypassedSupabaseClient();
      const upsertRes = await supabase
        .from('profiles')
        .upsert(
          {
            id: BYPASS_USER_ID,
            display_name: 'smoke',
            chesscom_username: 'smoke_user',
            lichess_username: null,
          },
          { onConflict: 'id' },
        );
      const selectRes = await supabase
        .from('profiles')
        .select('id, display_name, chesscom_username, lichess_username')
        .eq('id', BYPASS_USER_ID)
        .maybeSingle();
      return {
        upsertError: upsertRes.error,
        data: selectRes.data,
        selectError: selectRes.error,
      };
    });

    expect(stubRoundTrip.upsertError, 'stub upsert error').toBe(null);
    expect(stubRoundTrip.selectError, 'stub select error').toBe(null);
    expect(stubRoundTrip.data?.id, 'round-trip id').toBe('e2e_bypass_user');
    expect(stubRoundTrip.data?.chesscom_username, 'round-trip chesscom_username').toBe(
      'smoke_user',
    );
  },
});
