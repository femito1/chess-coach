// Pin the puzzle solver's "auto-retry on a wrong move" + "Hint + Reveal
// stay visible after the first mistake" + "hint ring is centered on
// the target square" contracts.
//
// These are solver-level contracts and they survived the Puzzles rewrite
// (the corpus changed from mined-from-your-games positions to the bundled
// Lichess library; `applyPuzzleMove` and the board wiring did not).
//
// ---------------------------------------------------------------------------
// How this test stays deterministic without seeding the DB
// ---------------------------------------------------------------------------
// The old version of this test seeded a synthetic row into `db.puzzles`. The
// page no longer reads that table — puzzle content is immutable static TSV
// under `public/puzzles/<buildId>/`, so there is nothing to seed.
//
// Instead we exploit the fact that a tier tab is a deterministic ladder: with
// no recorded attempts, the Easy tab serves shard `b0-0` row 0 first, in
// ascending rating order. So the test reads that exact row out of the shard
// itself, derives the expected solution and a wrong-but-legal alternative
// with chess.js, and drives the real UI. Nothing is hard-coded, so a corpus
// refresh can change row 0 without breaking the test — and as a bonus this
// now covers the real shard fetch + parse path end to end.
//
// Story:
//   1. Clear `puzzleAttempts` so nothing is excluded from the ladder.
//   2. Read shard b0-0 row 0 — the puzzle the Easy tab will serve.
//   3. Derive a wrong-but-legal first move (any legal move whose UCI differs
//      from the solution's first move).
//   4. Play the wrong move via a real chessground drag so `onMove` fires and
//      chessground performs its "snap back on rejection" revert. The status
//      row should read the "Not quite" copy and NO `Try again` button should
//      exist anywhere.
//   5. The board must still be interactive so the user can re-drag without a
//      button click — the whole point of auto-retry.
//   6. Reveal + Hint must both be on-screen now; pre-mistake only Hint is.
//   7. Click Hint and verify the ring's bounding-box centre matches the
//      from-square's centre within ~1.5 px per axis. Regression guard for the
//      off-centre hint ring on non-multiple-of-8 board widths.
//   8. Play the correct move and verify the puzzle completes.

import { runBrowserTest, expect, sleep } from '../harness.mjs';

