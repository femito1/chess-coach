import type { DismissalState, NewGamesCacheEntry } from './newGames';

export const STORAGE_CACHE_KEY = 'chess-coach:new-games-cache:v1';
export const STORAGE_DISMISSED_KEY = 'chess-coach:new-games-dismissed:v1';
export const STORAGE_LAST_CHECKED_KEY = 'chess-coach:new-games-last-checked:v1';
export const NEW_GAMES_RECONCILE_EVENT = 'chess-coach:new-games-reconcile';

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function readNumber(key: string): number | null {
  try {
    const raw = storage()?.getItem(key);
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export function persistNumber(key: string, value: number): void {
  try {
    storage()?.setItem(key, String(value));
  } catch {
    // Storage can be unavailable in private browsing.
  }
}

export function readCacheEntry(): NewGamesCacheEntry | null {
  try {
    const raw = storage()?.getItem(STORAGE_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as NewGamesCacheEntry;
    if (
      typeof parsed?.username === 'string' &&
      typeof parsed?.discoveredAt === 'number' &&
      typeof parsed?.count === 'number' &&
      Array.isArray(parsed?.archiveUrls)
    ) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

export function persistCacheEntry(entry: NewGamesCacheEntry): void {
  try {
    storage()?.setItem(STORAGE_CACHE_KEY, JSON.stringify(entry));
  } catch {
    // Storage can be unavailable in private browsing.
  }
}

export function clearCacheEntry(): void {
  try {
    storage()?.removeItem(STORAGE_CACHE_KEY);
  } catch {
    // Storage can be unavailable in private browsing.
  }
}

export function readDismissal(): DismissalState | null {
  try {
    const raw = storage()?.getItem(STORAGE_DISMISSED_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as DismissalState;
    if (
      typeof parsed?.dismissedCount === 'number' &&
      typeof parsed?.dismissedAt === 'number'
    ) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

export function persistDismissal(count: number, at: number): void {
  try {
    const value: DismissalState = { dismissedCount: count, dismissedAt: at };
    storage()?.setItem(STORAGE_DISMISSED_KEY, JSON.stringify(value));
  } catch {
    // Storage can be unavailable in private browsing.
  }
}

export function clearDismissal(): void {
  try {
    storage()?.removeItem(STORAGE_DISMISSED_KEY);
  } catch {
    // Storage can be unavailable in private browsing.
  }
}

export function clearLastChecked(): void {
  try {
    storage()?.removeItem(STORAGE_LAST_CHECKED_KEY);
  } catch {
    // Storage can be unavailable in private browsing.
  }
}

/**
 * A selected-game import changes the exact set of missing IDs but does not
 * make the user fully caught up. Drop stale discovery state and ask the
 * mounted banner to reconcile against IndexedDB immediately.
 */
export function requestNewGamesReconciliation(): void {
  clearCacheEntry();
  clearDismissal();
  clearLastChecked();
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(NEW_GAMES_RECONCILE_EVENT));
  }
}
