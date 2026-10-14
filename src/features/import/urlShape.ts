/**
 * Pure URL-shape helpers shared by the chrome-extension deep-link
 * flow. Kept in their own module so they can be unit-tested without
 * pulling in `auto.ts`'s Dexie + chess.com-API imports — the unit-
 * test layer (vitest) is forbidden from touching IndexedDB.
 */

/**
 * Extract chess.com's numeric game id from any of the URL shapes
 * chess.com has shipped for finished games. Returns undefined if the
 * URL doesn't match a recognised shape.
 *
 * Shapes tolerated (in regex-priority order — most-specific first so
 * a bare `/game/<id>` doesn't shadow `/game/live/<id>`):
 *   - `/game/live/<id>`   — legacy live-game shape
 *   - `/live/game/<id>`   — historical archive-API shape
 *   - `/game/daily/<id>`  — correspondence games
 *   - `/game/<id>`        — current live-game shape (observed
 *                           2026-05-08 by user diagnostic console)
 *
 * The chrome extension reads the page URL and feeds it to the
 * importer's deep link, so the deep link can carry any of these.
 * `importGameByUrl` matches against archive entries first by exact
 * URL, then by extracted numeric id, so a shape mismatch between
 * the deep link and the API response still resolves cleanly.
 */
export function extractChessComGameId(url: string): string | undefined {
  const m = url.match(
    /chess\.com\/(?:game\/live\/|live\/game\/|game\/daily\/|game\/)(\d+)(?:\b|\/|$)/,
  );
  return m?.[1];
}

/** True for a correspondence-game URL (`/game/daily/<id>`), the one
 *  shape the archive API also uses for those games. */
export function isDailyGameUrl(url: string): boolean {
  return /chess\.com\/game\/daily\/\d+/.test(url);
}

/**
 * Generate the candidate `Game.id`s a given input URL could correspond
 * to. Returns the id derived from the input verbatim, plus the ids
 * we'd derive from each of the alternate URL shapes for the same
 * numeric game id. Lets `importGameByUrl` hit IndexedDB regardless of
 * which URL shape the original import used.
 *
 * Why this matters: chess.com has flipped the URL shape used on the
 * finished-game page at least three times (`/game/live/<id>` →
 * `/live/game/<id>` → bare `/game/<id>`). A user who imported a game
 * months ago (whose `Game.url` was stored as `/game/live/<id>`) and
 * then re-clicks the chrome extension's prompt today (which sees the
 * new `/game/<id>` shape) should still hit the IndexedDB cache. We
 * achieve that by hashing every shape variant for the same numeric
 * id and looking up all of them.
 */
export function candidateGameIdsForUrl(
  url: string,
  hashFn: (s: string) => string,
): string[] {
  const ids = new Set<string>();
  ids.add(hashFn(url));

  const numericId = extractChessComGameId(url);
  if (numericId) {
    // Generate every known shape variant for this numeric id. Cheap
    // (3 string-builds + 3 hash calls) and stable across chess.com
    // refactors — adding the next shape only requires extending this
    // list, not changing the deep-link or matching logic.
    //
    // Daily games have one shape of their own and a separate id space
    // (a daily id can equal some live game's id), so a daily URL only
    // varies into the daily shape and a live one only into live shapes.
    const SHAPES = isDailyGameUrl(url)
      ? [`https://www.chess.com/game/daily/${numericId}`]
      : [
          `https://www.chess.com/game/live/${numericId}`,
          `https://www.chess.com/live/game/${numericId}`,
          `https://www.chess.com/game/${numericId}`,
        ];
    for (const shape of SHAPES) {
      if (shape !== url) ids.add(hashFn(shape));
    }
  }
  return [...ids];
}

/**
 * Candidate months to scan for an end-of-game URL, newest first,
 * deduped. Chess.com's API has no per-game endpoint, so to find a
 * single game we have to fetch a monthly archive and filter; this
 * helper keeps the per-call cost predictable by bounding the search
 * to (at most) three months:
 *
 *   1. Month containing `endTime` (if provided).
 *   2. Current month.
 *   3. Previous month.
 *
 * `now` is injectable so unit tests can pin "the current month"
 * deterministically.
 */
export function candidateMonths(
  endTimeMs?: number,
  now: Date = new Date(),
): Array<{ year: number; month: number }> {
  const out: Array<{ year: number; month: number }> = [];
  const seen = new Set<string>();
  const push = (d: Date) => {
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth() + 1;
    const key = `${y}-${m}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ year: y, month: m });
  };
  if (typeof endTimeMs === 'number' && Number.isFinite(endTimeMs) && endTimeMs > 0) {
    push(new Date(endTimeMs));
  }
  push(now);
  const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  push(prev);
  return out;
}

/**
 * Older months scanned once `candidateMonths` misses. Bounds a deep link
 * with a wrong username (which can never hit) to a couple of years of
 * fetches instead of the player's whole history.
 */
export const MAX_WIDENED_MONTHS = 24;

/**
 * The months to scan, newest first, after the `candidateMonths` window
 * missed: every archive the player has that was not already tried, up to
 * `limit`.
 *
 * Needed because the extension's `endTime` hint is the time of the
 * click, not of the game — the page exposes no reliable end time. For a
 * game just finished that is the right month, but for one opened from
 * the archive months later it is not, and the game sat outside the
 * three-month window. Archives are listed from Chess.com's own index, so
 * months the player never played cost nothing.
 */
export function widenedSearchMonths(
  archives: ReadonlyArray<{ url: string; year: number; month: number }>,
  tried: ReadonlyArray<{ year: number; month: number }>,
  limit: number = MAX_WIDENED_MONTHS,
): string[] {
  const triedKeys = new Set(tried.map((m) => m.year * 12 + m.month));
  return archives
    .filter((a) => !triedKeys.has(a.year * 12 + a.month))
    .sort((a, b) => b.year * 12 + b.month - (a.year * 12 + a.month))
    .slice(0, Math.max(0, limit))
    .map((a) => a.url);
}

/**
 * Build a chess.com archive URL for `(username, year, month)`. Same
 * shape `fetchArchives` returns from chess.com.
 */
export function monthArchiveUrl(
  username: string,
  year: number,
  month: number,
): string {
  const mm = String(month).padStart(2, '0');
  return `https://api.chess.com/pub/player/${encodeURIComponent(username)}/games/${year}/${mm}`;
}
