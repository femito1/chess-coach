/**
 * Browser storage durability.
 *
 * This app's whole premise is that games, analyses and progress live in
 * IndexedDB on the device. By default that storage is **best-effort**: the
 * browser is free to evict the entire origin under disk pressure, and some
 * browsers evict on an inactivity timer as well. `navigator.storage.persist()`
 * is the only way to ask for a stronger promise, and until this module existed
 * the app never asked — so the durability claim rested on luck.
 *
 * What asking does and does not buy:
 *
 * - Firefox prompts the user, so the answer can be a real "no".
 * - Chrome decides silently from engagement signals (installed as an app,
 *   bookmarked, visited often) and commonly returns `false` with no prompt.
 * - **Nothing here can survive the user's own browser settings.** "Clear
 *   cookies and site data when you close all windows", or a manual clear,
 *   takes the data whatever the grant says. That is why the state is surfaced
 *   in Settings rather than only requested: a `best-effort` readout is the
 *   honest answer to "why did my library vanish", and cloud sync is the
 *   mitigation.
 */

export type StorageDurability =
  /** No Storage API — nothing to ask, nothing to promise. */
  | { kind: 'unsupported' }
  /** The browser has promised to keep this origin's data. */
  | { kind: 'persisted' }
  /** Eligible for eviction. `asked` distinguishes "we requested and were
   *  refused" from "we never got as far as asking". */
  | { kind: 'best-effort'; asked: boolean }
  | { kind: 'error'; message: string };

export interface StorageUsage {
  /** Bytes currently used by this origin. */
  usage: number;
  /** Bytes the browser is willing to give it. */
  quota: number;
}

/** The slice of `StorageManager` this module uses. Named so tests can supply
 *  a fake without a DOM. */
export interface DurabilityApi {
  persisted(): Promise<boolean>;
  persist(): Promise<boolean>;
}

/**
 * Ask for durable storage, unless the browser has already granted it.
 *
 * Checking `persisted()` first matters: `persist()` can re-prompt in browsers
 * that prompt, and there is no reason to ask a question already answered yes.
 *
 * Pure with respect to its argument, so the decision table is unit-testable.
 */
export async function requestDurability(
  api: DurabilityApi | undefined,
): Promise<StorageDurability> {
  if (!api || typeof api.persist !== 'function' || typeof api.persisted !== 'function') {
    return { kind: 'unsupported' };
  }
  try {
    if (await api.persisted()) return { kind: 'persisted' };
    const granted = await api.persist();
    return granted ? { kind: 'persisted' } : { kind: 'best-effort', asked: true };
  } catch (err) {
    // Some contexts throw rather than resolve false (private windows, embedded
    // frames, browsers with site data blocked). Report it; never let a
    // storage question break boot.
    return { kind: 'error', message: err instanceof Error ? err.message : String(err) };
  }
}

function durabilityApi(): DurabilityApi | undefined {
  if (typeof navigator === 'undefined') return undefined;
  const storage = navigator.storage as DurabilityApi | undefined;
  return storage;
}

let pending: Promise<StorageDurability> | null = null;

/**
 * Request durable storage once per page load, memoised so the boot call and
 * the Settings readout share one answer (and one prompt, where a browser
 * prompts).
 */
export function ensureDurableStorage(): Promise<StorageDurability> {
  pending ??= requestDurability(durabilityApi());
  return pending;
}

/** Bytes used / available, or null where the browser won't say. */
export async function readStorageUsage(): Promise<StorageUsage | null> {
  if (typeof navigator === 'undefined') return null;
  const estimate = navigator.storage?.estimate;
  if (typeof estimate !== 'function') return null;
  try {
    const { usage, quota } = await navigator.storage.estimate();
    if (typeof usage !== 'number' || typeof quota !== 'number') return null;
    return { usage, quota };
  } catch {
    return null;
  }
}

/** Test seam: forget the memoised request. */
export function resetDurabilityCacheForTests(): void {
  pending = null;
}
