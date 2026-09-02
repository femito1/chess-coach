// Can you reach the games table's horizontal scrollbar without hunting for it?
//
// The table is 8 columns with a 640 px floor, so in a small desktop window it is
// wider than the viewport — and with a few dozen games it is also several screens
// tall. A plain `overflow-x-auto` wrapper puts the scrollbar at the bottom of
// *the table*, which in this fixture is ~1 800 px below the fold: to scroll
// sideways you had to scroll all the way down, do it, and come back up.
//
// `StickyXScroll` draws the scrollbar in a strip stuck to the bottom of the
// viewport instead. Four things have to hold for that to be a fix:
//
//   1. The situation is real — the table overflows horizontally AND its own
//      bottom edge is far below the fold. Asserted first, because every other
//      assertion here is vacuous in a window where the table simply fits.
//   2. The strip is ON SCREEN while you are at the top of the page. This is the
//      whole feature, and it is the one thing a screenshot review would catch
//      only if the reviewer happened to have a small window.
//   3. The thumb is drawn, and proportional. It is hand-drawn precisely because a
//      mirrored native scrollbar is invisible wherever the platform uses overlay
//      scrollbars — headless Chromium included, which reports a 0 px scrollbar
//      gutter, so a native thumb could not be asserted on here at all.
//   4. Dragging it scrolls the table.
//
// Plus the no-op case: in a window wide enough for the table, no strip and no
// suppressed scrollbar. The suppression matters — the scroller hides its own
// scrollbar only while the strip is up, so a measurement failure degrades to the
// plain scroller rather than to a region that scrolls with nothing to scroll it.
//
// Run: node scripts/run-tests.mjs --only=games-sticky-scroll

import { runBrowserTest, expect, DEFAULT_URL, appendBypass, pollUntil } from '../harness.mjs';

/** Narrow enough that the 640 px table floor overflows, tall enough to be a
 *  realistic small window. */
const SMALL = { width: 700, height: 620 };
/** Comfortably wider than the table floor plus page padding. */
const WIDE = { width: 1400, height: 900 };
const GAMES = 40;

