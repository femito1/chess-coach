import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Every SPA route must have a no-store `Cache-Control` entry in `public/_headers`.
 *
 * ── The bug this exists to prevent ───────────────────────────────────────
 *
 * Cloudflare Pages matches `_headers` against the **request** path, not the path
 * `_redirects` rewrites to. `_headers` used to list only `/` and `/index.html`,
 * which are the two URLs nobody navigates to directly — every real entry point is
 * a deep route, and those fell through to Cloudflare's default
 * `public, max-age=0, must-revalidate`.
 *
 * Measured on production before the fix:
 *
 *     /            no-cache, no-store, must-revalidate
 *     /settings    public, max-age=0, must-revalidate     ← unprotected
 *     /games       public, max-age=0, must-revalidate     ← unprotected
 *     /review/abc  public, max-age=0, must-revalidate     ← unprotected
 *
 * The symptom is the worst kind: a deploy that *appears* not to take effect. A
 * normal reload on a deep route can keep running the previous bundle while a hard
 * reload picks up the new one, so it reads as random flakiness rather than as
 * caching — and it cost a debugging session chasing a sync bug that was really a
 * stale bundle.
 *
 * A wildcard `/*` rule cannot fix it: Pages *appends* per-route headers to the
 * wildcard instead of replacing them, so `/assets/*` and `/stockfish/*` would
 * receive two conflicting `Cache-Control` values. Hence the enumeration, hence
 * this test — an enumeration with no guard is a list that goes stale the first
 * time someone adds a route.
 */

const repoRoot = resolve(__dirname, '..', '..');

/** Route paths as declared in the router, normalised to absolute. */
function declaredRoutes(): string[] {
  const src = readFileSync(resolve(repoRoot, 'src/app/routes.tsx'), 'utf8');
  const out: string[] = [];
  for (const m of src.matchAll(/path:\s*'([^']*)'/g)) {
    const p = m[1];
    if (p === '') continue;
    out.push(p.startsWith('/') ? p : `/${p}`);
  }
  return [...new Set(out)];
}

/** Paths in `_headers` that carry a no-store Cache-Control. */
function noStorePaths(): string[] {
  const src = readFileSync(resolve(repoRoot, 'public/_headers'), 'utf8');
  const out: string[] = [];
  let current: string | null = null;
  for (const raw of src.split('\n')) {
    const line = raw.trimEnd();
    if (line.startsWith('#') || line.trim() === '') continue;
    if (!line.startsWith(' ') && !line.startsWith('\t')) {
      current = line.trim();
      continue;
    }
    if (current && /^cache-control:.*no-store/i.test(line.trim())) out.push(current);
  }
  return out;
}

/** Does any `_headers` entry cover this route? `/review/*` covers `/review/:id`. */
function covers(entry: string, route: string): boolean {
  if (entry === route) return true;
  if (!entry.endsWith('/*')) return false;
  const prefix = entry.slice(0, -1); // keep the trailing slash
  return route.startsWith(prefix);
}

describe('SPA route caching', () => {
  const routes = declaredRoutes();
  const entries = noStorePaths();

  it('finds the routes and the header rules at all', () => {
    // Guards the parsers themselves: if either regex stops matching, every
    // assertion below would pass vacuously.
    expect(routes.length, 'routes parsed from routes.tsx').toBeGreaterThan(5);
    expect(entries.length, 'no-store entries parsed from _headers').toBeGreaterThan(5);
    expect(routes).toContain('/settings');
    expect(entries).toContain('/');
  });

  it.each([['/'], ...routes.map((r) => [r])])(
    'route %s is served no-store',
    (route) => {
      // A parameterised route (`/review/:id`) needs a wildcard entry; an exact
      // one would only protect the literal string ":id".
      const concrete = route.replace(/\/:[^/]+/g, '/x').replace(/\/\*$/, '/x');
      const ok = entries.some((e) => covers(e, route) || covers(e, concrete));
      expect(
        ok,
        `${route} has no no-store Cache-Control in public/_headers — a normal ` +
          'reload there can keep running the previous deploy\'s bundle. Add it, ' +
          'or add a wildcard entry that covers it.',
      ).toBe(true);
    },
  );
});
