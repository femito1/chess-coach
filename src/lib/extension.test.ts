import { describe, it, expect } from 'vitest';
import {
  CHROME_EXTENSION_ID,
  CHROME_EXTENSION_SLUG,
  CHROME_EXTENSION_STORE_URL,
  chromeWebStoreUrl,
} from './extension';

describe('chromeWebStoreUrl', () => {
  it('produces a slug-less URL when only the id is given', () => {
    expect(chromeWebStoreUrl('abc123')).toBe(
      'https://chromewebstore.google.com/detail/abc123',
    );
  });

  it('includes the slug segment before the id when provided', () => {
    expect(chromeWebStoreUrl('abc123', 'cool-extension')).toBe(
      'https://chromewebstore.google.com/detail/cool-extension/abc123',
    );
  });

  it('always uses the canonical chromewebstore.google.com host', () => {
    // The legacy `chrome.google.com/webstore` host still resolves but
    // 301s to the canonical one — so we link to canonical directly to
    // skip the redirect.
    const url = chromeWebStoreUrl('x', 'y');
    expect(url.startsWith('https://chromewebstore.google.com/')).toBe(true);
    expect(url.includes('chrome.google.com/webstore')).toBe(false);
  });
});

describe('CHROME_EXTENSION_STORE_URL', () => {
  // Locks the published-extension identity. If this test fails because
  // someone changed the id, that's a deliberate decision (re-publication
  // under a different developer account) and the test value should be
  // updated to match. If it fails because someone changed the slug,
  // double-check the Web Store listing — the slug is auto-derived from
  // the listing name and changes when the name changes.
  it('matches the published Chess Coach extension id', () => {
    expect(CHROME_EXTENSION_ID).toBe('gocmhcmncjaokcfcnfjjkaglconhiedo');
  });

  it('uses the cosmetic slug derived from the listing name', () => {
    expect(CHROME_EXTENSION_SLUG).toBe('chess-coach-review-after-game');
  });

  it('composes a valid web store URL from id + slug', () => {
    expect(CHROME_EXTENSION_STORE_URL).toBe(
      chromeWebStoreUrl(CHROME_EXTENSION_ID, CHROME_EXTENSION_SLUG),
    );
  });
});
