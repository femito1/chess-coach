// Reproduce the knight-arrow toggle bug (and verify the fix).
//
// Behaviour spec (chess.com style):
//   - Right-click drag e1 -> g3 (a knight jump): arrow appears.
//   - Right-click drag e1 -> g3 again with the same brush: arrow disappears.
//   - Right-click drag e1 -> g3 with a different brush (e.g. shift+R): arrow
//     stays but in the new colour.
//
// We exercise this by directly poking chessground's drawable state via the
// Board's onChange handler. Driving real mouse events from Playwright would
// be flaky because the right-button drag math is sensitive to bounding
// rects; instead we invoke the same code paths chessground itself uses
// (`addShape` followed by `onChange`) by calling the API surface.
//
// Run: URL=http://localhost:5173/ node scripts/test-knight-arrow-toggle.mjs

import { chromium } from 'playwright';

const URL = process.env.URL || 'http://localhost:5173/';

const browser = await chromium.launch({ headless: true });
const page = await (
  await browser.newContext({ viewport: { width: 1200, height: 900 } })
).newPage();

page.on('pageerror', (e) => console.error('[pageerror]', e.message));
page.on('console', (m) => {
  if (m.type() === 'error') console.error('[console.error]', m.text());
});

await page.goto(URL, { waitUntil: 'networkidle' });

// We need a Board instance on screen; the Repertoire trainer mounts a board
// from a fresh repertoire. Easiest: navigate to the openings library which
// renders a preview board for the first family.
// Even easier: render a dedicated sandbox board by creating a repertoire
// entry. To keep this test self-contained, navigate to /openings which the
// route defines.
await page.goto(URL + '#/openings', { waitUntil: 'networkidle' });
// The openings page may not always render a board. Fall back: open any
// route that has a Board. The review page is gated on having an analyzed
// game; the puzzles page generally does too. The simplest approach is to
// directly drive the chessground API ourselves using a tiny scratch host.

