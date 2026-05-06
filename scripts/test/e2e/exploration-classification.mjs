// Verify that when the user makes an off-mainline move on the review
// page, a classification badge appears next to the moved piece (using
// the live-eval cache + classifyMove) instead of nothing.
//
// Regression guard for the "icon does not show next to the piece when
// I make a move outside the game" report.

import { runBrowserTest, expect, sleep, DEFAULT_URL } from '../harness.mjs';

await runBrowserTest({
  name: 'exploration-classification',
  async run({ page, errors }) {
    // Insert a small game (gets analyzed quickly) — we need an analyzed
    // game so the live-eval cache fallback (`analysis.moves[mainlinePly]`)
    // has data for the branch point.
    const id = await page.evaluate(async () => {
  const { db } = await import('/src/db/schema.ts');
  const g = {
    id: 'expcls-001',
    url: 'https://example.com/expcls',
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

    // Wait for analysis.
    const start = Date.now();
    while (Date.now() - start < 60_000) {
      const st = await page.evaluate(async (id) => {
        const { db } = await import('/src/db/schema.ts');
        return (await db.games.get(id))?.analysisStatus;
      }, id);
      if (st === 'done') break;
      await sleep(500);
    }
    console.log('Analysis done.');

    await page.goto(`${DEFAULT_URL}#/review/${id}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(800);

    // Don't step through the mainline — go straight to off-mainline from
    // move 0 (the starting position). White to move; a2-a4 is a known
    // non-best-but-not-terrible move (engine prefers e4/d4/Nf3).
    const boardBox = await page.locator('.cg-wrap').boundingBox();
    expect(boardBox, 'board bounding box').toBeTruthy();
    const sq = boardBox.width / 8;
    // White orientation: a1 bottom-left. a2 = file 0, rank 6 from top.
    const a2x = boardBox.x + sq * 0 + sq / 2;
    const a2y = boardBox.y + sq * 6 + sq / 2;
    const a4x = boardBox.x + sq * 0 + sq / 2;
    const a4y = boardBox.y + sq * 4 + sq / 2;

    await page.mouse.move(a2x, a2y);
    await page.mouse.down();
    await page.mouse.move(a4x, a4y, { steps: 6 });
    await page.mouse.up();

    // Wait long enough for the live engine to settle on the new position
    // (depth 14 on a fresh eval is ~300-1500 ms in headless Stockfish).
    await page.waitForTimeout(8000);

    const result = await page.evaluate(() => {
  // Check for the classification badge: it's rendered as an absolutely
  // positioned span with the bg-* class (see CLASSIFICATION_BADGE in
  // Board.tsx). We're looking for any badge bg-* class appearing on
  // the board overlay container.
  const badgeClasses = [
    'bg-brilliant',
    'bg-good',
    'bg-mistake',
    'bg-blunder',
    'bg-inaccuracy',
    'bg-miss',
    'bg-slate-400',
    'bg-slate-500',
  ];
  const badges = badgeClasses.flatMap((c) => Array.from(document.querySelectorAll(`.${c}`)));
  const exploring = document.body.innerText.includes('Exploring (+');
      return {
        badgeCount: badges.length,
        exploring,
        sampleBadgeHtml: badges[0]?.outerHTML?.slice(0, 200) ?? null,
      };
    });
    console.log('Result:', result);

    if (errors.length > 0) {
      console.error('Console errors:');
      for (const e of errors) console.error('  ', e);
    }

    expect(result.exploring, 'entered exploration after off-mainline drag').toBeTruthy();
    expect(result.badgeCount, 'classification badge appears after off-mainline move').toBeAtLeast(1);
    console.log('PASS: classification badge appears after off-mainline move');
  },
});
