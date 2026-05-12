/**
 * "Are there new Chess.com games since the user's last import?"
 *
 * Powers the `<NewGamesBanner>` that surfaces on app boot once the
 * user has finished onboarding and previously imported at least one
 * archive. The banner is the single source of truth for "did the user
 * play games on chess.com that aren't in their library yet?" — without
 * it, the user has to remember to visit /import after every session.
 *
 * Strategy (cheap + accurate):
 *
 *   1. Look up `ImportRecord`s for the current username, find the
 *      most recent one (latest by year+month).
 *   2. Walk the chess.com archive list in chronological order:
 *        - Months strictly newer than the latest record → every game
 *          in that month is new (the user opened a new month since we
 *          last synced).
 *        - The same month as the latest record → the user kept playing
 *          in the same month; count = `currentMonthGames -
 *          recordedGameCount`.
 *        - Months older → ignored (already imported, or deliberately
 *          skipped).
 *
 * To compute the count we have to fetch at most `(newest archives -
 * recorded month) + 1` months. In practice that's almost always 1 —
 * the user is mid-month, the latest record is for the current month,
 * and we fetch only this month's archive to compare counts. If the
 * user hasn't opened the app for a while, it might be a handful of
 * months. Still bounded and fast.
 *
 * The pure split (this file = pure logic, banner = imperative shell)
 * keeps the math unit-testable without spinning up a browser.
 */

import { parseArchiveUrl } from '@/api/chesscom';

/**
 * Descriptor for the latest ImportRecord we know about for a given
 * (source, username). Pure-data input to the planning helpers below.
 */
export interface LatestImportSnapshot {
  archiveUrl: string;
  year: number;
  month: number;
  /** `gameCount` from the record — what we last saw the chess.com API
   *  return for this archive. */
  gameCount: number;
  importedAt: number;
}

/**
 * Plan: which archives do we need to fetch + how do we interpret each
 * one's response? Returned by `planNewGameFetches` and consumed by
 * `computeNewGameCount` after the fetches resolve.
 *
 * The mode tells the count step whether to take the entire month
 * (strictly newer) or subtract the recorded gameCount (same month).
 */
export interface ArchiveFetchPlan {
  archiveUrl: string;
  year: number;
  month: number;
  mode: 'whole-month' | 'delta-from-record';
  /** Only set when `mode === 'delta-from-record'`. */
  recordedGameCount?: number;
}

/**
 * Sort archive URLs newest first using `parseArchiveUrl`. Mirrors the
 * sort the rest of `auto.ts` / `ImportPage` use so behaviours stay in
 * lockstep.
 */
export function sortArchivesNewestFirst(urls: string[]): string[] {
  const enriched = urls.map((url) => {
    const p = parseArchiveUrl(url);
    return { url, sortKey: p ? p.year * 12 + p.month : -1 };
  });
  enriched.sort((a, b) => b.sortKey - a.sortKey);
  return enriched.map((e) => e.url);
}

/**
 * Build the fetch plan from a chess.com archive list and the latest
 * known `ImportRecord`. Pure function — no fetches.
 *
 * `latest === null` means "user has no import records for this
 * username" → returns an empty plan because we don't want to fire a
 * "you have new games!" banner for a user who hasn't imported anything
 * yet (the onboarding wizard handles the first import; pestering them
 * here would be duplicative).
 */
export function planNewGameFetches(
  archiveUrls: string[],
  latest: LatestImportSnapshot | null,
): ArchiveFetchPlan[] {
  if (!latest) return [];
  const sortedNewestFirst = sortArchivesNewestFirst(archiveUrls);
  const latestKey = latest.year * 12 + latest.month;
  const plans: ArchiveFetchPlan[] = [];
  for (const url of sortedNewestFirst) {
    const p = parseArchiveUrl(url);
    if (!p) continue;
    const key = p.year * 12 + p.month;
    if (key < latestKey) break;
    if (key > latestKey) {
      plans.push({
        archiveUrl: url,
        year: p.year,
        month: p.month,
        mode: 'whole-month',
      });
    } else {
      plans.push({
        archiveUrl: url,
        year: p.year,
        month: p.month,
        mode: 'delta-from-record',
        recordedGameCount: latest.gameCount,
      });
    }
  }
  return plans;
}

/**
 * Reduce the fetched per-archive game counts into a single new-game
 * total. Pure — receives only the plan + actual counts.
 *
 * `archiveCounts` is keyed by archiveUrl → number of games returned
 * by `fetchMonth(url)`.
 *
 * Negative deltas (the user deleted games on chess.com — rare but
 * possible) clamp to zero so the banner never says "−3 new games".
 */