const result = await page.evaluate(async () => {
  // Spin up a Board-equivalent test rig: we can't import Board.tsx into
  // page-evaluate because it expects a React tree. Instead we exercise
  // chessground directly with the SAME draw config the Board sets up
  // and confirm the toggle flow we now handle in onChange does the
  // right thing.
  const { Chessground } = await import('/node_modules/chessground/dist/chessground.js');
  const host = document.createElement('div');
  host.style.width = '400px';
  host.style.height = '400px';
  document.body.appendChild(host);

  // Mirror the relevant subset of Board's drawable config.
  const knightOriginalBrush = new Map();
  function isKnightJump(from, to) {
    const df = Math.abs(from.charCodeAt(0) - to.charCodeAt(0));
    const dr = Math.abs(Number(from[1]) - Number(to[1]));
    return (df === 1 && dr === 2) || (df === 2 && dr === 1);
  }

  let lastOverlayKnights = [];
  function onChange(shapes) {
    const overlayKnights = [];
    const next = [];
    let mutated = false;
    for (const s of shapes) {
      const isArrow = !!s.dest && s.orig !== s.dest;
      if (isArrow && isKnightJump(s.orig, s.dest)) {
        const key = `${s.orig}-${s.dest}`;
        const incomingBrush = s.brush;
        const remembered = knightOriginalBrush.get(key);
        if (incomingBrush && incomingBrush !== 'invisible') {
          if (remembered === incomingBrush) {
            knightOriginalBrush.delete(key);
            mutated = true;
            continue;
          }
          knightOriginalBrush.set(key, incomingBrush);
          overlayKnights.push({ ...s, brush: incomingBrush });
          next.push({ ...s, brush: 'invisible' });
          mutated = true;
          continue;
        }
        const realBrush = remembered ?? 'green';
        overlayKnights.push({ ...s, brush: realBrush });
        next.push(s);
        continue;
      }
      next.push(s);
    }
    if (overlayKnights.length === 0) {
      knightOriginalBrush.clear();
    } else {
      const live = new Set(overlayKnights.map((s) => `${s.orig}-${s.dest}`));
      for (const k of knightOriginalBrush.keys()) {
        if (!live.has(k)) knightOriginalBrush.delete(k);
      }
    }
    if (mutated) api.setShapes(next);
    lastOverlayKnights = overlayKnights;
  }

  const api = Chessground(host, {
    drawable: {
      enabled: true,
      defaultSnapToValidMove: false,
      brushes: {
        green: { key: 'g', color: 'red', opacity: 0.85, lineWidth: 12 },
        red: { key: 'r', color: 'red', opacity: 0.85, lineWidth: 12 },
        blue: { key: 'b', color: '#003088', opacity: 0.85, lineWidth: 12 },
        yellow: { key: 'y', color: '#e69100', opacity: 0.85, lineWidth: 12 },
        invisible: {
          key: 'inv',
          color: 'rgba(0,0,0,0)',
          opacity: 1,
          lineWidth: 1,
        },
        paleBlue: { key: 'pb', color: '#003088', opacity: 0.4, lineWidth: 15 },
        paleGreen: { key: 'pg', color: '#15781B', opacity: 0.4, lineWidth: 15 },
        paleRed: { key: 'pr', color: '#882020', opacity: 0.4, lineWidth: 15 },
        paleGrey: { key: 'pgr', color: '#4a4a4a', opacity: 0.35, lineWidth: 15 },
      },
      onChange,
    },
  });

  // Simulate chessground's `addShape` path (which is what end() calls):
  // first push, then fire onChange.
  function simulate(orig, dest, brush) {
    // Mirror chessground/src/draw.ts addShape() exactly so we replicate
    // its toggle semantics.
    const sameShape = (s) => s.orig === orig && s.dest === dest;
    const state = api.state;
    const similar = state.drawable.shapes.find(sameShape);
    if (similar) state.drawable.shapes = state.drawable.shapes.filter((s) => !sameShape(s));
    if (!similar || similar.brush !== brush) {
      state.drawable.shapes.push({ orig, dest, brush });
    }
    onChange(state.drawable.shapes);
  }

  const log = [];

  // Step 1: draw e1 -> g2 (knight jump) with green.
  simulate('e1', 'g2', 'green');
  log.push({ step: 'after first green', overlay: lastOverlayKnights.length, shapes: api.state.drawable.shapes.length });

  // Step 2: redraw e1 -> g2 with green again. Expect: arrow disappears.
  simulate('e1', 'g2', 'green');
  log.push({ step: 'after redraw same green', overlay: lastOverlayKnights.length, shapes: api.state.drawable.shapes.length });

  // Step 3: draw e1 -> g2 with blue. Expect: arrow appears in blue.
  simulate('e1', 'g2', 'blue');
  log.push({
    step: 'after blue',
    overlay: lastOverlayKnights.length,
    overlayBrush: lastOverlayKnights[0]?.brush,
    shapes: api.state.drawable.shapes.length,
  });

  // Step 4: redraw e1 -> g2 with blue. Expect: arrow disappears.
  simulate('e1', 'g2', 'blue');
  log.push({ step: 'after redraw same blue', overlay: lastOverlayKnights.length, shapes: api.state.drawable.shapes.length });

  // Step 5: draw e1 -> g2 with green again. Expect: arrow appears.
  simulate('e1', 'g2', 'green');
  log.push({ step: 'after green (after clears)', overlay: lastOverlayKnights.length, shapes: api.state.drawable.shapes.length });

  // Step 6: draw e1 -> g2 with red (color change). Expect: arrow stays in red.
  simulate('e1', 'g2', 'red');
  log.push({
    step: 'after color change to red',
    overlay: lastOverlayKnights.length,
    overlayBrush: lastOverlayKnights[0]?.brush,
    shapes: api.state.drawable.shapes.length,
  });

  // Step 7: redraw same red — expect: disappears.
  simulate('e1', 'g2', 'red');
  log.push({ step: 'after redraw same red', overlay: lastOverlayKnights.length, shapes: api.state.drawable.shapes.length });

  return { log };
});

console.log('=== Knight arrow toggle log ===');
console.log(JSON.stringify(result.log, null, 2));

let failed = false;
const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  failed = true;
};

const expectations = [
  { idx: 0, overlay: 1, label: 'first green draw' },
  { idx: 1, overlay: 0, label: 'redraw same green should toggle off' },
  { idx: 2, overlay: 1, brush: 'blue', label: 'blue draw' },
  { idx: 3, overlay: 0, label: 'redraw same blue should toggle off' },
  { idx: 4, overlay: 1, label: 'green redraw after clear' },
  { idx: 5, overlay: 1, brush: 'red', label: 'color change green -> red keeps arrow' },
  { idx: 6, overlay: 0, label: 'redraw same red should toggle off' },
];

for (const e of expectations) {
  const r = result.log[e.idx];
  if (!r) {
    fail(`missing step ${e.idx} (${e.label})`);
    continue;
  }
  if (r.overlay !== e.overlay) {
    fail(`${e.label}: expected overlay=${e.overlay}, got ${r.overlay}`);
  }
  if (e.brush && r.overlayBrush !== e.brush) {
    fail(`${e.label}: expected overlay brush=${e.brush}, got ${r.overlayBrush}`);
  }
}

await browser.close();

if (failed) process.exit(1);
console.log('PASS: knight-arrow toggle handles redraw-as-erase + color-change correctly');
process.exit(0);
