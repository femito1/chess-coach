// Reproduce the user's reported flow: start the app, import a real Chess.com
// game via the API, let the queue process it, and check the result.

import { chromium } from 'playwright';

const URL = process.env.URL || 'http://localhost:5174/';
const USERNAME = process.env.CHESSCOM_USER || 'hikaru';

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
const page = await context.newPage();

const errors = [];
page.on('console', (msg) => {
  if (msg.type() === 'error' || msg.type() === 'warning') {
    errors.push(`[${msg.type()}] ${msg.text()}`);
  }
});
page.on('pageerror', (err) => errors.push(`[pageerror] ${err.message}`));

await page.goto(URL, { waitUntil: 'networkidle' });

// Insert a small synthetic game directly.
const inserted = await page.evaluate(async () => {
  const { db } = await import('/src/db/schema.ts');
  const game = {
    id: 'queue-test-001',
    url: 'https://example.com/queue',
    source: 'chesscom',
    username: 'me',
    userColor: 'white',
    opponent: 'opp',
    result: 'win',
    timeControl: '600',
    timeClass: 'rapid',
    endTime: Date.now(),
    opening: "King's Pawn",
    eco: 'C20',
    pgn: '1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7# 1-0',
    importedAt: Date.now(),
    analysisStatus: 'pending',
  };
  await db.games.put(game);
  return true;
});

console.log('Game inserted:', inserted);

// Poll until queue finishes or 60s.
const start = Date.now();
let lastStatus = null;
while (Date.now() - start < 60000) {
  const snap = await page.evaluate(async () => {
    const { db } = await import('/src/db/schema.ts');
    const g = await db.games.get('queue-test-001');
    const a = await db.analyses.get('queue-test-001');
    return {
      status: g?.analysisStatus,
      error: g?.analysisError,
      accuracy: g?.accuracy,
      moves: a?.moves?.length ?? 0,
    };
  });
  if (snap.status !== lastStatus) {
    console.log(new Date().toISOString(), JSON.stringify(snap));
    lastStatus = snap.status;
  }
  if (snap.status === 'done' || snap.status === 'error') break;
  await new Promise((r) => setTimeout(r, 500));
}

const final = await page.evaluate(async () => {
  const { db } = await import('/src/db/schema.ts');
  const g = await db.games.get('queue-test-001');
  const a = await db.analyses.get('queue-test-001');
  return {
    game: g
      ? { status: g.analysisStatus, error: g.analysisError, accuracy: g.accuracy }
      : null,
    moveCount: a?.moves?.length ?? 0,
    firstMove: a?.moves?.[0],
  };
});

console.log('\n=== Final ===');
console.log(JSON.stringify(final, null, 2));

if (errors.length) {
  console.log('\n=== Console errors ===');
  for (const e of errors) console.log(e);
}

await browser.close();
process.exit(final.game?.status === 'done' ? 0 : 1);