export function computeNewGameCount(
  plans: ArchiveFetchPlan[],
  archiveCounts: ReadonlyMap<string, number>,
): { count: number; archiveUrls: string[] } {
  let total = 0;
  const archives: string[] = [];
  for (const p of plans) {
    const current = archiveCounts.get(p.archiveUrl);
    if (current == null) continue;
    if (p.mode === 'whole-month') {
      if (current > 0) {
        total += current;
        archives.push(p.archiveUrl);
      }
    } else {
      const delta = current - (p.recordedGameCount ?? 0);
      if (delta > 0) {
        total += delta;
        archives.push(p.archiveUrl);
      }
    }
  }
  return { count: total, archiveUrls: archives };
}

/**
 * "Should we even ask?" gate. The banner consults this before
 * triggering any chess.com fetches so that:
 *   - Users mid-onboarding don't see a banner racing the wizard.
 *   - Users who have already imported all games this minute aren't
 *     bombarded after a refresh.
 *   - We don't hammer the chess.com API on every page reload — the
 *     last successful check is cached for `NEW_GAMES_MIN_RECHECK_MS`,
 *     and the banner reuses that cached result for rendering even
 *     when this gate refuses a re-fetch (so a reload within the
 *     window still shows "you have 4 new games" without a request).
 *
 * Pure — caller resolves "now" + persisted state.
 */
export interface ShouldCheckInputs {
  username: string;
  onboardingCompletedAt: number | undefined;
  /** Most recent ImportRecord.importedAt for this username, in epoch
   *  ms. Undefined if no records exist. */
  latestImportAt: number | undefined;
  /** Last time the banner finished a successful check (read from
   *  localStorage so it survives reloads). `null` if it hasn't run
   *  on this device yet. */
  lastCheckedAt: number | null;
  now: number;
}

export const NEW_GAMES_MIN_RECHECK_MS = 30 * 60 * 1000; // 30 minutes
/** Don't bother checking immediately after an import — the IR was
 *  just stamped and the chess.com API can lag a few seconds before
 *  reflecting newly-finished games. */
export const NEW_GAMES_GRACE_AFTER_IMPORT_MS = 30 * 1000;
/** Cached "you have N new games" results live this long. Reloads
 *  inside this window reuse the cache instead of re-fetching. After
 *  it expires the cached banner state is treated as stale and the
 *  banner re-checks chess.com on the next mount. */
export const NEW_GAMES_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export function shouldCheckForNewGames(input: ShouldCheckInputs): boolean {
  if (!input.username.trim()) return false;
  if (!input.onboardingCompletedAt) return false;
  if (!input.latestImportAt) return false;
  if (input.now - input.latestImportAt < NEW_GAMES_GRACE_AFTER_IMPORT_MS) {
    return false;
  }
  if (
    input.lastCheckedAt !== null &&
    input.now - input.lastCheckedAt < NEW_GAMES_MIN_RECHECK_MS
  ) {
    return false;
  }
  return true;
}

/**
 * Helper for the banner: figure out whether the user has already
 * dismissed *this exact count*, so a "Not now" tap on a "3 new games"
 * prompt doesn't make a "5 new games" prompt later disappear too.
 *
 * Stored in localStorage (not sessionStorage) so the dismissal
 * survives a page reload — a "Not now" should mean "stop showing me
 * this until the count changes or enough time passes", not "stop
 * showing me this until I close the tab and refresh, then ask again".
 */
export interface DismissalState {
  dismissedCount: number;
  dismissedAt: number;
}

export function isDismissedForCount(
  current: number,
  dismissal: DismissalState | null,
  now: number,
  ttlMs = NEW_GAMES_MIN_RECHECK_MS,
): boolean {
  if (!dismissal) return false;
  if (current > dismissal.dismissedCount) return false;
  if (now - dismissal.dismissedAt > ttlMs) return false;
  return true;
}

/**
 * Persisted "the last time we checked, here's how many new games
 * existed". Cached in localStorage so reloads inside the recheck
 * window don't have to refetch the chess.com archives — the user
 * sees the banner at the same count immediately after a reload.
 *
 * The cache is keyed by username so switching accounts doesn't show
 * the previous user's count.
 */
export interface NewGamesCacheEntry {
  /** Lower-cased Chess.com username this cache entry pertains to. */
  username: string;
  /** Epoch ms when the count was discovered. */
  discoveredAt: number;
  /** Number of new games at that moment. */
  count: number;
  /** Archive URLs containing the new games — fed straight into
   *  `doImport` when the user clicks "Import & analyze". */
  archiveUrls: string[];
}

export function isCacheEntryFresh(
  entry: NewGamesCacheEntry | null,
  forUsername: string,
  now: number,
  ttlMs = NEW_GAMES_CACHE_TTL_MS,
): boolean {
  if (!entry) return false;
  if (entry.username !== forUsername.trim().toLowerCase()) return false;
  if (entry.count <= 0) return false;
  if (now - entry.discoveredAt > ttlMs) return false;
  return true;
}
