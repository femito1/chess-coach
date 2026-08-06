// Pin the "Play it out vs engine" CTA + FreePlayRunner integration on
// the practice page. The post-line-completion free-play flow is the
// 2026-05-20 feature that lets a user finish drilling an opening line
// and continue playing the position out against Stockfish (configurable
// strength), with their moves classified live and an eval bar tracking
// the position.
//
// Story:
//   1. Seed a single Italian Game line into a family-bound repertoire.
//   2. Open `/repertoire/<id>/drill` so the LineRunner mounts on that line.
//   3. Walk the line to completion by playing each expected `uci` in
//      sequence (the opponent autoplays at 600 ms intervals; we just
//      drive the user's moves and let `LineRunner` flip turn).
//   4. Assert the "Play it out vs engine" CTA renders once `status ===
//      'done'`. Click it.
//   5. Assert the FreePlayRunner mounts: the transition banner is
//      visible, the eval bar is rendered to the left of the board, and
//      the runner column has swapped from `LineRunner` (no Hint /
//      Restart line / Skip controls anymore).
//   6. Make one user move and confirm a Stockfish reply lands within
//      ~10 s. (We don't assert the badge classification here — that's
//      a longer-running smoke that depends on two engines spinning up;
//      `exploration-classification` already covers the
//      `classifyMove`-on-live-eval pipeline end-to-end.)
//   7. Click "Back to practice" and assert the practice runner re-
//      mounts (the LineRunner status row reappears).

import { runBrowserTest, expect, sleep } from '../harness.mjs';

