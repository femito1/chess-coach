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

/**
 * How close this origin is to being unable to write.
 *
 * Why headroom and not the durability grant: Chromium derives an origin's quota
 * from *free disk space*, and keeps two floors on that free space — it evicts
 * storage buckets below min(1 GiB, 10% of the disk) and refuses writes outright
 * below min(2 GiB, 1%). A granted `persist()` exempts an origin from quota
 * eviction; it does **not** exempt it from those floors. Measured on the machine
 * this app is developed on: a disk at 13.9 MB free wiped six origins including
 * this one, and a site that had `durable_storage: 1` granted still lost its
 * IndexedDB session.
 *
 * So a collapsing `quota` is the one app-visible fingerprint of the failure that
 * actually loses data, and it is worth saying out loud. The alternative is what
 * happened: two days of "why does this app keep forgetting everything", with
 * every layer reporting healthy — ext4 reserves 5% for root, and `df`'s Avail
 * already excludes it, so the machine looks fine while every unprivileged writer
 * starves.
 *
 * Deliberately framed as headroom rather than an absolute quota figure, because
 * a small quota on a small device is normal while a small *remaining* quota
 * means writes are about to fail whatever the device.
 */
export type StoragePressure =
  | { kind: 'unknown' }
  | { kind: 'ok'; remaining: number }
  /** Close enough that eviction or a failed write is plausible soon. */
  | { kind: 'low'; remaining: number }
  /** Writes may already be failing. */
  | { kind: 'critical'; remaining: number };

/** Below this much headroom, writes may already be failing. */
export const CRITICAL_REMAINING_BYTES = 50_000_000;
/** Below this much headroom, warn. ~250 MB is several thousand analyses — see
 *  SETUP_AUTH.md's ~30 KB-per-analysis figure — so this is "you will notice
 *  soon", not "cutting it fine". */
export const LOW_REMAINING_BYTES = 250_000_000;

export function assessStoragePressure(usage: StorageUsage | null): StoragePressure {
  if (!usage) return { kind: 'unknown' };
  const { usage: used, quota } = usage;
  // A zero/absent quota is not "infinite room" — it is the browser declining to
  // promise any, which is exactly the nearly-full-disk case.
  if (!Number.isFinite(quota) || !Number.isFinite(used)) return { kind: 'unknown' };
  const remaining = Math.max(0, quota - used);
  if (remaining < CRITICAL_REMAINING_BYTES) return { kind: 'critical', remaining };
  if (remaining < LOW_REMAINING_BYTES) return { kind: 'low', remaining };
  return { kind: 'ok', remaining };
}
