// Smoke test for Phase 1 user-data persistence work:
//   - Backup / restore round-trip via dexie-export-import
//   - ImportRecord upsert + dedup on (username, archiveUrl)
//   - Storage info reads (navigator.storage.estimate / persisted)

import { runBrowserTest, expect, sleep } from '../harness.mjs';

await runBrowserTest({
  name: 'backup',
  async run({ page }) {
    // Give Dexie + boot pipeline a moment so the test isn't racing with
    // any first-load housekeeping.
    await sleep(1500);

    // 1. Storage info reads cleanly.
    const storage = await page.evaluate(async () => {
      const m = await import('/src/db/backup.ts');
      return m.getStorageInfo();
    });
    expect(typeof storage.usage === 'number', 'storage.usage is a number').toBeTruthy();
    expect(typeof storage.quota === 'number', 'storage.quota is a number').toBeTruthy();
    expect(typeof storage.persistent === 'boolean', 'storage.persistent is a boolean').toBeTruthy();
    expect(storage.supported, 'storage.supported is true in chromium').toBe(true);

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
    expect(importRecResult.count, 'two distinct import records (no duplicate)').toBe(2);
    expect(importRecResult.countLower, 'username lookup is case-insensitive').toBe(2);
    expect(importRecResult.secondAdded, 'second record stored correctly').toBe(30);
    expect(
      importRecResult.firstAddedAfterSecondPut,
      'second put on same archive overwrites (added=0 from re-pull)',
    ).toBe(0);

    // 3. Export → restore round-trip preserves the records we just wrote.
    //
    // Use 'overwrite' mode rather than 'merge': in real usage the test DB
    // has rows from earlier integration tests (e.g. games inserted by
    // recompute-skip / phase2). 'merge' translates to dexie-export-import's
    // overwriteValues=false, which throws BulkError on any primary-key
    // collision — fine on a clean DB, broken in the test runner where the
    // backup test runs after others. 'overwrite' replaces colliding rows
    // and lets new ones land, which is what we actually want to assert
    // here ("backup → restore is lossless").
    const roundTrip = await page.evaluate(async () => {
      const { db } = await import('/src/db/schema.ts');
      const m = await import('/src/db/backup.ts');
      const before = await db.importRecords.count();
      const blob = await m.exportBackup();
      // Wipe importRecords only (don't blow up the rest of the DB the
      // dev server may have populated).
      await db.importRecords.clear();
      const cleared = await db.importRecords.count();
      await m.restoreBackup(blob, 'overwrite');
      const after = await db.importRecords.count();
      return { before, cleared, after, blobSize: blob.size };
    });
    expect(roundTrip.before, 'pre-export count matches').toBe(2);
    expect(roundTrip.cleared, 'records cleared between export and restore').toBe(0);
    expect(roundTrip.after, 'merge restore re-populates cleared records').toBe(2);
    expect(roundTrip.blobSize, 'export produced a non-empty blob').toBeGreaterThan(0);

    // 4. Settings persists username (the foundational "track user" assumption).
    const settings = await page.evaluate(async () => {
  const { db, updateSettings, getSettings } = await import('/src/db/schema.ts');
  await updateSettings({ username: 'phase1-smoketest' });
  const s = await getSettings();
  // Read back via raw db too to make sure it actually hit IndexedDB.
  const raw = await db.settings.get('main');
  return { fromGetter: s.username, raw: raw?.username };
});
    expect(settings.fromGetter, 'getSettings returns updated username').toBe('phase1-smoketest');
    expect(settings.raw, 'username persisted to IndexedDB row').toBe('phase1-smoketest');

    console.log('All Phase 1 backup/import-record/storage assertions passed.');
  },
});
