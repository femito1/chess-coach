import { describe, expect, it } from 'vitest';
import { NNUE_NET_FILE, resolveNetLocation } from './nnue';

/**
 * `resolveNetLocation` decides where the 38.3 MiB NNUE net comes from, and the
 * two ways it can be wrong are both invisible at runtime:
 *
 *   - resolving to a URL nobody serves → the probe fails and every eval quietly
 *     drops to the classical evaluator, which is exactly the regression the
 *     whole NNUE effort was undoing;
 *   - resolving to a net with a DIFFERENT hash → same outcome, one origin over,
 *     and the `copy-nnue.mjs` coherence guard can't see it because the file
 *     isn't local.
 *
 * So the shapes are pinned here rather than left to the browser test, which can
 * only afford to exercise one of them.
 */
describe('resolveNetLocation', () => {
  const NET = 'nn-testhash1234.nnue';

  describe('same-origin (VITE_NNUE_NET_URL unset)', () => {
    it('serves the net from the Vite base and sends a bare filename', () => {
      const loc = resolveNetLocation(undefined, '/', NET);
      expect(loc.remote).toBe(false);
      expect(loc.url).toBe(`/stockfish/${NET}`);
      // Bare, not a path: Stockfish resolves `EvalFile` next to its worker
      // script, and an absolute `/stockfish/…` breaks a non-root base.
      expect(loc.evalFile).toBe(NET);
      expect(loc.error).toBeUndefined();
    });

    it('honours a non-root base (GitHub Pages)', () => {
      const loc = resolveNetLocation(undefined, '/chess-coach/', NET);
      expect(loc.url).toBe(`/chess-coach/stockfish/${NET}`);
      expect(loc.evalFile).toBe(NET);
    });

    it('treats empty and whitespace-only as unset', () => {
      for (const raw of ['', '   ', '\n']) {
        expect(resolveNetLocation(raw, '/', NET).remote).toBe(false);
      }
    });
  });

  describe('remote', () => {
    it('appends the net filename to a bare host', () => {
      const loc = resolveNetLocation('https://pub-abc.r2.dev', '/', NET);
      expect(loc.remote).toBe(true);
      expect(loc.url).toBe(`https://pub-abc.r2.dev/${NET}`);
      // Both the same absolute URL: Stockfish passes `EvalFile` straight to
      // `emscripten_fetch`, so it fetches exactly what the probe checked.
      expect(loc.evalFile).toBe(loc.url);
      expect(loc.error).toBeUndefined();
    });

    it('appends under a path prefix, with or without a trailing slash', () => {
      const bare = resolveNetLocation('https://h/nets', '/', NET);
      const slash = resolveNetLocation('https://h/nets/', '/', NET);
      expect(bare.url).toBe(`https://h/nets/${NET}`);
      expect(slash.url).toBe(`https://h/nets/${NET}`);
    });

    it('collapses redundant trailing slashes rather than emitting //', () => {
      expect(resolveNetLocation('https://h/nets///', '/', NET).url).toBe(
        `https://h/nets/${NET}`,
      );
    });

    it('accepts the full net URL, which is what a dashboard hands you', () => {
      const full = `https://pub-abc.r2.dev/${NET}`;
      const loc = resolveNetLocation(full, '/', NET);
      expect(loc.remote).toBe(true);
      expect(loc.url).toBe(full);
      expect(loc.evalFile).toBe(full);
    });

    it('accepts http for a local test host', () => {
      // Not a recommendation — the probe warns about mixed content on an https
      // page. But the cross-origin integration test needs it.
      expect(resolveNetLocation('http://localhost:5199', '/', NET).remote).toBe(true);
    });

    it('ignores the Vite base entirely', () => {
      const loc = resolveNetLocation('https://h', '/chess-coach/', NET);
      expect(loc.url).toBe(`https://h/${NET}`);
    });
  });

  describe('rejection falls back to same-origin with an error', () => {
    // Never throws: an env-var typo must not white-screen the app. The strict
    // half of this lives in `scripts/copy-nnue.mjs`, which fails the build.
    const bad = (raw: string) => resolveNetLocation(raw, '/', NET);

    it('rejects a value with no scheme', () => {
      const loc = bad('pub-abc.r2.dev');
      expect(loc.error).toMatch(/not an absolute URL/);
      expect(loc.remote).toBe(false);
      expect(loc.evalFile).toBe(NET);
    });

    it('rejects a non-http(s) scheme', () => {
      expect(bad('ftp://h/nets').error).toMatch(/http\(s\)/);
      expect(bad('file:///tmp/nets').error).toMatch(/http\(s\)/);
    });

    it('rejects a query string or fragment', () => {
      // A signed URL cannot work: every worker re-fetches the net long after a
      // short-lived signature expires.
      expect(bad('https://h/nets?sig=abc').error).toMatch(/query string or fragment/);
      expect(bad('https://h/nets#x').error).toMatch(/query string or fragment/);
    });

    it('rejects a URL naming a different net', () => {
      const loc = bad('https://h/nn-deadbeef0000.nnue');
      expect(loc.error).toMatch(/nn-deadbeef0000\.nnue/);
      expect(loc.error).toMatch(NET);
      expect(loc.remote).toBe(false);
    });

    it('accepts the net this build actually asks for', () => {
      // Guards the real constant, so a Stockfish upgrade that changes the net
      // without updating callers shows up here too.
      const loc = resolveNetLocation(
        `https://h/${NNUE_NET_FILE}`,
        '/',
        NNUE_NET_FILE,
      );
      expect(loc.error).toBeUndefined();
      expect(loc.remote).toBe(true);
    });
  });
});
