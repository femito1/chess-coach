// Verify that when the user makes an off-mainline move on the review
// page, a classification badge appears next to the moved piece (using
// the live-eval cache + classifyMove) instead of nothing.
//
// Regression guard for the "icon does not show next to the piece when
// I make a move outside the game" report.

import { runBrowserTest, expect, sleep, DEFAULT_URL, appendBypass } from '../harness.mjs';

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

    await page.goto(appendBypass(`${DEFAULT_URL}review/${id}`), { waitUntil: 'networkidle' });
    await page.waitForTimeout(800);

    // Step past the book phase before going off-mainline. The whole
    // 5-move Italian Game in the test's PGN is in the openings book,
    // and the book classifier short-circuits in `classifyMove`
    // (engine/classify.ts) when both `fenBefore` and `fenAfter` are
    // recognised book FENs — including any sensible deviation from
    // the start position. If we branch from move 0, the classifier
    // returns 'book', which renders the `bg-book` badge — which used
    // to be `bg-slate-500` and was renamed in the move-list-color
    // refactor without the assertion list being updated.
    //
    // Stepping through 4 mainline plies puts us at move 5 (white to
    // move after 4. O-O Nf6), well past the book cutoff (`ply <= 10`
    // gate plus the actual book-FEN check). Now an off-mainline
    // move classifies as a real grade (best / good / inaccuracy /
    // mistake / blunder).
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press('ArrowRight');
      await page.waitForTimeout(150);
    }

    // Capture mainline ply for diagnostics.
    const plyBefore = await page.evaluate(() => {
      const m = document.body.innerText.match(/Ply (\d+)\/(\d+)/);
      return m ? { current: Number(m[1]), total: Number(m[2]) } : null;
    });
    console.log('Mainline ply before exploration:', plyBefore);

    // White to move from the post-`4. O-O Nf6` position. h2-h4 is a
    // well-defined non-book move and the engine readily classifies it.
    const boardBox = await page.locator('.cg-wrap').boundingBox();
    expect(boardBox, 'board bounding box').toBeTruthy();
    const sq = boardBox.width / 8;
    // White orientation: a1 bottom-left. h2 = file 7, rank 6 from top.
    const h2x = boardBox.x + sq * 7 + sq / 2;
    const h2y = boardBox.y + sq * 6 + sq / 2;
    const h4x = boardBox.x + sq * 7 + sq / 2;
    const h4y = boardBox.y + sq * 4 + sq / 2;

    await page.mouse.move(h2x, h2y);
    await page.mouse.down();
    await page.mouse.move(h4x, h4y, { steps: 6 });
    await page.mouse.up();

    // Wait long enough for the live engine to settle on the new position
    // (depth 14 on a fresh eval is ~300-1500 ms in headless Stockfish).
    await page.waitForTimeout(8000);

    const result = await page.evaluate(() => {
  // Select the badge by its stable `data-test-classification-badge`
  // attribute (set in Board.tsx → BadgeOverlay) instead of by Tailwind
  // class names. Class-name selectors broke twice in this repo:
  //   1. `bg-good/80` (used for `excellent`) contains `/`, which a
  //      plain `.bg-good` selector won't match.
  //   2. `bg-book` was renamed from `bg-slate-500` in the move-list-
  //      color refactor (commit 51a8cd0) — anything keyed on the old
  //      name silently went stale.
  // The data-attribute is renamer-proof and carries the classification
  // name itself, so failures show *what* classification rendered.
  const badges = Array.from(
    document.querySelectorAll('[data-test-classification-badge]'),
  );
  const exploring = document.body.innerText.includes('Exploring (+');
  // Diagnostic: pull the full body text + a snapshot of the relevant
  // parts of the move-insight panel to figure out what state the page
  // is actually in. We see "exploring: true" but no badge — likely
  // means `explorationInsight` returned undefined, which can happen
  // if `liveEval` is still running or `moverWinrateBefore` couldn't
  // be resolved.
  const insightPanel = document.querySelector('[data-test-move-insight]')?.textContent ?? null;
  const bodyText = document.body.innerText;
  const evalAfterMatch = bodyText.match(/Eval after:[^\n]*/);
  return {
    badgeCount: badges.length,
    badgeClassifications: badges.map((b) =>
      b.getAttribute('data-test-classification-badge'),
    ),
    exploring,
    sampleBadgeHtml: badges[0]?.outerHTML?.slice(0, 200) ?? null,
    insightPanel,
    evalAfter: evalAfterMatch?.[0] ?? null,
    bodySnippet: bodyText.slice(0, 600),
  };
    });
    console.log('Result:', JSON.stringify(result, null, 2));

    if (errors.length > 0) {
      console.error('Console errors:');
      for (const e of errors) console.error('  ', e);
    }

    expect(result.exploring, 'entered exploration after off-mainline drag').toBeTruthy();
    expect(result.badgeCount, 'classification badge appears after off-mainline move').toBeAtLeast(1);
    console.log('PASS: classification badge appears after off-mainline move');
  },
});
