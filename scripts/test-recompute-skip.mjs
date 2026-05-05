// Verify the recompute version-skip fast path:
//   1. Empty DB → recompute does NOT stamp the version (so a later
//      import isn't skipped).
//   2. After a real recompute pass, the version IS stamped.
//   3. A subsequent boot with the same version short-circuits and
//      returns 0 (no work) without rewriting the row.
//
// Regression guard for the "lastRecomputeVersion locks in on empty DB"
// bug we hit while shipping the boot-time skip.

import { chromium } from 'playwright';
const URL = process.env.URL || 'http://localhost:5173/';

const browser = await chromium.launch({ headless: true });
const page = await (await browser.newContext()).newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('console', (m) => {
  if (m.text().includes('[queue]')) console.log(m.text());
});

await page.goto(URL, { waitUntil: 'networkidle' });

// Phase 1: clear DB, verify empty-boot does not stamp the version.
const phase1 = await page.evaluate(async () => {
  const { db } = await import('/src/db/schema.ts');
  const { recomputeClassificationsAndAccuracies, RECOMPUTE_VERSION } = await import(
    '/src/db/queries.ts'
  );
  await db.games.clear();
  await db.analyses.clear();
  await db.settings.delete('main');

  const updated = await recomputeClassificationsAndAccuracies();
  const s = await db.settings.get('main');
  return {
    updated,
    stamped: s?.lastRecomputeVersion === RECOMPUTE_VERSION,
    lastVersion: s?.lastRecomputeVersion ?? null,
    currentVersion: RECOMPUTE_VERSION,
  };
});
console.log('Phase 1 (empty DB):', phase1);
if (phase1.stamped) {
  console.error('FAIL: empty-DB recompute stamped the version; it should not');
  await browser.close();
  process.exit(1);
}

// Phase 2: insert a done game with a stale accuracy, run recompute,
// expect: row updated + version stamped.
const phase2 = await page.evaluate(async () => {
  const { db } = await import('/src/db/schema.ts');
  const { recomputeClassificationsAndAccuracies, RECOMPUTE_VERSION } = await import(
    '/src/db/queries.ts'
  );

  await db.games.put({
    id: 'rs-001',
    url: 'https://example.com/rs',
    source: 'chesscom',
    username: 'me',
    userColor: 'white',
    opponent: 'opp',
    result: 'loss',
    timeControl: '600',
    timeClass: 'rapid',
    endTime: Date.now(),
    opening: 'Test',
    eco: 'C00',
    pgn: '1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7# 1-0',
    importedAt: Date.now(),
    analysisStatus: 'done',
    accuracy: { white: 95.0, black: 95.0 },
  });
  await db.analyses.put({
    gameId: 'rs-001',
    depth: 16,
    analyzedAt: Date.now(),
    engine: 'stockfish-16',
    moves: [
      { ply: 1, san: 'e4', fenBefore: 'x', fenAfter: 'x', evalCpBefore: 20, evalCpAfter: 20,
        winrateBefore: 0.52, winrateAfter: 0.52, classification: 'best', depth: 16 },
      { ply: 2, san: 'Bluff', fenBefore: 'x', fenAfter: 'x', evalCpBefore: 50, evalCpAfter: -800,
        winrateBefore: 0.70, winrateAfter: 0.05, classification: 'blunder', depth: 16 },
    ],
  });

  const updated = await recomputeClassificationsAndAccuracies();
  const s = await db.settings.get('main');
  const g = await db.games.get('rs-001');
  return {
    updated,
    stamped: s?.lastRecomputeVersion === RECOMPUTE_VERSION,
    accuracy: g?.accuracy,
  };
});
console.log('Phase 2 (real work):', phase2);
if (phase2.updated < 1) {
  console.error('FAIL: phase 2 did not update any games');
  await browser.close();
  process.exit(1);
}
if (!phase2.stamped) {
  console.error('FAIL: phase 2 should have stamped the version');
  await browser.close();
  process.exit(1);
}

// Phase 3: re-run recompute, should short-circuit (returns 0) without
// touching the row.
const phase3 = await page.evaluate(async () => {
  const { db } = await import('/src/db/schema.ts');
  const { recomputeClassificationsAndAccuracies } = await import('/src/db/queries.ts');
  // Mutate the row's accuracy to a sentinel; if the skip works the
  // sentinel survives.
  await db.games.update('rs-001', { accuracy: { white: 1.0, black: 1.0 } });
  const updated = await recomputeClassificationsAndAccuracies();
  const g = await db.games.get('rs-001');
  return { updated, accuracy: g?.accuracy };
});
console.log('Phase 3 (skip):', phase3);
if (phase3.updated !== 0) {
  console.error('FAIL: phase 3 should have skipped (updated=0)');
  await browser.close();
  process.exit(1);
}
if (phase3.accuracy.white !== 1.0 || phase3.accuracy.black !== 1.0) {
  console.error('FAIL: phase 3 unexpectedly overwrote the sentinel accuracy');
  await browser.close();
  process.exit(1);
}

// Phase 4: force=true should bypass the skip.
const phase4 = await page.evaluate(async () => {
  const { recomputeClassificationsAndAccuracies } = await import('/src/db/queries.ts');
  return { updated: await recomputeClassificationsAndAccuracies({ force: true }) };
});
console.log('Phase 4 (force):', phase4);
if (phase4.updated < 1) {
  console.error('FAIL: phase 4 with force=true should have updated the row');
  await browser.close();
  process.exit(1);
}

await browser.close();
console.log('PASS: empty-boot does not stamp; real pass stamps; same-version boot skips; force bypasses');
