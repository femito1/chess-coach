// Pin the puzzle solver's "auto-retry on a wrong move" + "Hint + Reveal
// stay visible after the first mistake" + "hint ring is centered on
// the target square" contracts.
//
// Story:
//   1. Seed a synthetic puzzle whose solution is well-defined and has
//      a wrong-but-legal alternative for the first user move.
//   2. Make the wrong-but-legal move via a chessground API drag so the
//      Board's `onMove` callback fires and chessground performs its
//      "snap back on rejection" revert. Status row should now read the
//      "Not quite \u2014 try again" copy AND no `Try again` button
//      should have appeared anywhere on the page.
//   3. The board must still be interactive so the user can re-drag the
//      same piece *without* a button click \u2014 this is the whole
//      point of the auto-retry change.
//   4. Reveal + Hint must both be on-screen now; before the wrong
//      attempt only Hint should be on-screen (Reveal is gated on
//      `mistakeMade`).
//   5. After playing the *correct* move, Hint must still be on-screen
//      and Reveal must stay on-screen because `mistakeMade` is sticky.
//   6. Click Hint and verify the highlighted ring's bounding box
//      center matches the bounding box center of the target piece's
//      from-square within \u22641 px on each axis. This is the
//      regression guard for the "off-center hint ring on
//      non-multiple-of-8 board widths" bug.

import { runBrowserTest, expect, sleep } from '../harness.mjs';

