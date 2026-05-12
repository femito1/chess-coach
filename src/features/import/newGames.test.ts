import { describe, it, expect } from 'vitest';
import {
  planNewGameFetches,
  computeNewGameCount,
  shouldCheckForNewGames,
  isDismissedForCount,
  isCacheEntryFresh,
  sortArchivesNewestFirst,
  NEW_GAMES_MIN_RECHECK_MS,
  NEW_GAMES_GRACE_AFTER_IMPORT_MS,
  NEW_GAMES_CACHE_TTL_MS,
  type LatestImportSnapshot,
  type NewGamesCacheEntry,
} from './newGames';

const ARCHIVE_BASE = 'https://api.chess.com/pub/player/u/games';

function url(year: number, month: number): string {
  return `${ARCHIVE_BASE}/${year}/${String(month).padStart(2, '0')}`;
}

const NOW = 1_750_000_000_000;

describe('sortArchivesNewestFirst', () => {
  it('sorts strictly by year+month descending', () => {
    const sorted = sortArchivesNewestFirst([
      url(2024, 1),
      url(2026, 5),
      url(2025, 12),
      url(2026, 1),
    ]);
    expect(sorted).toEqual([
      url(2026, 5),
      url(2026, 1),
      url(2025, 12),
      url(2024, 1),
    ]);
  });

  it('parks unparseable URLs at the end (defensive)', () => {
    const garbage = 'https://example.com/not-an-archive';
    const sorted = sortArchivesNewestFirst([url(2025, 1), garbage, url(2026, 1)]);
    expect(sorted[0]).toBe(url(2026, 1));
    expect(sorted[1]).toBe(url(2025, 1));
    expect(sorted[2]).toBe(garbage);
  });
});

describe('planNewGameFetches', () => {
  it('returns no plan when there is no latest record (defers to onboarding)', () => {
    const plans = planNewGameFetches([url(2026, 5)], null);
    expect(plans).toEqual([]);
  });

  it('plans the same-month archive as a delta-from-record fetch', () => {
    const latest: LatestImportSnapshot = {
      archiveUrl: url(2026, 5),
      year: 2026,
      month: 5,
      gameCount: 12,
      importedAt: NOW - 60 * 60 * 1000,
    };
    const plans = planNewGameFetches([url(2026, 5), url(2026, 4)], latest);
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({
      archiveUrl: url(2026, 5),
      mode: 'delta-from-record',
      recordedGameCount: 12,
    });
  });

  it('plans every archive newer than the latest record as a whole-month fetch', () => {
    const latest: LatestImportSnapshot = {
      archiveUrl: url(2026, 3),
      year: 2026,
      month: 3,
      gameCount: 20,
      importedAt: NOW - 30 * 24 * 3600 * 1000,
    };
    const plans = planNewGameFetches(
      [url(2025, 12), url(2026, 1), url(2026, 2), url(2026, 3), url(2026, 4), url(2026, 5)],
      latest,
    );
    expect(plans.map((p) => p.archiveUrl)).toEqual([
      url(2026, 5),
      url(2026, 4),
      url(2026, 3),
    ]);
    expect(plans.find((p) => p.archiveUrl === url(2026, 5))?.mode).toBe('whole-month');
    expect(plans.find((p) => p.archiveUrl === url(2026, 4))?.mode).toBe('whole-month');
    expect(plans.find((p) => p.archiveUrl === url(2026, 3))?.mode).toBe('delta-from-record');
  });
});

describe('computeNewGameCount', () => {
  it('sums whole-month fetches and clamps the same-month delta to zero', () => {
    const latest: LatestImportSnapshot = {
      archiveUrl: url(2026, 4),
      year: 2026,
      month: 4,
      gameCount: 10,
      importedAt: NOW - 10 * 60 * 1000,
    };
    const plans = planNewGameFetches([url(2026, 4), url(2026, 5)], latest);
    const counts = new Map<string, number>([
      [url(2026, 5), 7],
      [url(2026, 4), 12],
    ]);
    const r = computeNewGameCount(plans, counts);
    expect(r.count).toBe(7 + 2);
    expect(r.archiveUrls).toEqual([url(2026, 5), url(2026, 4)]);
  });

  it('clamps negative deltas to zero (e.g. user deleted games on chess.com)', () => {
    const latest: LatestImportSnapshot = {
      archiveUrl: url(2026, 4),
      year: 2026,
      month: 4,
      gameCount: 10,
      importedAt: NOW,
    };
    const plans = planNewGameFetches([url(2026, 4)], latest);
    const counts = new Map<string, number>([[url(2026, 4), 8]]);
    const r = computeNewGameCount(plans, counts);
    expect(r.count).toBe(0);
    expect(r.archiveUrls).toEqual([]);
  });

  it('skips archives with zero new games (no entry in archiveUrls)', () => {
    const latest: LatestImportSnapshot = {
      archiveUrl: url(2026, 4),
      year: 2026,
      month: 4,
      gameCount: 10,
      importedAt: NOW,
    };
    const plans = planNewGameFetches([url(2026, 4), url(2026, 5)], latest);
    const counts = new Map<string, number>([
      [url(2026, 5), 0],
      [url(2026, 4), 10],
    ]);
    const r = computeNewGameCount(plans, counts);
    expect(r.count).toBe(0);
    expect(r.archiveUrls).toEqual([]);
  });
});

