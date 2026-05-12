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

/* =======================================================================
 *  Compression at the backup boundary
 * =======================================================================
 *
 *  `dexie-export-import` produces a self-describing JSON blob that's
 *  ~80–90 % redundant text (FENs, repeated SAN tokens, JSON keys
 *  repeated thousands of times). Gzipping it at the boundary cuts
 *  on-disk / cloud-backup payload by 3–4× without touching anything
 *  in IndexedDB or any consumer of `Analysis.moves` at runtime — the
 *  cost lives entirely in two function calls (`exportBackup` /
 *  `restoreBackup`).
 *
 *  We use the native `CompressionStream` / `DecompressionStream` API
 *  (Web Streams). Available in:
 *    - Chrome 80+, Firefox 113+, Safari 16.4+, Edge 80+.
 *    - Node 18+ (used by unit tests).
 *  No npm dependency required.
 *
 *  Backwards compatibility: backups produced before this change were
 *  plain JSON. `restoreBackup` sniffs the first two bytes — if they
 *  match the gzip magic header (0x1f 0x8b), we decompress; otherwise
 *  we pass through unchanged. So a user on a brand-new install
 *  restoring an old `.json` backup still works.
 */

/** Gzip magic header. Every gzip stream starts with these two bytes
 *  (RFC 1952 §2.3.1). Safe to use as a content-type sniffer because
 *  `dexie-export-import`'s JSON output starts with `{"formatName":"…` —
 *  i.e. byte 0 is `0x7B`, not `0x1F`. There's no ambiguity. */
const GZIP_MAGIC_BYTE_0 = 0x1f;
const GZIP_MAGIC_BYTE_1 = 0x8b;

/** Detect whether a blob's first two bytes are the gzip magic header.
 *  Used by `restoreBackup` to keep working on legacy `.json` backups
 *  produced before this change. Exported for unit-testability. */
export async function isGzipBlob(blob: Blob): Promise<boolean> {
  if (blob.size < 2) return false;
  const head = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
  return head[0] === GZIP_MAGIC_BYTE_0 && head[1] === GZIP_MAGIC_BYTE_1;
}

/** Pipe a blob through a `CompressionStream`/`DecompressionStream`.
 *  The result is a new blob with the requested transformed bytes.
 *  We use `Response` to materialise the transformed stream because
 *  it gives us a `.blob()` for free — saves a manual chunk-collector. */
async function transformBlob(input: Blob, transform: 'gzip-encode' | 'gzip-decode'): Promise<Blob> {
  const stream =
    transform === 'gzip-encode'
      ? new CompressionStream('gzip')
      : new DecompressionStream('gzip');
  const piped = input.stream().pipeThrough(stream);
  return new Response(piped).blob();
}

/**
 * Export the entire database to a gzipped `Blob` of JSON (the
 * dexie-export-import format, run through `CompressionStream('gzip')`).
 * The returned blob is a complete, self-describing snapshot — it
 * includes the schema version, so restoring on a different machine
 * runs the same upgrade chain we run on app boot.
 *
 * Compression typically yields a 3–4× size reduction on real
 * libraries: `Analysis.moves` is the dominant cost in the export
 * (40–100 `MoveEval` rows per game, each with multiple FEN strings
 * and a UCI PV array), and it gzips extremely well because FENs and
 * UCI tokens repeat across moves and games. The CPU cost is in the
 * tens of milliseconds for typical libraries; users won't notice.
 *
 * Wire shape: `application/gzip`, header `0x1f 0x8b`. Restore is
 * sniff-on-input, so old `.json` backups still work.
 */
export async function exportBackup(): Promise<Blob> {
  const json = await db.export({ prettyJson: false, numRowsPerChunk: 1000 });
  return transformBlob(json, 'gzip-encode');
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
 *
 * Format-detection: the blob's first two bytes are inspected. Gzip
 * (`0x1f 0x8b`) is decompressed before being passed to the addon;
 * any other shape is assumed to be plain JSON and forwarded
 * unchanged. This keeps backups produced before compression shipped
 * fully restorable, and lets users hand-edit a JSON backup if they
 * really want to.
 */
export type RestoreMode = 'merge' | 'overwrite' | 'clear';

export async function restoreBackup(blob: Blob, mode: RestoreMode = 'merge'): Promise<void> {
  const json = (await isGzipBlob(blob)) ? await transformBlob(blob, 'gzip-decode') : blob;
  if (mode === 'clear') {
    await db.delete();
    await db.open();
    await db.import(json, { acceptVersionDiff: true });
    return;
  }
  await db.import(json, {
    acceptVersionDiff: true,
    overwriteValues: mode === 'overwrite',
  });
}

export function backupFilename(now: Date = new Date()): string {
  const pad = (n: number) => n.toString().padStart(2, '0');
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}`;
  return `chess-coach-backup-${stamp}.json.gz`;
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