await runBrowserTest({
  name: 'games-sticky-scroll',
  skipInitialGoto: true,
  viewport: SMALL,
  async run({ page }) {
    await page.goto(appendBypass(`${DEFAULT_URL}games`), { waitUntil: 'domcontentloaded' });

    await page.evaluate(async (n) => {
      const { db } = await import('/src/db/schema.ts');
      await db.games.clear();
      const rows = [];
      for (let i = 0; i < n; i++) {
        rows.push({
          id: `sticky-g${i}`,
          url: `https://example.com/sticky-g${i}`,
          source: 'chesscom',
          username: 'me',
          userColor: i % 2 ? 'white' : 'black',
          opponent: `opponent_number_${i}`,
          result: 'win',
          timeControl: '600',
          timeClass: 'rapid',
          endTime: 1_700_000_000 + i * 1000,
          // A long opening name, so the opening column really does push the table
          // past the viewport rather than relying on the min-width alone.
          opening: 'Caro-Kann Defense: Advance Variation, Short Variation',
          pgn: '1. e4 c6 1-0',
          importedAt: Date.now(),
          analysisStatus: 'done',
        });
      }
      await db.games.bulkPut(rows);
    }, GAMES);

    // The table is behind a throttled live query.
    await pollUntil(
      async () => {
        const n = await page.evaluate(() => document.querySelectorAll('tbody tr').length);
        return { done: n >= GAMES, value: n, label: `rows rendered: ${n}/${GAMES}` };
      },
      { timeoutMs: 20_000 },
    );

    const geom = () =>
      page.evaluate(() => {
        const table = document.querySelector('table');
        const scroller = table.parentElement;
        const strip = scroller.parentElement.querySelector('[aria-hidden="true"].sticky');
        const thumb = strip?.firstElementChild ?? null;
        const vh = window.innerHeight;
        const sb = scroller.getBoundingClientRect();
        const out = {
          tableOverflows: scroller.scrollWidth - scroller.clientWidth > 1,
          scrollerBottomBelowFold: Math.round(sb.bottom - vh),
          pageTallerThanViewport: document.documentElement.scrollHeight > vh,
          scrollerHidesOwnScrollbar: scroller.className.includes('scrollbar-none'),
          scrollLeft: Math.round(scroller.scrollLeft),
          stripPresent: Boolean(strip),
          viewportHeight: vh,
        };
        if (strip && thumb) {
          const tb = strip.getBoundingClientRect();
          const hb = thumb.getBoundingClientRect();
          out.stripBottom = Math.round(tb.bottom);
          out.stripWidth = Math.round(tb.width);
          out.thumbWidth = Math.round(hb.width);
          out.thumbOffset = Math.round(hb.left - tb.left);
        }
        return out;
      });

    const top = await geom();
    console.log('small window, page at top:', JSON.stringify(top));

    // --- 1: the precondition ---------------------------------------------
    expect(
      top.tableOverflows,
      'precondition: the table is wider than this window, so there is something to scroll',
    ).toBe(true);
    expect(
      top.pageTallerThanViewport,
      'precondition: the page scrolls vertically too',
    ).toBe(true);
    expect(
      top.scrollerBottomBelowFold > 200,
      `precondition: the scroller's own bottom edge is far below the fold ` +
        `(${top.scrollerBottomBelowFold}px) — that is where its native scrollbar was, ` +
        'and why it was unreachable',
    ).toBe(true);

    // --- 2: the strip is on screen ---------------------------------------
    expect(top.stripPresent, 'the sticky strip is rendered when the table overflows').toBe(
      true,
    );
    expect(
      top.stripBottom,
      'and it is pinned to the bottom of the VISIBLE screen, not the bottom of the table',
    ).toBe(top.viewportHeight);
    expect(
      top.scrollerHidesOwnScrollbar,
      'the scroller suppresses its own scrollbar only while the strip stands in for it',
    ).toBe(true);

    // --- 3: the thumb is drawn and proportional --------------------------
    expect(top.thumbWidth > 0, 'the thumb has a width, i.e. it is actually drawn').toBe(
      true,
    );
    expect(
      top.thumbWidth < top.stripWidth,
      `the thumb is narrower than its track (${top.thumbWidth} of ${top.stripWidth}), ` +
        'so it reads as a scrollbar with somewhere to travel',
    ).toBe(true);
    expect(top.thumbOffset, 'at scrollLeft 0 the thumb sits at the left end').toBeLessThan(
      6,
    );

    // --- 4: dragging it scrolls the table --------------------------------
    const box = await page.evaluate(() => {
      const b = document
        .querySelector('table')
        .parentElement.parentElement.querySelector('[aria-hidden="true"].sticky')
        .getBoundingClientRect();
      return { x: b.x, y: b.y, w: b.width, h: b.height };
    });
    await page.mouse.move(box.x + 20, box.y + box.h / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.w - 4, box.y + box.h / 2, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(150);

    const dragged = await geom();
    console.log('after dragging the thumb right:', JSON.stringify(dragged));
    expect(
      dragged.scrollLeft > 0,
      `dragging the thumb scrolls the table (scrollLeft ${top.scrollLeft} → ${dragged.scrollLeft})`,
    ).toBe(true);
    expect(
      dragged.thumbOffset > top.thumbOffset,
      'and the thumb moved with it rather than snapping back',
    ).toBe(true);

    // --- the no-op case ---------------------------------------------------
    await page.setViewportSize(WIDE);
    await page.waitForTimeout(400);
    const wide = await geom();
    console.log('wide window:', JSON.stringify(wide));
    expect(wide.tableOverflows, 'precondition: at this width the table fits').toBe(false);
    expect(
      wide.stripPresent,
      'no strip when there is nothing to scroll — it is not permanent furniture',
    ).toBe(false);
    expect(
      wide.scrollerHidesOwnScrollbar,
      'and the scroller stops suppressing a scrollbar it may need again',
    ).toBe(false);
  },
});
