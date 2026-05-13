import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * `useState` that persists to `localStorage` under a stable key.
 *
 * Use for **UI preferences** the user expects to survive a reload but
 * doesn't need to follow them across devices: chart filter selections,
 * collapsed/expanded panel state, "show advanced" toggles, etc.
 *
 * Do NOT use for chess data, settings that should sync across devices
 * (those go through `Settings` in `src/db/schema.ts`), or anything that
 * would silently leak across logged-in users on a shared device.
 *
 * Design notes:
 *   - The shape is `[value, setValue]` exactly like `useState`. Drop-in.
 *   - The initial value is read **synchronously on first render** from
 *     `localStorage` so the user never sees a flash of the default
 *     before the persisted value loads (which would happen with a
 *     useEffect-based hydration).
 *   - Writes are debounced to the next microtask so a burst of state
 *     updates inside a single React commit only writes once. Important
 *     when a parent re-renders multiple persisted children together.
 *   - We catch and swallow `localStorage` errors. Quota-exceeded /
 *     private-browsing modes / disabled storage all degrade to "no
 *     persistence" rather than crashing the page.
 *   - Pure read/write logic is exported separately (`readPersistedValue`,
 *     `writePersistedValue`) so the unit-test layer (which can't render
 *     React) can pin the storage contract directly. The hook is the
 *     React glue around those primitives.
 *
 * Versioning: change the `version` argument when the persisted value's
 * shape changes incompatibly. Stale rows under the old version are
 * silently discarded. Mirror the `Settings.lastRecomputeVersion`
 * pattern.
 */
export function usePersistedState<T>(
  key: string,
  defaultValue: T,
  options: PersistedStateOptions<T> = {},
): [T, (next: T | ((prev: T) => T)) => void] {
  const storageKey = persistedStorageKey(key, options.version ?? 1);

  const [value, setValue] = useState<T>(() =>
    readPersistedValue(storageKey, defaultValue, options.isValid),
  );

  const pendingWriteRef = useRef<{ value: T; scheduled: boolean }>({
    value,
    scheduled: false,
  });

  useEffect(() => {
    pendingWriteRef.current.value = value;
    if (pendingWriteRef.current.scheduled) return;
    pendingWriteRef.current.scheduled = true;
    queueMicrotask(() => {
      pendingWriteRef.current.scheduled = false;
      writePersistedValue(storageKey, pendingWriteRef.current.value);
    });
  }, [storageKey, value]);

  const set = useCallback(
    (next: T | ((prev: T) => T)) => setValue((prev) => resolveNext(next, prev)),
    [],
  );

  return [value, set];
}

export interface PersistedStateOptions<T> {
  /** Bumped on incompatible shape changes; 1 by default. */
  version?: number;
  /** Predicate that rejects malformed persisted values (e.g. an
   *  enum that lost a variant). Returning false drops the persisted
   *  value and falls back to the default. */
  isValid?: (raw: unknown) => raw is T;
}

/* ------------------------- pure helpers (testable) ------------------- */

/** Compose the namespaced storage key. Exported so the unit test can
 *  pin the format and a future migration script can target old keys. */
export function persistedStorageKey(key: string, version: number): string {
  return `chess-coach:${key}:v${version}`;
}

/** Pure resolver for `useState`'s functional-vs-value setter form. */
export function resolveNext<T>(next: T | ((prev: T) => T), prev: T): T {
  return typeof next === 'function' ? (next as (p: T) => T)(prev) : next;
}

/** Read + parse + validate a persisted value. Returns `defaultValue`
 *  for any failure (missing key, malformed JSON, validator rejection,
 *  storage unavailable). Pure modulo the optional `storage` arg. */
export function readPersistedValue<T>(
  storageKey: string,
  defaultValue: T,
  isValid?: (raw: unknown) => raw is T,
  storage: Pick<Storage, 'getItem'> | null = resolveStorage(),
): T {
  if (!storage) return defaultValue;
  try {
    const raw = storage.getItem(storageKey);
    if (raw === null) return defaultValue;
    const parsed = JSON.parse(raw) as unknown;
    if (isValid && !isValid(parsed)) return defaultValue;
    return parsed as T;
  } catch {
    return defaultValue;
  }
}

/** Stringify + write a persisted value. Returns true on success, false
 *  on any failure (quota, disabled storage, JSON.stringify cycle).
 *  Pure modulo the optional `storage` arg. */
export function writePersistedValue<T>(
  storageKey: string,
  value: T,
  storage: Pick<Storage, 'setItem'> | null = resolveStorage(),
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(storageKey, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function resolveStorage(): Storage | null {
  if (typeof window === 'undefined' || typeof localStorage === 'undefined') {
    return null;
  }
  return localStorage;
}
