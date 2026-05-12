// Pin the LineRunner's "auto-retry on a wrong move" + "Hint +
// Show-answer stay visible after the first mistake" contracts. The
// repertoire equivalent of `puzzle-auto-retry`.
//
// Story:
//   1. Seed a single repertoire line ("e2-e4 …" — the first Sicilian
//      line from the openings library) and a family-bound repertoire
//      that owns it.
//   2. Open `/practice?rep=<id>` so the practice page mounts the
//      LineRunner on that line.
//   3. Pre-mistake: only the Hint button is on-screen. No "Try
//      again", no "Show answer", no "Play it for me".
//   4. Make a wrong-but-legal user move. The board snaps the piece
//      back, the status copy switches to "Not your prep here — try
//      again", and Hint + Show-answer both appear; "Try again" is
//      NEVER rendered (auto-retry change).
//   5. The board must still be interactive (chessground's
//      `manipulable` class is still on `.cg-wrap`) so the user can
//      re-drag without a button click.
//   6. Play the *correct* move next. The line advances, status flips
//      back to neutral copy, but Show-answer must STILL be on-screen
//      because `mistakeMade` is sticky for the line's lifetime.
//   7. Click "Show answer", verify the SAN appears in the status
//      row and "Play it for me" replaces "Show answer" in the
//      action row.

import { runBrowserTest, expect, sleep } from '../harness.mjs';

await runBrowserTest({
  name: 'repertoire-line-auto-retry',
  viewport: { width: 1280, height: 1024 },
  waitUntil: 'domcontentloaded',
  async run({ page }) {
    await page.waitForSelector('a[href="/repertoire"]', { timeout: 10_000 });

    const repId = await page.evaluate(async () => {
      const { db } = await import('/src/db/schema.ts');
      const { ensureFamilyRepertoire, addLineToRepertoire, getVariations } =
        await import('/src/features/openings/library.ts');
      // Wipe so re-runs are deterministic.
      await db.repertoires.clear();
      await db.repertoireNodes.clear();
      await db.repertoireCards.clear();
      await db.repertoireLineStats.clear();
      // Italian Game is a white-side repertoire so the user plays
      // first (no opponent autoplay to wait for) and the wrong-move
      // case can be expressed with a white pawn push that ISN'T the
      // expected first move.
      const r = await ensureFamilyRepertoire('Italian Game');
      const lines = getVariations('Italian Game').slice(0, 1);
      for (const l of lines) await addLineToRepertoire(r.id, l);
      return r.id;
    });
    expect(repId.length > 0, 'repertoire id seeded').toBe(true);

    await page.goto(
      `http://localhost:5173/practice?rep=${repId}&e2e_auth_bypass=1`,
      { waitUntil: 'domcontentloaded' },
    );
    await page.waitForSelector('.cg-wrap', { timeout: 10_000 });
    // Settle: chessground init + first-line load + opponent autoplay
    // delay (LineRunner waits ~600ms before the opponent's first move
    // for black-side reps, but Sicilian is a white-rep so the user
    // moves first and there's no autoplay to wait for).
    await sleep(800);

    function buttonByText(text) {
      return page.locator('button', { hasText: new RegExp(`^\\s*${text}\\s*$`) });
    }

    // Pre-mistake assertions.
    expect(
      await buttonByText('Hint').count(),
      'Hint visible pre-mistake',
    ).toBeAtLeast(1);
    expect(
      await buttonByText('Show answer').count(),
      'Show answer hidden pre-mistake',
    ).toBe(0);
    expect(
      await buttonByText('Try again').count(),
      'no Try again button pre-mistake',
    ).toBe(0);
    expect(
      await buttonByText('Play it for me').count(),
      'no Play it for me button pre-mistake',
    ).toBe(0);

    // Drag a piece to make a wrong-but-legal move. The Sicilian's
    // first move is e2-e4 by convention, so we drag d2-d4 instead.
    async function dragSquares(from, to) {
      const coords = await page.evaluate(
        ({ from, to }) => {
          const container = document.querySelector('cg-container');
          if (!container) return null;
          const cRect = container.getBoundingClientRect();
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
      if (!coords) throw new Error('cg-container not found');
      await page.mouse.move(coords.from.x, coords.from.y);
      await page.mouse.down();
      await page.mouse.move(coords.to.x, coords.to.y, { steps: 6 });
      await page.mouse.up();
    }

    // Sanity: orientation is white (Italian Game is a white rep).
    const orientation = await page.evaluate(() =>
      document.querySelector('.cg-wrap.orientation-black') ? 'black' : 'white',
    );
    expect(orientation, 'orientation white').toBe('white');

    // Wrong move: d2-d4 (legal pawn push, but the Italian Game's
    // first move is e2-e4 so this counts as off-prep).
    await dragSquares('d2', 'd4');
    await sleep(800);
    expect(
      await page.locator('text=/Not your prep here/').count(),
      'wrong-flash status visible',
    ).toBeAtLeast(1);
    expect(
      await buttonByText('Try again').count(),
      'still no Try again button',
    ).toBe(0);
    expect(
      await buttonByText('Hint').count(),
      'Hint visible post-mistake',
    ).toBeAtLeast(1);
    expect(
      await buttonByText('Show answer').count(),
      'Show answer visible post-mistake (sticky mistakeMade)',
    ).toBeAtLeast(1);

    // Board still interactive.
    const manipulable = await page.evaluate(() => {
      const wrap = document.querySelector('.cg-wrap');
      return wrap?.classList.contains('manipulable') ?? false;
    });
    expect(manipulable, 'board manipulable after wrong move').toBe(true);

    // Now play the correct move (e2-e4) directly on the same board,
    // no button click required.
    await dragSquares('e2', 'e4');
    await sleep(900);

    // Show-answer must STILL be there because mistakeMade is sticky
    // even though we've now played a correct move. Hint may or may
    // not still show — depends on whether opponent's autoplay has
    // landed and it's the user's turn again. Wait for the opponent
    // reply to arrive (LineRunner autoplays after 600 ms).
    await sleep(700);
    expect(
      await buttonByText('Show answer').count(),
      'Show answer stays visible after a correct follow-up move',
    ).toBeAtLeast(1);

    // Click Show answer. The action row should swap to "Play it for
    // me" and the status row should mention "The line goes <SAN>".
    await buttonByText('Show answer').first().click();
    await sleep(300);
    expect(
      await page.locator('text=/The line goes/').count(),
      'reveal copy in status row',
    ).toBeAtLeast(1);
    expect(
      await buttonByText('Play it for me').count(),
      'Play it for me visible after Show answer',
    ).toBeAtLeast(1);
    expect(
      await buttonByText('Show answer').count(),
      'Show answer hidden once Play it for me is on',
    ).toBe(0);
  },
});
