/**
 * Single source of truth for the Chrome Web Store identity of the
 * "Chess Coach — Review After Game" browser extension.
 *
 * The extension was published 2026-05-13 under id
 * `gocmhcmncjaokcfcnfjjkaglconhiedo`. The Chrome Web Store resolves
 * detail URLs from the id alone (with or without the slug segment),
 * which is why we keep the id as the load-bearing constant and treat
 * the slug as cosmetic.
 *
 * Why this lives in `src/lib/` rather than being inlined where it's
 * used: the URL appears in two places today (the Settings page promo
 * and — eventually — the manual import page callout) and we expect
 * to add more (release-notes posts, marketing copy, etc.). A single
 * constant means a future re-publication under a different id only
 * touches this file. Tests pin the URL builder so the format can't
 * silently rot.
 *
 * Note on `chrome://` URLs: the in-browser `chrome://extensions/?id=…`
 * URL works for managing an *already-installed* extension on the
 * user's own machine, but it cannot be linked from a regular web
 * origin (Chrome blocks `chrome:` schemes from web pages for
 * security). All links from the app must go through the public web
 * store URL below.
 */

/** Stable Chrome Web Store extension id. The 32-char a-p alphabet
 *  is not a coincidence — it's a hash of the developer's signing
 *  key, so this is invariant across version bumps. Re-publishing
 *  under a fresh developer account would change it; nothing else. */
export const CHROME_EXTENSION_ID = 'gocmhcmncjaokcfcnfjjkaglconhiedo';

/** Cosmetic slug. The web store auto-derives this from the listing
 *  name and uses it in canonical URLs for SEO; users land on the
 *  same page either way. Kept here so search engines / shared
 *  links get the friendly path. */
export const CHROME_EXTENSION_SLUG = 'chess-coach-review-after-game';

/** Display name used in user-facing copy. Matches the Web Store
 *  listing exactly so copy stays consistent if a user toggles
 *  between the listing and the in-app prompt. */
export const CHROME_EXTENSION_NAME = 'Chess Coach — Review After Game';

/** Public install URL. Resolves to the canonical detail page
 *  regardless of slug — Google redirects slug-less requests to the
 *  slug version automatically. We include the slug because shared
 *  / pasted links read better with it ("…/detail/chess-coach-…"
 *  vs "…/detail/gocmhc…"), and because it survives copy-paste into
 *  e.g. release notes without being mistaken for a hash. */
export const CHROME_EXTENSION_STORE_URL = `https://chromewebstore.google.com/detail/${CHROME_EXTENSION_SLUG}/${CHROME_EXTENSION_ID}`;

/** Build a Web Store detail URL for a given extension id. Exported
 *  primarily so the unit test can pin the format without coupling
 *  to the constant above (a copy-paste error in `CHROME_EXTENSION_ID`
 *  shouldn't make the test trivially pass). */
export function chromeWebStoreUrl(id: string, slug?: string): string {
  const path = slug ? `${slug}/${id}` : id;
  return `https://chromewebstore.google.com/detail/${path}`;
}