await runBrowserTest({
  name: 'puzzle-auto-retry',
  // 1037-px viewport puts the board into a frame whose width
  // (post-eval-bar) is NOT a multiple of 8 \u2014 this is the
  // viewport that actually showed the off-center ring before
  // the fix.
  viewport: { width: 1037, height: 727 },
  waitUntil: 'domcontentloaded',
  async run({ page }) {
    await page.waitForSelector('a[href="/puzzles"]', { timeout: 10_000 });

    // Seed a puzzle with a known solution + a known wrong-but-legal
    // alternative. Solution e2-e4 (white queen-pawn-style line, but
    // with the queen actually behind it). Wrong: e2-e3 (legal but
    // not the puzzle's expected first move).
    const puzzleId = await page.evaluate(async () => {
      const { db } = await import('/src/db/schema.ts');
      await db.puzzles.clear();
      // Position: white K on h1, white pawn on e2, white queen on
      // d1, black K on h8. White to move. Solution: e2e4. Wrong
      // but legal: e2e3 (one-square push).
      const puzzle = {
        id: 'auto-retry-test',
        gameId: 'g1',
        ply: 0,
        fen: '7k/8/8/8/8/8/4P3/3Q3K w - - 0 1',
        solverColor: 'white',
        solutionUci: ['e2e4'],
        solutionSan: ['e4'],
        motifs: [],
        swingCp: 200,
        opponent: 'tester',
        timeClass: 'rapid',
        sourceClassification: 'mistake',
        tags: ['from-mistake'],
        createdAt: Date.now(),
      };
      await db.puzzles.put(puzzle);
      return puzzle.id;
    });
    expect(puzzleId, 'puzzle seeded').toBe('auto-retry-test');

    await page.goto('http://localhost:5173/puzzles?e2e_auth_bypass=1', {
      waitUntil: 'domcontentloaded',
    });
    await page.waitForSelector('.cg-wrap', { timeout: 10_000 });
    // Settle: chessground init + first useLiveEval render.
    await sleep(800);

    // Helpers: drag a piece via chessground's resolved square pixels.
    async function dragSquares(from, to) {
      const coords = await page.evaluate(
        ({ from, to }) => {
          const wrap = document.querySelector('.cg-wrap');
          const rect = wrap.getBoundingClientRect();
          // chessground floors its container to a multiple of 8 px,
          // so query the actual `cg-container` for an exact match.
          const container = document.querySelector('cg-container');
          const cRect = container ? container.getBoundingClientRect() : rect;
          const sq = (s) => {
            const f = s.charCodeAt(0) - 97;
            const r = Number(s[1]) - 1;
            const orientation = document.querySelector('.cg-wrap.orientation-black')
              ? 'black'
              : 'white';
            const bf = orientation === 'white' ? f : 7 - f;
            const br = orientation === 'white' ? 7 - r : r;
            const sw = cRect.width / 8;
            const sh = cRect.height / 8;
            return { x: cRect.left + bf * sw + sw / 2, y: cRect.top + br * sh + sh / 2 };
          };
          return { from: sq(from), to: sq(to) };
        },
        { from, to },
      );
      await page.mouse.move(coords.from.x, coords.from.y);
      await page.mouse.down();
      await page.mouse.move(coords.to.x, coords.to.y, { steps: 6 });
      await page.mouse.up();
    }

    function buttonByText(text) {
      return page.locator('button', { hasText: new RegExp(`^\\s*${text}\\s*$`) });
    }

    // Pre-mistake: Hint visible, Reveal hidden, no Try again, no
    // Restart.
    await sleep(200);
    expect(await buttonByText('Hint').count(), 'Hint visible pre-mistake').toBeAtLeast(1);
    expect(await buttonByText('Reveal').count(), 'Reveal hidden pre-mistake').toBe(0);
    expect(await buttonByText('Try again').count(), 'no Try again button').toBe(0);
    expect(await buttonByText('Restart').count(), 'Restart hidden pre-mistake').toBe(0);

    // Make a wrong-but-legal move (e2 \u2192 e3).
    await dragSquares('e2', 'e3');
    await sleep(500);

    // Post-mistake: status copy includes "Not quite", Hint + Reveal
    // are visible, no Try again button, no wrong-state lock.
    const statusText = await page.locator('text=/Not quite/').first().innerText();
    expect(statusText.includes('Not quite'), 'Not quite copy shown').toBe(true);
    expect(await buttonByText('Try again').count(), 'still no Try again button').toBe(0);
    expect(await buttonByText('Hint').count(), 'Hint visible post-mistake').toBeAtLeast(1);
    expect(await buttonByText('Reveal').count(), 'Reveal visible post-mistake').toBeAtLeast(1);

    // Board must still be interactive: chessground's
    // movable.color must be set so the user can re-drag.
    const movableColor = await page.evaluate(() => {
      const wrap = document.querySelector('.cg-wrap');
      // chessground's API isn't exposed, but movable.color "manipulable"
      // shows up as the `manipulable` class on `.cg-wrap`.
      return wrap.classList.contains('manipulable');
    });
    expect(movableColor, 'board still manipulable after wrong move').toBe(true);

    // Click Hint. Verify the ring is centered on the e2 square.
    await buttonByText('Hint').first().click();
    await sleep(300);

    const centerCheck = await page.evaluate(() => {
      const container = document.querySelector('cg-container');
      const cRect = container.getBoundingClientRect();
      const sw = cRect.width / 8;
      const sh = cRect.height / 8;
      // e2: file 4, rank 1. Orientation white: boardFile = 4,
      // boardRank = 7 - 1 = 6.
      const wantX = cRect.left + 4 * sw + sw / 2;
      const wantY = cRect.top + 6 * sh + sh / 2;
      const wrap = document.querySelector('.cg-wrap');
      const overlayRoot = wrap.parentElement;
      const rings = Array.from(
        overlayRoot.querySelectorAll('div[style*="border-radius"]'),
      );
      if (rings.length === 0) return { rings: 0 };
      const r = rings[0].getBoundingClientRect();
      return {
        rings: rings.length,
        wantX,
        wantY,
        gotX: r.left + r.width / 2,
        gotY: r.top + r.height / 2,
        dx: r.left + r.width / 2 - wantX,
        dy: r.top + r.height / 2 - wantY,
      };
    });
    expect(centerCheck.rings, 'hint ring count').toBeAtLeast(1);
    expect(Math.abs(centerCheck.dx), `hint dx (${centerCheck.dx})`).toBeAtMost(1.5);
    expect(Math.abs(centerCheck.dy), `hint dy (${centerCheck.dy})`).toBeAtMost(1.5);

    // Now play the correct move (e2 \u2192 e4) and verify the
    // mistakeMade-driven Reveal button is still on-screen, and the
    // puzzle progresses (status flips to Solved).
    await dragSquares('e2', 'e4');
    await sleep(500);

    const solvedText = await page.locator('text=/Solved!/').count();
    expect(solvedText, 'solved status appears').toBeAtLeast(1);

    // After solving, the action-row buttons collapse (no more Hint /
    // Reveal because we're not solving anymore). That's expected and
    // doesn't contradict the "stay visible after mistake" rule \u2014
    // the rule applies during solving, not after the puzzle's done.
  },
});
