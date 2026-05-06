// E2E smoke for the review-page exploration mode. Imports a tiny game,
// waits for it to analyze, opens it in the review UI, and tries an
// off-mainline move via simulated mouse drags. Best read alongside
// exploration-classification.mjs which asserts on the badge.

import { runBrowserTest, DEFAULT_URL, sleep } from '../harness.mjs';

await runBrowserTest({
  name: 'exploration',
  async run({ page }) {
    const id = await page.evaluate(async () => {
  const { db } = await import('/src/db/schema.ts');
  const g = {
    id: 'explore-test-001',
    url: 'https://example.com/explore', source: 'chesscom', username: 'me', userColor: 'white',
    opponent: 'opp', result: 'win', timeControl: '600', timeClass: 'rapid',
    endTime: Date.now(), opening: 'Italian Game', eco: 'C50',
    pgn: '1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. O-O Nf6 1-0',
    importedAt: Date.now(), analysisStatus: 'pending',
  };
  await db.games.put(g);
  return g.id;
});

    const start = Date.now();
    while (Date.now() - start < 60_000) {
      const st = await page.evaluate(
        async (id) => (await (await import('/src/db/schema.ts')).db.games.get(id))?.analysisStatus,
        id,
      );
      if (st === 'done') break;
      await sleep(500);
    }

    await page.goto(`${DEFAULT_URL}#/review/${id}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1200);

// Skip to initial position. Try to play 1. e4 as white.
const info = await page.evaluate(() => {
  const wrap = document.querySelector('.cg-wrap');
  const pieces = Array.from(document.querySelectorAll('cg-board piece')).map(p => ({
    color: p.getAttribute('class')?.match(/white|black/)?.[0],
    klass: p.getAttribute('class'),
    style: p.getAttribute('style'),
  }));
  return { hasWrap: !!wrap, piecesFirst: pieces.slice(0, 3), total: pieces.length };
});
console.log(JSON.stringify(info, null, 2));

// Locate e2 square and drag to e4.
const box = await page.locator('.cg-wrap').boundingBox();
console.log('board box', box);
if (box) {
  const sq = box.width / 8;
  // a1 bottom-left for white orientation. e2 = file 4, rank 1 (0-indexed from bottom).
  // In screen coords: x = col*sq, y = (7-row)*sq
  const e2x = box.x + 4 * sq + sq / 2;
  const e2y = box.y + (7 - 1) * sq + sq / 2;
  const e4x = box.x + 4 * sq + sq / 2;
  const e4y = box.y + (7 - 3) * sq + sq / 2;
  console.log(`dragging e2 (${e2x},${e2y}) -> e4 (${e4x},${e4y})`);
  await page.mouse.move(e2x, e2y);
  await page.waitForTimeout(100);
  await page.mouse.down();
  await page.waitForTimeout(100);
  await page.mouse.move(e4x, e4y, { steps: 12 });
  await page.waitForTimeout(100);
  await page.mouse.up();
  await page.waitForTimeout(500);
}

const after = await page.evaluate(() => ({
  text: document.body.innerText.slice(0, 500),
  exploring: document.body.innerText.includes('Return to game') || document.body.innerText.includes('Exploring'),
}));
console.log('\nafter move:');
console.log(JSON.stringify(after, null, 2));

// Now try off-mainline. Main game started with 1.e4 e5, so if we played 1.e4 we're still on main.
// Play a rare second move for black, say a6.
const afterPly = await page.evaluate(() => {
  const m = document.body.innerText.match(/Ply (\d+)\/(\d+)/);
  return m ? { ply: +m[1], total: +m[2] } : null;
});
console.log('ply after move:', afterPly);

// Try an off-mainline: 1... a6 (main was 1...e5).
if (box && afterPly?.ply === 1) {
  const sq = box.width / 8;
  const a7x = box.x + 0 * sq + sq / 2;
  const a7y = box.y + (7 - 6) * sq + sq / 2;
  const a6x = box.x + 0 * sq + sq / 2;
  const a6y = box.y + (7 - 5) * sq + sq / 2;
  console.log(`dragging a7 -> a6`);
  await page.mouse.move(a7x, a7y);
  await page.mouse.down();
  await page.mouse.move(a6x, a6y, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(2000);
}

    const finalState = await page.evaluate(() => ({
      exploring: document.body.innerText.includes('Return to game'),
      text: document.body.innerText.slice(0, 700),
    }));
    console.log('\nfinal:');
    console.log(JSON.stringify(finalState, null, 2));
    // This script is a smoke / observation harness — it logs but does
    // not assert. Use exploration-classification.mjs for the real check.
  },
});
