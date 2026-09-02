// The first screen a new user ever sees, on the narrowest phone we support.
//
// Two defects were reported from a real phone, and both are the kind a
// screenshot-and-eyeball review passes over:
//
//   1. **The account card distorted.** Its layout was a single flex row at every
//      width: avatar, identity, confirm button. The identity column is `flex-1`
//      — `flex: 1 1 0%` — and flex distributes shrinkage in proportion to each
//      item's *basis*, so a basis of 0 absorbs none of it. The whole shortfall
//      came out of the two `auto`-basis items instead: the avatar, which had no
//      `shrink-0` and so went from a 48 px circle to 32×48, and the
//      `whitespace-nowrap` button. Measured before the fix: 32×48 avatar at
//      320 px, and a username clipped to 24–54 px of its 126 px at 360–390 px.
//      Note what this does NOT do — it never overflows the document, because
//      shrinking is precisely how flex avoids that. So `mobile-audit`, which
//      measures document width against window width, cannot see it. The
//      assertions here are on the avatar staying square and the name staying
//      unclipped, which is what "adapts" actually means for this card.
//
//   2. **Both cards claimed to be loading.** A single `confirming` boolean was
//      shared by the guessed account's card and the typed account's card, so
//      confirming either put *both* into "Confirming…" — the guessed account
//      appeared to be signing you in when you had deliberately picked the other
//      one. The fix stores which handle is in flight, so this asserts the two
//      labels differ during a confirm rather than that a spinner exists.
//
// Run: node scripts/run-tests.mjs --only=onboarding-mobile

import { runBrowserTest, expect, DEFAULT_URL, appendBypass } from '../harness.mjs';

/** The auth bypass identity's Clerk username, which is the first candidate
 *  `suggestUsernameCandidates` tries — so this is the handle the guess card
 *  ends up showing. */
const GUESSED = 'e2e';
/** Deliberately NOT the guess: the point is to tell two cards apart. */
const TYPED = 'magnuscarlsen';

/** Narrowest width we support, and the one that actually distorted the avatar. */
const PHONE = { width: 320, height: 720 };

await runBrowserTest({
  name: 'onboarding-mobile',
  skipInitialGoto: true,
  viewport: PHONE,
  async run({ page }) {
    // Every handle resolves, echoing itself back, so the guess and the typed
    // entry are two different real-looking accounts. Stubbed rather than hitting
    // chess.com: this test is about layout and state, and a live 404 for `e2e`
    // would make the guess card vanish.
    await page.route('**/api.chess.com/pub/player/**', (route) => {
      const handle = decodeURIComponent(route.request().url().split('/').pop() ?? '');
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          username: handle,
          name: `${handle} Player`,
          country: 'https://api.chess.com/pub/country/NO',
          avatar: null,
          player_id: 1,
          followers: 0,
        }),
      });
    });

    await page.goto(appendBypass(`${DEFAULT_URL}onboarding`), {
      waitUntil: 'domcontentloaded',
    });
    await page.waitForSelector(`button:has-text("Yes, that's me")`, { timeout: 20_000 });

    /** Geometry of the card holding a given button label. */
    const cardMetrics = (label) =>
      page.evaluate((needle) => {
        const btn = [...document.querySelectorAll('button')].find((b) =>
          b.textContent.includes(needle),
        );
        if (!btn) return null;
        const card = btn.closest('div[class*="bg-accent"]');
        const avatar = card.querySelector(
          'img[class*="rounded-full"], div[class*="rounded-full"]',
        );
        const ab = avatar.getBoundingClientRect();
        const bb = btn.getBoundingClientRect();
        // The username line: the only element in the card whose text is exactly
        // the handle.
        const name = [...card.querySelectorAll('div')].find(
          (d) => d.children.length === 0 && /^[a-z0-9_-]+$/i.test(d.textContent.trim()),
        );
        const doc = document.documentElement;
        return {
          avatarW: Math.round(ab.width),
          avatarH: Math.round(ab.height),
          nameW: name ? Math.round(name.getBoundingClientRect().width) : null,
          nameClipped: name ? name.scrollWidth > name.clientWidth + 1 : null,
          // Stacked = the button sits below the avatar rather than beside it.
          stacked: bb.top >= ab.bottom,
          docOverflow: doc.scrollWidth - doc.clientWidth,
        };
      }, label);

    const phone = await cardMetrics("Yes, that's me");
    console.log(`guess card @${PHONE.width}:`, JSON.stringify(phone));

    // --- 1: the card adapts instead of distorting ------------------------
    expect(
      phone.avatarW,
      `avatar stays a circle at ${PHONE.width}px — it was 32×48 before, a squashed ` +
        'ellipse, because it absorbed shrinkage the flex-1 text column could not',
    ).toBe(phone.avatarH);
    expect(
      phone.nameClipped,
      'the username is fully readable — it was clipped to a fraction of its width',
    ).toBe(false);
    expect(
      phone.stacked,
      'on a phone the action moves below the identity, which is where the room comes from',
    ).toBe(true);
    expect(
      phone.docOverflow,
      'and none of that is paid for with a horizontally scrolling page',
    ).toBe(0);

    // --- desktop must NOT inherit the stacked layout ---------------------
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.waitForTimeout(250);
    const desktop = await cardMetrics("Yes, that's me");
    console.log('guess card @1280:', JSON.stringify(desktop));
    expect(
      desktop.stacked,
      'at desktop width the card is still one row — the stacking is phone-only',
    ).toBe(false);
    expect(desktop.avatarW, 'and the avatar is still a circle').toBe(desktop.avatarH);

    // --- 2: only the confirmed card reports progress ---------------------
    await page.setViewportSize(PHONE);
    await page.fill('input', TYPED);
    await page.waitForSelector('button:has-text("Use this account")', { timeout: 20_000 });

    // Hold the confirm open long enough to observe. `updateSettings` is the
    // first await inside it, so delaying the settings write freezes the UI in
    // its in-flight state — instrumented from the test rather than by adding a
    // seam to the page.
    await page.evaluate(async () => {
      const { db } = await import('/src/db/schema.ts');
      const original = db.settings.put.bind(db.settings);
      db.settings.put = async (...args) => {
        await new Promise((r) => setTimeout(r, 1500));
        return original(...args);
      };
    });

    // Confirm the GUESSED account; the typed one must stay quiet.
    await page.click(`button:has-text("Yes, that's me")`);
    await page.waitForTimeout(400);

    const labels = await page.evaluate(() =>
      [...document.querySelectorAll('div[class*="bg-accent"] button')].map((b) =>
        b.textContent.trim(),
      ),
    );
    console.log('labels mid-confirm:', JSON.stringify(labels));

    expect(labels.length, 'both account cards are on screen for this check').toBe(2);
    expect(
      labels.filter((l) => l === 'Confirming…').length,
      'exactly ONE card reports progress — both did before, so the guessed account ' +
        'looked like it was signing you in when you had chosen the other',
    ).toBe(1);
    expect(
      labels[0],
      'and it is the card that was actually confirmed (the guess, listed first)',
    ).toBe('Confirming…');
    expect(
      labels[1],
      'the other card goes inert without claiming to be doing anything',
    ).toBe('Use this account');
  },
});
