import { db, type ImportRecord } from './schema';

/**
 * Per-archive import metadata. Read by the Import page to show "already
 * imported / X games / Y days ago" badges and to power a one-click
 * "Sync newest" that pulls every archive newer than what's on file for
 * the current username.
 */

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
