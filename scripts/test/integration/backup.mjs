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
    //
    // Also asserts the new compression contract: the blob `exportBackup`
    // produces is gzipped (first two bytes are the gzip magic header
    // 0x1f 0x8b) and `restoreBackup` decompresses it transparently.
    const roundTrip = await page.evaluate(async () => {
      const { db } = await import('/src/db/schema.ts');
      const m = await import('/src/db/backup.ts');
      const before = await db.importRecords.count();
      const blob = await m.exportBackup();
      const head = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
      const isGzip = await m.isGzipBlob(blob);
      // Wipe importRecords only (don't blow up the rest of the DB the
      // dev server may have populated).
      await db.importRecords.clear();
      const cleared = await db.importRecords.count();
      await m.restoreBackup(blob, 'overwrite');
      const after = await db.importRecords.count();
      return {
        before,
        cleared,
        after,
        blobSize: blob.size,
        magic0: head[0],
        magic1: head[1],
        isGzip,
      };
    });
    expect(roundTrip.before, 'pre-export count matches').toBe(2);
    expect(roundTrip.cleared, 'records cleared between export and restore').toBe(0);
    expect(roundTrip.after, 'merge restore re-populates cleared records').toBe(2);
    expect(roundTrip.blobSize, 'export produced a non-empty blob').toBeGreaterThan(0);
    expect(roundTrip.magic0, 'export blob first byte is gzip magic 0x1f').toBe(0x1f);
    expect(roundTrip.magic1, 'export blob second byte is gzip magic 0x8b').toBe(0x8b);
    expect(roundTrip.isGzip, 'isGzipBlob recognises the export').toBe(true);

    // 3b. Backwards compatibility: a legacy plain-JSON backup (the
    // pre-compression format) must still restore. We synthesize one
    // by calling dexie-export-import directly so the test doesn't
    // depend on a literal pre-compression `exportBackup` ever being
    // re-introduced. `restoreBackup` should sniff the leading bytes,
    // see that it's NOT gzipped, and pass the blob through unchanged
    // to `db.import`.
    const legacy = await page.evaluate(async () => {
      const { db } = await import('/src/db/schema.ts');
      const m = await import('/src/db/backup.ts');
      // Snapshot the raw, un-gzipped JSON blob the way pre-compression
      // exports looked.
      const raw = await db.export({ prettyJson: false, numRowsPerChunk: 1000 });
      const head = new Uint8Array(await raw.slice(0, 2).arrayBuffer());
      const looksGzipped = await m.isGzipBlob(raw);
      await db.importRecords.clear();
      const cleared = await db.importRecords.count();
      // Same call site users hit when they pick a `.json` file from
      // their old backup folder.
      await m.restoreBackup(raw, 'overwrite');
      const restored = await db.importRecords.count();
      return {
        rawSize: raw.size,
        head0: head[0],
        head1: head[1],
        looksGzipped,
        cleared,
        restored,
      };
    });
    expect(legacy.rawSize, 'legacy plain-JSON export is non-empty').toBeGreaterThan(0);
    expect(legacy.head0, 'legacy export starts with `{` not gzip magic').toBe(0x7b); // '{'
    expect(legacy.looksGzipped, 'isGzipBlob returns false on plain JSON').toBe(false);
    expect(legacy.cleared, 'records cleared before legacy restore').toBe(0);
    expect(legacy.restored, 'legacy plain-JSON restore re-populates the table').toBe(2);

    // 3c. Bonus assertion: gzipped export is meaningfully smaller
    // than the equivalent plain JSON. The whole point of compression
    // is "use less bytes for the cloud-backup payload"; this catches a
    // future regression where someone wires the export to skip the
    // compression step. We use a soft floor (gzipped < plain) rather
    // than a strict ratio because tiny test DBs compress less
    // dramatically than real libraries.
    const sizes = await page.evaluate(async () => {
      const { db } = await import('/src/db/schema.ts');
      const m = await import('/src/db/backup.ts');
      const plain = await db.export({ prettyJson: false, numRowsPerChunk: 1000 });
      const compressed = await m.exportBackup();
      return { plain: plain.size, compressed: compressed.size };
    });
    expect(
      sizes.compressed,
      `gzipped export (${sizes.compressed} B) is smaller than plain JSON (${sizes.plain} B)`,
    ).toBeLessThan(sizes.plain);

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
