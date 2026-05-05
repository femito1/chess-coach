import 'dexie-export-import';
import { db } from './schema';

/**
 * Backup / restore for the local IndexedDB. Uses the official
 * `dexie-export-import` addon so the format stays compatible across
 * Dexie schema versions (the addon respects the current schema; restore
 * runs the upgrade path automatically). Same JSON blob shape will be the
 * payload for cloud backup in Phase 3 — no parallel format to maintain.
 */

export interface StorageInfo {
  /** Bytes currently used by this origin (across IndexedDB + caches). */
  usage: number;
  /** Best-guess quota the browser will allow before evicting. */
  quota: number;
  /** True if the origin has been granted "persistent storage" — i.e.
   *  the browser promises not to evict the data under pressure. */
  persistent: boolean;
  /** Whether the navigator.storage API is available at all. */
  supported: boolean;
}

export async function getStorageInfo(): Promise<StorageInfo> {
  if (typeof navigator === 'undefined' || !('storage' in navigator)) {
    return { usage: 0, quota: 0, persistent: false, supported: false };
  }
  const storage = navigator.storage;
  const estimate = (await storage.estimate?.()) ?? {};
  const persistent = (await storage.persisted?.()) ?? false;
  return {
    usage: estimate.usage ?? 0,
    quota: estimate.quota ?? 0,
    persistent,
    supported: true,
  };
}

/**
 * Ask the browser to mark this origin's storage as persistent, so the
 * data can't be silently evicted under storage pressure. Idempotent;
 * returns the resulting persistent state.
 *
 * In Chrome/Edge this often auto-grants once the site is "engaged with"
 * (PWA-installed, bookmarked, frequently visited). In Firefox it pops a
 * permission prompt. In Safari the API exists but the browser may
 * auto-deny — the page should still work, it just has slightly weaker
 * durability guarantees.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  if (typeof navigator === 'undefined' || !('storage' in navigator)) return false;
  const storage = navigator.storage;
  if (!storage.persist) return (await storage.persisted?.()) ?? false;
  return storage.persist();
}

/**
 * Export the entire database to a `Blob` of JSON (the dexie-export-import
 * format). The returned blob is a complete, self-describing snapshot —
 * it includes the schema version, so restoring on a different machine
 * runs the same upgrade chain we run on app boot.
 */
export async function exportBackup(): Promise<Blob> {
  const blob = await db.export({ prettyJson: false, numRowsPerChunk: 1000 });
  return blob;
}

/**
 * Restore from a backup blob created by `exportBackup`. Three modes:
 *   - "merge" (default): existing rows with the same primary key are
 *     kept, only new rows from the backup are inserted. Safe if the
 *     local DB already has data.
 *   - "overwrite": existing rows are replaced when keys collide. Local
 *     rows not present in the backup remain untouched.
 *   - "clear": wipe every table first, then import. Use this when
 *     restoring onto a fresh browser profile.
 *
 * Backup files produced by an older schema version are upgraded
 * automatically; the addon writes the rows through the live Dexie
 * instance so all version-block upgraders run as expected.
 */
export type RestoreMode = 'merge' | 'overwrite' | 'clear';

export async function restoreBackup(blob: Blob, mode: RestoreMode = 'merge'): Promise<void> {
  if (mode === 'clear') {
    await db.delete();
    await db.open();
    await db.import(blob, { acceptVersionDiff: true });
    return;
  }
  await db.import(blob, {
    acceptVersionDiff: true,
    overwriteValues: mode === 'overwrite',
  });
}

export function backupFilename(now: Date = new Date()): string {
  const pad = (n: number) => n.toString().padStart(2, '0');
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}`;
  return `chess-coach-backup-${stamp}.json`;
}

export function formatBytes(n: number): string {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}
