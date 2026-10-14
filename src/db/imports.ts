import { db, type ImportRecord } from './schema';

/**
 * Per-archive import metadata. Read by the Import page to show "already
 * imported / X games / Y days ago" badges and to power a one-click
 * "Sync newest" that pulls every archive newer than what's on file for
 * the current username.
 */

/**
 * Grace after a month ends before an import of it can count as complete.
 * Chess.com's public API caches archives, so an import moments after
 * midnight UTC can still miss that month's last games; re-offering the
 * month once more costs nothing (`upsertGames` dedups).
 */
const ARCHIVE_SETTLE_MS = 24 * 60 * 60 * 1000;

/**
 * True when `rec` holds every game its archive month will ever have —
 * i.e. it was taken after the month ended. An import of the current
 * month, or one taken while a past month was still in progress, is a
 * snapshot of a month that kept growing, so "Sync newest" must still
 * offer it; treating any record as done meant the month you are playing
 * in was never re-synced. Archive months are UTC, matching Chess.com.
 */
export function isImportComplete(
  rec: Pick<ImportRecord, 'year' | 'month' | 'importedAt'> | undefined,
): boolean {
  if (!rec) return false;
  // `Date.UTC` month is 0-based, so passing the 1-based month is the
  // first instant of the following month.
  const monthEnd = Date.UTC(rec.year, rec.month, 1);
  return rec.importedAt >= monthEnd + ARCHIVE_SETTLE_MS;
}

export function importRecordId(
  source: ImportRecord['source'],
  username: string,
  archiveUrl: string,
): string {
  return `${source}:${username.toLowerCase()}:${archiveUrl}`;
}

export async function recordImport(opts: {
  source: ImportRecord['source'];
  username: string;
  archiveUrl: string;
  year: number;
  month: number;
  gameCount: number;
  added: number;
  skipped: number;
}): Promise<void> {
  const rec: ImportRecord = {
    id: importRecordId(opts.source, opts.username, opts.archiveUrl),
    source: opts.source,
    username: opts.username.toLowerCase(),
    archiveUrl: opts.archiveUrl,
    year: opts.year,
    month: opts.month,
    importedAt: Date.now(),
    gameCount: opts.gameCount,
    added: opts.added,
    skipped: opts.skipped,
  };
  await db.importRecords.put(rec);
}

export async function listImportRecordsFor(
  source: ImportRecord['source'],
  username: string,
): Promise<ImportRecord[]> {
  const u = username.toLowerCase();
  return db.importRecords.where('username').equals(u).and((r) => r.source === source).toArray();
}

export async function getImportRecord(
  source: ImportRecord['source'],
  username: string,
  archiveUrl: string,
): Promise<ImportRecord | undefined> {
  return db.importRecords.get(importRecordId(source, username, archiveUrl));
}