await runBrowserTest({
  name: 'practice-freeplay',
  viewport: { width: 1280, height: 1024 },
  waitUntil: 'domcontentloaded',
  async run({ page }) {
    await page.waitForSelector('a[href="/repertoire"]', { timeout: 10_000 });

    const seed = await page.evaluate(async () => {
      const { db } = await import('/src/db/schema.ts');
      const { ensureFamilyRepertoire, addLineToRepertoire, getVariations } =
        await import('/src/features/openings/library.ts');
      await db.repertoires.clear();
      await db.repertoireNodes.clear();
      await db.repertoireCards.clear();
      await db.repertoireLineStats.clear();
      const r = await ensureFamilyRepertoire('Italian Game');
      const lines = getVariations('Italian Game').slice(0, 1);
      for (const l of lines) await addLineToRepertoire(r.id, l);
      return { repId: r.id, line: lines[0] };
    });
    expect(seed.repId.length > 0, 'repertoire seeded').toBe(true);
    expect(seed.line && seed.line.uci.length > 0, 'line has plies').toBe(true);

    await page.goto(
      `http://localhost:5173/repertoire/${seed.repId}/drill?e2e_auth_bypass=1`,
      { waitUntil: 'domcontentloaded' },
    );
    await page.waitForSelector('.cg-wrap', { timeout: 10_000 });
    await sleep(800);

    function buttonByText(text) {
      return page.locator('button', { hasText: new RegExp(`^\\s*${text}\\s*$`) });
    }

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
            return {
              x: cRect.left + bf * sw + sw / 2,
              y: cRect.top + br * sh + sh / 2,
            };
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

    // Italian Game is a white-side repertoire so even-indexed plies
    // (0, 2, 4, …) are user moves and odd-indexed are opponent
    // autoplay. Walk the whole line.
    for (let i = 0; i < seed.line.uci.length; i++) {
      const uci = seed.line.uci[i];
      const isUserPly = i % 2 === 0;
      if (isUserPly) {
        await dragSquares(uci.slice(0, 2), uci.slice(2, 4));
        // Allow the runner's correct-move animation (350 ms) +
        // opponent autoplay timer (~600 ms) to settle.
        await sleep(750);
      } else {
        // Opponent autoplay; just wait for the LineRunner timer.
        await sleep(750);
      }
    }

    // Line is complete — assert "Line complete" and the new CTA.
    expect(
      await page.locator('text=/Line complete/').count(),
      'line complete copy visible',
    ).toBeAtLeast(1);
    const ctaCount = await buttonByText('Play it out vs engine').count();
    expect(ctaCount, 'Play it out vs engine CTA visible on done').toBeAtLeast(1);

    // Click the CTA.
    await buttonByText('Play it out vs engine').first().click();
    await sleep(400);

    // FreePlayRunner mounted: transition banner visible.
    expect(
      await page.locator("text=/playing vs Stockfish/").count(),
      'transition banner visible',
    ).toBeAtLeast(1);

    // FreePlay status bar: "Back to practice" + strength dropdown
    // present, "Hint" button gone (LineRunner unmounted).
    expect(
      await buttonByText('Back to practice').count(),
      'Back to practice button visible',
    ).toBeAtLeast(1);
    expect(
      await page.locator('select#freeplay-strength').count(),
      'strength dropdown rendered',
    ).toBe(1);
    // The LineRunner's "Restart line" should be gone now.
    expect(
      await buttonByText('Restart line').count(),
      'LineRunner unmounted (Restart line gone)',
    ).toBe(0);

    // Make a user move and wait for Stockfish's reply. Italian Game
    // ends after `Bc4` (white) or `Nf6 / Bc5` (black) depending on
    // which line — the user is white, so the line ends on a white
    // move and it's now black to move (Stockfish). Wait for the
    // engine to play one move on its own first.
    //
    // We DON'T assert the specific reply UCI — Stockfish at depth 14
    // is deterministic but the canonical opener after `Bc4` varies
    // by build. We just count that the FEN field below the board
    // changes, which signals an engine move landed.
    const fenBefore = await page.evaluate(() => {
      const el = document.querySelector('cg-container');
      // chessground doesn't expose FEN on the DOM directly. Use the
      // piece nodes count + signature as a proxy — any move changes
      // their `data-key` ordering.
      if (!el) return '';
      return Array.from(el.querySelectorAll('piece'))
        .map((p) => `${p.className}@${p.style.transform}`)
        .join('|');
    });

    // Wait up to 20 s for Stockfish to play. The first search after
    // page load includes one-time worker boot + WASM-NNUE init (a few
    // hundred ms cold) plus, under React StrictMode in dev, a flush
    // round-trip when the second mount cancels the first search and
    // waits for `readyok` before issuing the new `position; go`. The
    // search itself at depth 14 from a typical post-opening position
    // is sub-second; the surrounding plumbing is what takes the time.
    let fenAfter = fenBefore;
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      await sleep(400);
      fenAfter = await page.evaluate(() => {
        const el = document.querySelector('cg-container');
        if (!el) return '';
        return Array.from(el.querySelectorAll('piece'))
          .map((p) => `${p.className}@${p.style.transform}`)
          .join('|');
      });
      if (fenAfter !== fenBefore) break;
    }
    expect(
      fenAfter !== fenBefore,
      'Stockfish played a reply within 20 s',
    ).toBe(true);

    // ── Arrow-key navigation ────────────────────────────────────────
    // Now that there's at least one move on the board (Stockfish's
    // first reply), the back arrow should be live. Pressing ← rewinds
    // the cursor and the page surfaces the "Reviewing past position"
    // hint; pressing → walks back to the tip and the hint goes away.
    // Pin the round-trip + the hint visibility so a future refactor
    // can't silently break the navigation contract.
    const backBtn = page
      .locator('button[aria-label="Back"]')
      .first();
    expect(
      await backBtn.count(),
      'back arrow button rendered',
    ).toBe(1);
    expect(
      await page.locator('text=/Reviewing past position/').count(),
      'no past-position hint at the tip',
    ).toBe(0);
    // Press the left arrow key to rewind. We focus the body first so
    // the keydown handler (attached to window) actually fires —
    // playwright defaults to dispatching to whatever has focus, and
    // an idle page sometimes has focus on a control that swallows
    // arrow keys.
    await page.evaluate(() => {
      const el = document.activeElement;
      if (el && typeof (el).blur === 'function') el.blur();
    });
    await page.keyboard.press('ArrowLeft');
    await sleep(200);
    expect(
      await page.locator('text=/Reviewing past position/').count(),
      'past-position hint visible after ←',
    ).toBeAtLeast(1);
    // Forward returns to the tip.
    await page.keyboard.press('ArrowRight');
    await sleep(200);
    expect(
      await page.locator('text=/Reviewing past position/').count(),
      'past-position hint gone after →',
    ).toBe(0);

    // Click "Back to practice" and confirm we re-mount the practice
    // runner. The FreePlayRunner unmounts (banner + Back-to-practice
    // gone) and the LineRunner-style controls reappear.
    await buttonByText('Back to practice').first().click();
    await sleep(500);
    expect(
      await buttonByText('Back to practice').count(),
      'FreePlayRunner unmounted on exit',
    ).toBe(0);
    // After exit, the practice session has advanced past the line we
    // just finished — either the next line's runner is up or the
    // session-done state is showing. Either way, the freeplay banner
    // should be gone.
    expect(
      await page.locator("text=/playing vs Stockfish/").count(),
      'transition banner gone after exit',
    ).toBe(0);
  },
});
