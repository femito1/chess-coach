// Open a real analyzed game in the ReviewPage, verify:
//   - board renders with classification badge
//   - clicking pieces to play a move branches into exploration
//   - live eval appears in exploration
//   - "Return to game" button restores mainline

import { chromium } from 'playwright';

const URL = process.env.URL || 'http://localhost:5174/';

const browser = await chromium.launch({ headless: true });
const page = await (await browser.newContext()).newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('console', (m) => {
  if (m.type() === 'error') console.log('[console.error]', m.text());
});

await page.goto(URL, { waitUntil: 'networkidle' });

// Import a small game and wait for analysis.
const id = await page.evaluate(async () => {
  const { db } = await import('/src/db/schema.ts');
  const g = {
    id: 'ui-test-001',
    url: 'https://example.com/ui',
    source: 'chesscom',
    username: 'me',
    userColor: 'white',
    opponent: 'opp',
    result: 'win',
    timeControl: '600',
    timeClass: 'rapid',
    endTime: Date.now(),
    opening: 'Italian Game',
    eco: 'C50',
    pgn: '1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. O-O Nf6 5. d3 d6 1-0',
    importedAt: Date.now(),
    analysisStatus: 'pending',
  };
  await db.games.put(g);
  return g.id;
});

// Wait for it to be analyzed.
const start = Date.now();
while (Date.now() - start < 60000) {
  const st = await page.evaluate(async (id) => {
    const { db } = await import('/src/db/schema.ts');
    return (await db.games.get(id))?.analysisStatus;
  }, id);
  if (st === 'done') break;
  await new Promise((r) => setTimeout(r, 500));
}
console.log('Analysis done.');

// Navigate to the review page.
await page.goto(`${URL}#/review/${id}`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1000);

// Step through 4 moves via ArrowRight to get to a position where white has played 3 moves.
for (let i = 0; i < 4; i++) {
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(200);
}

// Grab the DOM of the board and check for classification badge presence.
const hasBadge = await page.evaluate(() => {
  return document.body.innerText.includes('Best') ||
    document.querySelectorAll('.bg-good, .bg-mistake, .bg-blunder, .bg-inaccuracy').length > 0;
});
console.log('Badge present:', hasBadge);

// Check that heading says "White played" or "Black played" (not "You played").
const insight = await page.evaluate(() => {
  const body = document.body.innerText;
  return {
    hasWhitePlayed: body.includes('White played'),
    hasBlackPlayed: body.includes('Black played'),
    hasYouPlayed: body.includes('You played'),
  };
});
console.log('Insight wording:', insight);

// Try playing an off-mainline move: e.g. move the a-pawn.
// We need to find a valid move for the current turn. Let's examine current FEN.
const fenInfo = await page.evaluate(() => {
  // Chessground uses chess.js on our side to compute dests; we can just read the current FEN via our data attr? Not easy.
  // Simulate: click square "a2" then "a3" as white (if white to move).
  return document.body.innerText.slice(0, 300);
});
console.log('\nPage text sample:', fenInfo);

// Drag a piece: find the element at square a2 and b3 using aria or class selectors.
// chessground squares are rendered as piece elements with class "piece" and coords as data-key.
const piecesSel = await page.locator('cg-board piece').count();
console.log('Pieces on board:', piecesSel);

// Try to drag a2->a3 programmatically by computing coordinates.
const boardBox = await page.locator('.cg-wrap').boundingBox();
if (boardBox) {
  const sq = boardBox.width / 8;
  // white orientation: a1 is bottom-left. a2 = col 0, row 6 from top.
  // a2 center:
  const a2x = boardBox.x + sq * 0 + sq / 2;
  const a2y = boardBox.y + sq * 6 + sq / 2;
  const a3x = boardBox.x + sq * 0 + sq / 2;
  const a3y = boardBox.y + sq * 5 + sq / 2;
  await page.mouse.move(a2x, a2y);
  await page.mouse.down();
  await page.mouse.move(a3x, a3y, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(400);
}

const exploring = await page.evaluate(() => document.body.innerText.includes('Exploring') || document.body.innerText.includes('Return to game'));
console.log('\nIs exploring after off-mainline move:', exploring);

if (exploring) {
  // Wait for live eval.
  await page.waitForTimeout(3000);
  const liveText = await page.evaluate(() => {
    const m = document.body.innerText.match(/Engine \(depth [\d…]+\)[\s\S]{0,120}/);
    return m?.[0];
  });
  console.log('Live eval text:', liveText);
}

await browser.close();
