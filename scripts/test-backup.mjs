// Smoke test for Phase 1 user-data persistence work:
//   - Backup / restore round-trip via dexie-export-import
//   - ImportRecord upsert + dedup on (username, archiveUrl)
//   - Storage info reads (navigator.storage.estimate / persisted)
//
// Run with the dev server up (default http://localhost:5173/):
//   node scripts/test-backup.mjs
//
// Exits non-zero on any assertion failure.

import { chromium } from 'playwright';

const URL = process.env.URL || 'http://localhost:5173/';

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`ok: ${msg}`);
}

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext();
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

await page.goto(URL, { waitUntil: 'networkidle' });
// Give Dexie + boot pipeline a moment.
await new Promise((r) => setTimeout(r, 1500));

// 1. Storage info reads cleanly.
const storage = await page.evaluate(async () => {
  const m = await import('/src/db/backup.ts');
  return m.getStorageInfo();
});
assert(typeof storage.usage === 'number', 'storage.usage is a number');
assert(typeof storage.quota === 'number', 'storage.quota is a number');
assert(typeof storage.persistent === 'boolean', 'storage.persistent is a boolean');
assert(storage.supported === true, 'storage.supported is true in chromium');

// 2. ImportRecord upsert + listing.
const importRecResult = await page.evaluate(async () => {
  const { db } = await import('/src/db/schema.ts');
  const { recordImport, listImportRecordsFor, getImportRecord } = await import(
    '/src/db/imports.ts'
  );
  await db.importRecords.clear();
  await recordImport({
    source: 'chesscom',
    username: 'TestUser',
    archiveUrl: 'https://api.chess.com/pub/player/testuser/games/2024/01',
    year: 2024,
    month: 1,
    gameCount: 50,
    added: 50,
    skipped: 0,
  });
  // Same archive — should overwrite, not duplicate.
  await recordImport({
    source: 'chesscom',
    username: 'TestUser',
    archiveUrl: 'https://api.chess.com/pub/player/testuser/games/2024/01',
    year: 2024,
    month: 1,
    gameCount: 50,
    added: 0,
    skipped: 50,
  });
  await recordImport({
    source: 'chesscom',
    username: 'TestUser',
    archiveUrl: 'https://api.chess.com/pub/player/testuser/games/2024/02',
    year: 2024,
    month: 2,
    gameCount: 30,
    added: 30,
    skipped: 0,
  });
  const list = await listImportRecordsFor('chesscom', 'TestUser');
  // Username is case-insensitive (we lowercase on insert + read).
  const listLower = await listImportRecordsFor('chesscom', 'testuser');
  const second = await getImportRecord(
    'chesscom',
    'TESTUSER',
    'https://api.chess.com/pub/player/testuser/games/2024/02',
  );
  return {
    count: list.length,
    countLower: listLower.length,
    secondAdded: second?.added,
    firstAddedAfterSecondPut: list.find(
      (r) => r.archiveUrl === 'https://api.chess.com/pub/player/testuser/games/2024/01',
    )?.added,
  };
});
assert(importRecResult.count === 2, 'two distinct import records (no duplicate)');
assert(importRecResult.countLower === 2, 'username lookup is case-insensitive');
assert(importRecResult.secondAdded === 30, 'second record stored correctly');
assert(
  importRecResult.firstAddedAfterSecondPut === 0,
  'second put on same archive overwrites (added=0 from re-pull)',
);

// 3. Export → restore round-trip preserves the records we just wrote.
const roundTrip = await page.evaluate(async () => {
  const { db } = await import('/src/db/schema.ts');
  const m = await import('/src/db/backup.ts');
  const before = await db.importRecords.count();
  const blob = await m.exportBackup();
  // Wipe importRecords only (don't blow up the rest of the DB the dev
  // server may have populated).
  await db.importRecords.clear();
  const cleared = await db.importRecords.count();
  // Use 'merge' restore so we don't touch the rest of the DB.
  await m.restoreBackup(blob, 'merge');
  const after = await db.importRecords.count();
  return { before, cleared, after, blobSize: blob.size };
});
assert(roundTrip.before === 2, 'pre-export count matches');
assert(roundTrip.cleared === 0, 'records cleared between export and restore');
assert(roundTrip.after === 2, 'merge restore re-populates cleared records');
assert(roundTrip.blobSize > 0, 'export produced a non-empty blob');

// 4. Settings persists username (the foundational "track user" assumption).
const settings = await page.evaluate(async () => {
  const { db, updateSettings, getSettings } = await import('/src/db/schema.ts');
  await updateSettings({ username: 'phase1-smoketest' });
  const s = await getSettings();
  // Read back via raw db too to make sure it actually hit IndexedDB.
  const raw = await db.settings.get('main');
  return { fromGetter: s.username, raw: raw?.username };
});
assert(settings.fromGetter === 'phase1-smoketest', 'getSettings returns updated username');
assert(settings.raw === 'phase1-smoketest', 'username persisted to IndexedDB row');

console.log('\nAll Phase 1 backup/import-record/storage assertions passed.');
await browser.close();
