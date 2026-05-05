// Simulate the user's state: an existing game analyzed with the OLD accuracy
// formula, then verify the new boot-time recompute updates it to the new value.

import { chromium } from 'playwright';
const URL = process.env.URL || 'http://localhost:5174/';

const browser = await chromium.launch({ headless: true });
const page = await (await browser.newContext()).newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('console', (m) => {
  if (m.text().includes('[queue]')) console.log(`[${m.type()}]`, m.text());
});

await page.goto(URL, { waitUntil: 'networkidle' });

// Create a game + analysis with FAKE wrong accuracy to simulate old formula output.
const { before } = await page.evaluate(async () => {
  const { db } = await import('/src/db/schema.ts');
  const g = {
    id: 'recompute-001',
    url: 'https://example.com/recomp',
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
    accuracy: { white: 95.0, black: 95.0 }, // old formula result
    chessComAccuracy: { white: 40, black: 10 },
  };
  await db.games.put(g);
  // Synthesize per-move evals with obvious blunders to force a LOW new accuracy.
  const moves = [
    { ply: 1, san: 'e4', fenBefore: 'x', fenAfter: 'x', evalCpBefore: 20, evalCpAfter: 20,
      winrateBefore: 0.52, winrateAfter: 0.52, classification: 'best', depth: 16 },
    // Big blunder: from +0.5 to -8 (catastrophic)
    { ply: 2, san: 'Bluff', fenBefore: 'x', fenAfter: 'x', evalCpBefore: 50, evalCpAfter: -800,
      winrateBefore: 0.70, winrateAfter: 0.05, classification: 'blunder', depth: 16 },
    { ply: 3, san: 'reply', fenBefore: 'x', fenAfter: 'x', evalCpBefore: -800, evalCpAfter: -800,
      winrateBefore: 0.95, winrateAfter: 0.95, classification: 'best', depth: 16 },
    { ply: 4, san: 'Bluff2', fenBefore: 'x', fenAfter: 'x', evalCpBefore: -800, evalCpAfter: -1500,
      winrateBefore: 0.05, winrateAfter: 0.01, classification: 'mistake', depth: 16 },
  ];
  await db.analyses.put({
    gameId: 'recompute-001',
    depth: 16,
    analyzedAt: Date.now(),
    engine: 'stockfish-16',
    moves,
  });
  const g2 = await db.games.get('recompute-001');
  return { before: g2.accuracy };
});
console.log('Before reload, accuracy:', before);

await page.reload({ waitUntil: 'networkidle' });

// Give queue time to run recompute.
await new Promise((r) => setTimeout(r, 2000));

const after = await page.evaluate(async () => {
  const { db } = await import('/src/db/schema.ts');
  const g = await db.games.get('recompute-001');
  return g.accuracy;
});
console.log('After reload, accuracy:', after);

await browser.close();
const changed = before.white !== after.white || before.black !== after.black;
process.exit(changed ? 0 : 1);