await runBrowserTest({
  name: 'puzzle-auto-retry',
  // 1037-px viewport puts the board into a frame whose width
  // (post-eval-bar) is NOT a multiple of 8 — this is the viewport that
  // actually showed the off-center ring before the fix.
  viewport: { width: 1037, height: 727 },
  waitUntil: 'domcontentloaded',
  async run({ page }) {
    await page.waitForSelector('a[href="/puzzles"]', { timeout: 10_000 });

    // --- 1 + 2: clear progress, then read the puzzle the ladder will serve.
    const target = await page.evaluate(async () => {
      const { db } = await import('/src/db/schema.ts');
      await db.puzzleAttempts.clear();

      const { PUZZLE_SHARDS } = await import('/src/data/puzzles.meta.generated.ts');
      const { shardUrl, parseShard } = await import('/src/features/puzzles/corpus.ts');

      // Easy tab, ascending difficulty → the very first shard's first row.
      const first = PUZZLE_SHARDS[0];
      const res = await fetch(shardUrl(first));
      if (!res.ok) return { error: `shard fetch ${res.status}` };
      const rows = parseShard(await res.text());
      const p = rows[0];
      if (!p) return { error: 'shard parsed to zero rows' };

      // Derive a wrong-but-legal alternative to the solution's first move.
      const { Chess } = await import('/node_modules/chess.js/dist/esm/chess.js');
      const c = new Chess();
      c.load(p.fen);
      const expected = p.solution[0];
      const wrong = c
        .moves({ verbose: true })
        .map((m) => ({ uci: m.from + m.to + (m.promotion ?? ''), from: m.from, to: m.to }))
        .find((m) => m.uci.slice(0, 4) !== expected.slice(0, 4));

      return {
        id: p.id,
        fen: p.fen,
        rating: p.rating,
        expected,
        expectedFrom: expected.slice(0, 2),
        expectedTo: expected.slice(2, 4),
        wrong: wrong ?? null,
        turn: c.turn() === 'w' ? 'white' : 'black',
        legalCount: c.moves().length,
      };
    });

    expect(target.error, `shard read (${target.error ?? 'ok'})`).toBe(undefined);
    expect(Boolean(target.wrong), 'a wrong-but-legal move exists').toBe(true);
    console.log(
      `target puzzle ${target.id} (rating ${target.rating}, ${target.turn} to play): ` +
        `solution ${target.expected}, wrong ${target.wrong.uci}`,
    );

    // --- Navigate to the Easy tab.
    await page.goto('http://localhost:5173/puzzles?e2e_auth_bypass=1', {
      waitUntil: 'domcontentloaded',
    });
    await page.waitForSelector('[role="tab"]', { timeout: 10_000 });
    await page.locator('[role="tab"]', { hasText: /^\s*Easy/ }).first().click();
    await page.waitForSelector('.cg-wrap', { timeout: 10_000 });
    // Settle: chessground init + first useLiveEval render.
    await sleep(900);

    // Confirm the page really is showing the puzzle we read, otherwise every
    // coordinate below is meaningless.
    const ratingShown = await page.locator(`text=/Rating ${target.rating}/`).count();
    expect(ratingShown, `rating ${target.rating} shown in rail`).toBeAtLeast(1);

    // Helpers: drag a piece via chessground's resolved square pixels.
    async function squareCenter(square) {
      return page.evaluate((s) => {
        const wrap = document.querySelector('.cg-wrap');
        const rect = wrap.getBoundingClientRect();
        // chessground floors its container to a multiple of 8 px, so query
        // the actual `cg-container` for an exact match.
        const container = document.querySelector('cg-container');
        const cRect = container ? container.getBoundingClientRect() : rect;
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
      }, square);
    }

    async function dragSquares(from, to) {
      const a = await squareCenter(from);
      const b = await squareCenter(to);
      await page.mouse.move(a.x, a.y);
      await page.mouse.down();
      await page.mouse.move(b.x, b.y, { steps: 6 });
      await page.mouse.up();
    }

    function buttonByText(text) {
      return page.locator('button', { hasText: new RegExp(`^\\s*${text}\\s*$`) });
    }

    // --- Pre-mistake: Hint visible, Reveal hidden, no Try again / Restart.
    await sleep(200);
    expect(await buttonByText('Hint').count(), 'Hint visible pre-mistake').toBeAtLeast(1);
    expect(await buttonByText('Reveal').count(), 'Reveal hidden pre-mistake').toBe(0);
    expect(await buttonByText('Try again').count(), 'no Try again button').toBe(0);
    expect(await buttonByText('Restart').count(), 'Restart hidden pre-mistake').toBe(0);

    // --- 4: wrong-but-legal move.
    await dragSquares(target.wrong.from, target.wrong.to);
    await sleep(500);

    const statusText = await page.locator('text=/Not quite/').first().innerText();
    expect(statusText.includes('Not quite'), 'Not quite copy shown').toBe(true);
    expect(await buttonByText('Try again').count(), 'still no Try again button').toBe(0);
    expect(await buttonByText('Hint').count(), 'Hint visible post-mistake').toBeAtLeast(1);
    expect(
      await buttonByText('Reveal').count(),
      'Reveal visible post-mistake',
    ).toBeAtLeast(1);

    // --- 5: board must still be interactive so the user can re-drag.
    const manipulable = await page.evaluate(() =>
      document.querySelector('.cg-wrap').classList.contains('manipulable'),
    );
    expect(manipulable, 'board still manipulable after wrong move').toBe(true);

    // --- 7: hint ring centred on the solution's from-square.
    await buttonByText('Hint').first().click();
    await sleep(300);

    const want = await squareCenter(target.expectedFrom);
    const ring = await page.evaluate(() => {
      const wrap = document.querySelector('.cg-wrap');
      const overlayRoot = wrap.parentElement;
      const rings = Array.from(
        overlayRoot.querySelectorAll('div[style*="border-radius"]'),
      );
      if (rings.length === 0) return { rings: 0 };
      const r = rings[0].getBoundingClientRect();
      return { rings: rings.length, gotX: r.left + r.width / 2, gotY: r.top + r.height / 2 };
    });
    expect(ring.rings, 'hint ring count').toBeAtLeast(1);
    const dx = ring.gotX - want.x;
    const dy = ring.gotY - want.y;
    expect(Math.abs(dx), `hint dx (${dx})`).toBeAtMost(1.5);
    expect(Math.abs(dy), `hint dy (${dy})`).toBeAtMost(1.5);

    // --- 8: correct move completes the puzzle.
    await dragSquares(target.expectedFrom, target.expectedTo);
    // Longer settle: a multi-move solution plays the opponent reply on a
    // human-feeling delay, and only then flips to Solved.
    await sleep(1200);

    const solvedShown = await page.locator('text=/Solved!/').count();
    expect(solvedShown, 'solved status appears').toBeAtLeast(1);

    // Themes are revealed only after completion — before it they would give
    // the answer away. Assert the reveal actually happened.
    const themesShown = await page.locator('text=/themes/i').count();
    expect(themesShown, 'themes revealed after solving').toBeAtLeast(1);

    // The attempt must be persisted, and a first-try clean solve retires the
    // puzzle from the ladder.
    const recorded = await page.evaluate(async (id) => {
      const { db } = await import('/src/db/schema.ts');
      const row = await db.puzzleAttempts.get(id);
      return row ? { attempts: row.attempts, solvedClean: row.solvedClean, hintUsed: row.hintUsed } : null;
    }, target.id);
    expect(Boolean(recorded), 'attempt persisted').toBe(true);
    expect(recorded.attempts, 'attempt count').toBe(1);
    // We deliberately used a hint, so this must NOT count as a clean solve —
    // the anti-laundering rule in `recordAttempt`.
    expect(recorded.hintUsed, 'hint recorded').toBe(true);
    expect(recorded.solvedClean, 'hinted solve is not clean').toBe(false);
  },
});