describe('shouldCheckForNewGames', () => {
  const baseInputs = {
    username: 'user',
    onboardingCompletedAt: NOW - 24 * 3600 * 1000,
    latestImportAt: NOW - 24 * 3600 * 1000,
    lastCheckedAt: null,
    now: NOW,
  };

  it('passes the gate in the steady state', () => {
    expect(shouldCheckForNewGames(baseInputs)).toBe(true);
  });

  it('refuses when no username is set', () => {
    expect(shouldCheckForNewGames({ ...baseInputs, username: '' })).toBe(false);
  });

  it('refuses when onboarding is incomplete', () => {
    expect(
      shouldCheckForNewGames({ ...baseInputs, onboardingCompletedAt: undefined }),
    ).toBe(false);
  });

  it('refuses when there is no prior import (the wizard handles first-time users)', () => {
    expect(
      shouldCheckForNewGames({ ...baseInputs, latestImportAt: undefined }),
    ).toBe(false);
  });

  it('refuses inside the post-import grace window', () => {
    expect(
      shouldCheckForNewGames({
        ...baseInputs,
        latestImportAt: NOW - (NEW_GAMES_GRACE_AFTER_IMPORT_MS - 1),
      }),
    ).toBe(false);
  });

  it('refuses when we already checked within the recheck window', () => {
    expect(
      shouldCheckForNewGames({
        ...baseInputs,
        lastCheckedAt: NOW - (NEW_GAMES_MIN_RECHECK_MS - 1),
      }),
    ).toBe(false);
  });

  it('passes once the recheck window elapses', () => {
    expect(
      shouldCheckForNewGames({
        ...baseInputs,
        lastCheckedAt: NOW - NEW_GAMES_MIN_RECHECK_MS - 1,
      }),
    ).toBe(true);
  });
});

describe('isDismissedForCount', () => {
  it('returns false when there is no dismissal record', () => {
    expect(isDismissedForCount(3, null, NOW)).toBe(false);
  });

  it('respects a dismissal at the same count within the TTL', () => {
    expect(
      isDismissedForCount(3, { dismissedCount: 3, dismissedAt: NOW - 1000 }, NOW),
    ).toBe(true);
  });

  it('re-prompts when the count grew since the dismissal', () => {
    expect(
      isDismissedForCount(5, { dismissedCount: 3, dismissedAt: NOW - 1000 }, NOW),
    ).toBe(false);
  });

  it('expires the dismissal after the TTL', () => {
    expect(
      isDismissedForCount(
        3,
        { dismissedCount: 3, dismissedAt: NOW - NEW_GAMES_MIN_RECHECK_MS - 1 },
        NOW,
      ),
    ).toBe(false);
  });

  it('treats dismissals at a higher count as still active for a lower one (the user said no to "5 new", so "3 new" stays dismissed)', () => {
    expect(
      isDismissedForCount(3, { dismissedCount: 5, dismissedAt: NOW - 1000 }, NOW),
    ).toBe(true);
  });
});

describe('isCacheEntryFresh', () => {
  function entry(over: Partial<NewGamesCacheEntry> = {}): NewGamesCacheEntry {
    return {
      username: 'magnus',
      discoveredAt: NOW - 60_000,
      count: 4,
      archiveUrls: [url(2026, 5)],
      ...over,
    };
  }

  it('returns false when there is no cached entry', () => {
    expect(isCacheEntryFresh(null, 'magnus', NOW)).toBe(false);
  });

  it('returns true for a fresh, same-username, non-empty entry', () => {
    expect(isCacheEntryFresh(entry(), 'magnus', NOW)).toBe(true);
  });

  it('lower-cases the username comparison', () => {
    expect(isCacheEntryFresh(entry(), 'MagnuS', NOW)).toBe(true);
  });

  it('treats a different username as a stale cache (no leak across accounts)', () => {
    expect(isCacheEntryFresh(entry({ username: 'hikaru' }), 'magnus', NOW)).toBe(false);
  });

  it('refuses entries with count <= 0 (the "all caught up" path should never restore a banner)', () => {
    expect(isCacheEntryFresh(entry({ count: 0 }), 'magnus', NOW)).toBe(false);
    expect(isCacheEntryFresh(entry({ count: -1 }), 'magnus', NOW)).toBe(false);
  });

  it('expires entries older than the TTL', () => {
    const stale = entry({ discoveredAt: NOW - NEW_GAMES_CACHE_TTL_MS - 1 });
    expect(isCacheEntryFresh(stale, 'magnus', NOW)).toBe(false);
  });

  it('returns true at exactly the TTL boundary', () => {
    const onTheEdge = entry({ discoveredAt: NOW - NEW_GAMES_CACHE_TTL_MS });
    expect(isCacheEntryFresh(onTheEdge, 'magnus', NOW)).toBe(true);
  });
});
