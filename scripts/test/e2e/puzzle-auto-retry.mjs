// Pin the puzzle solver's wrong-move contracts:
//
//   - "auto-retry on a wrong move": no Try again button, and the board stays
//     interactive so the user just plays again;
//   - Hint + Reveal stay visible after the first mistake;
//   - the hint ring is centred on the target square;
//   - and a wrong move is never laundered into a clean solve — in particular
//     not by Restart, which used to do exactly that.
//
// These are solver-level contracts (`LibraryPuzzleSolver` + `applyPuzzleMove`)
// and they are independent of how the Puzzles page chooses what to serve.
//
// ---------------------------------------------------------------------------
// How this test gets a known puzzle
// ---------------------------------------------------------------------------
// Puzzle content is immutable static TSV under `public/puzzles/<buildId>/`, so
// there is nothing to seed. Train serves random unattempted puzzles near your
// rating, so it can't be relied on to serve a particular one either. Instead
// the test reads puzzles straight out of the first shard, derives a
// wrong-but-legal first move for each with chess.js, and opens each one
// through the page's deep link, `/puzzles?puzzle=<id>&rating=<n>`, which
// serves exactly that puzzle in the real solver. Nothing is hard-coded, so a
// corpus refresh can change which rows are picked without breaking the test,
// and the real shard fetch + parse + id lookup path is covered end to end.
//
// Every wait is tied to the puzzle being opened — its rating in the rail and
// its exact position on the board, piece for piece against its FEN — because
// the persisted Train view can render a random puzzle for a moment before the
// deep link resolves, and a drag on that board means nothing.
//
// Story, puzzle A (any puzzle):
//   1. Pre-mistake: Hint visible; Reveal, Restart and Try again absent.
//   2. Play the wrong move via a real chessground drag so `onMove` fires and
//      chessground performs its "snap back on rejection" revert. The status
//      row reads the "Not quite" copy and NO `Try again` button exists.
//   3. The board is still interactive so the user can re-drag without a
//      button click — the whole point of auto-retry — and the position is
//      back to the puzzle's start.
//   4. Reveal + Hint are both on-screen now; pre-mistake only Hint is.
//   5. Click Hint and verify the ring's bounding-box centre matches the
//      from-square's centre within ~1.5 px per axis. Regression guard for the
//      off-centre hint ring on non-multiple-of-8 board widths.
//   6. Play the correct line and verify the puzzle completes. The hint makes
//      the attempt `hint`, not clean — `hintUsed` is the anti-laundering
//      rule in `recordAttempt`.
//
// Story, puzzle B (at least two user moves, so Restart is offered):
//   7. Wrong move, then the correct first move, wait for the opponent's
//      reply, then Restart — which puts the board back to the start — and
//      play the whole line without a mistake. Before the fix, Restart zeroed
//      the per-try wrong-move counter that "clean" was computed from, so this
//      sequence recorded a clean first-try solve and raised the rating. Now
//      the stored row must read `history[0].outcome === 'mistake'` and
//      `solvedClean === false`, with the wrong move counted in `bad`.

import { Chess } from 'chess.js';
import { runBrowserTest, expect, pollUntil, sleep, appendBypass } from '../harness.mjs';

const BASE = 'http://localhost:5173/';

/** "e4:white-pawn …", sorted — the board as a FEN's placement field says. */
function placementFromFen(fen) {
  const roles = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };
  const out = [];
  fen
    .split(' ')[0]
    .split('/')
    .forEach((rank, i) => {
      let file = 0;
      for (const ch of rank) {
        if (/\d/.test(ch)) {
          file += Number(ch);
          continue;
        }
        const color = ch === ch.toUpperCase() ? 'white' : 'black';
        out.push(`${String.fromCharCode(97 + file)}${8 - i}:${color}-${roles[ch.toLowerCase()]}`);
        file++;
      }
    });
  return out.sort().join(' ');
}

/** Any legal move whose from/to differs from `expected`, or null. */
function wrongMoveFor(fen, expected) {
  const c = new Chess(fen);
  const m = c
    .moves({ verbose: true })
    .find((mv) => mv.from + mv.to !== expected.slice(0, 4) && !mv.promotion);
  return m ? { uci: m.from + m.to, from: m.from, to: m.to } : null;
}

await runBrowserTest({
  name: 'puzzle-auto-retry',
  // 1037-px viewport puts the board into a frame whose width
  // (post-eval-bar) is NOT a multiple of 8 — this is the viewport that
  // actually showed the off-center ring before the fix.
  viewport: { width: 1037, height: 727 },
  waitUntil: 'domcontentloaded',
  async run({ page, errors }) {
    await page.waitForSelector('a[href="/puzzles"]', { timeout: 10_000 });

    /* --------------------------------------------------------- helpers */

    const boardPlacement = () =>
      page.evaluate(() =>
        Array.from(document.querySelectorAll('cg-board piece'))
          .filter((p) => p.cgKey && !p.classList.contains('fading') && !p.classList.contains('ghost'))
          .map((p) => {
            const cls = Array.from(p.classList);
            const color = cls.find((c) => c === 'white' || c === 'black');
            const role = cls.find((c) =>
              ['pawn', 'knight', 'bishop', 'rook', 'queen', 'king'].includes(c),
            );
            return `${p.cgKey}:${color}-${role}`;
          })
          .sort()
          .join(' '),
      );

    async function waitForPosition(fen, label) {
      const want = placementFromFen(fen);
      let got = '';
      const t0 = Date.now();
      while (Date.now() - t0 < 15_000) {
        got = await boardPlacement();
        if (got === want) return;
        await sleep(150);
      }
      expect(got, `${label}: board shows the expected position`).toBe(want);
    }

    async function squareCenter(square) {
      return page.evaluate((s) => {
        // chessground floors its container to a multiple of 8 px, so query
        // the actual `cg-container` for an exact match.
        const cRect = document.querySelector('cg-container').getBoundingClientRect();
        const f = s.charCodeAt(0) - 97;
        const r = Number(s[1]) - 1;
        const black = Boolean(document.querySelector('.cg-wrap.orientation-black'));
        const bf = black ? 7 - f : f;
        const br = black ? r : 7 - r;
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

    /** Play solution plies [from, end), waiting after each user move for the
     *  opponent's reply to be on the board (it lands on a 550–1100 ms
     *  human-feeling delay) instead of sleeping a guess. */
    async function playFrom(puzzle, fromPly, chess) {
      for (let i = fromPly; i < puzzle.solution.length; i += 2) {
        const uci = puzzle.solution[i];
        await dragSquares(uci.slice(0, 2), uci.slice(2, 4));
        chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
        const reply = puzzle.solution[i + 1];
        if (reply) chess.move({ from: reply.slice(0, 2), to: reply.slice(2, 4), promotion: reply[4] });
        await waitForPosition(chess.fen(), `${puzzle.id} after ply ${i + 1}`);
      }
    }

    async function openPuzzle(p) {
      await page.goto(appendBypass(`${BASE}puzzles?puzzle=${p.id}&rating=${p.rating}`), {
        waitUntil: 'domcontentloaded',
      });
      await page.waitForSelector('button:has-text("Back to training")', { timeout: 15_000 });
      await page.waitForFunction(
        (r) => new RegExp(`Rating ${r}\\b`).test(document.querySelector('aside')?.innerText ?? ''),
        p.rating,
        { timeout: 15_000 },
      );
      await waitForPosition(p.fen, `${p.id} opened`);
      // Settle: chessground init + first useLiveEval render.
      await sleep(400);
    }

    async function storedRow(id) {
      return pollUntil(
        async () => {
          const r = await page.evaluate(async (pid) => {
            const { db } = await import('/src/db/schema.ts');
            return (await db.puzzleAttempts.get(pid)) ?? null;
          }, id);
          return { done: Boolean(r), value: r, label: r ? `${id} row written` : `waiting for ${id} row` };
        },
        { timeoutMs: 10_000, intervalMs: 200 },
      );
    }

    /* ------------------------------------- clear progress, pick puzzles */
    const picked = await page.evaluate(async () => {
      const { db } = await import('/src/db/schema.ts');
      await db.puzzleAttempts.clear();

      const { PUZZLE_SHARDS } = await import('/src/data/puzzles.meta.generated.ts');
      const { shardUrl, parseShard } = await import('/src/features/puzzles/corpus.ts');
      const res = await fetch(shardUrl(PUZZLE_SHARDS[0]));
      if (!res.ok) return { error: `shard fetch ${res.status}` };
      const rows = parseShard(await res.text());
      if (rows.length === 0) return { error: 'shard parsed to zero rows' };
      // No promoting user moves: a promotion opens a piece picker that a
      // plain drag doesn't answer.
      const plain = rows.filter((p) => p.solution.every((u, i) => i % 2 === 1 || u.length === 4));
      const a = plain[0];
      // B needs a second user move, so that Restart is offered mid-line.
      const b = plain.find((p) => p.id !== a?.id && p.solution.length >= 4);
      return { a, b };
    });
    expect(picked.error, `shard read (${picked.error ?? 'ok'})`).toBe(undefined);
    expect(Boolean(picked.a && picked.b), 'two suitable puzzles in shard 0').toBe(true);

    const A = { ...picked.a, wrong: wrongMoveFor(picked.a.fen, picked.a.solution[0]) };
    const B = { ...picked.b, wrong: wrongMoveFor(picked.b.fen, picked.b.solution[0]) };
    expect(Boolean(A.wrong), 'puzzle A: a wrong-but-legal move exists').toBe(true);
    expect(Boolean(B.wrong), 'puzzle B: a wrong-but-legal move exists').toBe(true);
    for (const [name, p] of [['A', A], ['B', B]]) {
      console.log(
        `puzzle ${name}: ${p.id} (rating ${p.rating}, ${p.fen.split(' ')[1] === 'w' ? 'white' : 'black'} ` +
          `to play): solution ${p.solution.join(' ')}, wrong ${p.wrong.uci}`,
      );
    }

    /* ============================================== puzzle A: auto-retry */
    await openPuzzle(A);

    // Precondition for the ring check: the board frame really is a width that
    // isn't a multiple of 8, or step 5 passes for the wrong reason.
    const frameW = await page.evaluate(() => document.querySelector('.cg-wrap').getBoundingClientRect().width);
    console.log(`board frame width ${frameW}px (mod 8 = ${frameW % 8})`);
    expect(frameW % 8 !== 0, `board frame ${frameW}px is not a multiple of 8`).toBe(true);

    // --- 1: pre-mistake.
    expect(await buttonByText('Hint').count(), 'Hint visible pre-mistake').toBeAtLeast(1);
    expect(await buttonByText('Reveal').count(), 'Reveal hidden pre-mistake').toBe(0);
    expect(await buttonByText('Try again').count(), 'no Try again button').toBe(0);
    expect(await buttonByText('Restart').count(), 'Restart hidden pre-mistake').toBe(0);

    // --- 2: wrong-but-legal move.
    await dragSquares(A.wrong.from, A.wrong.to);
    await page.waitForSelector('text=/Not quite/', { timeout: 5_000 });

    const statusText = await page.locator('text=/Not quite/').first().innerText();
    expect(statusText.includes('Not quite'), 'Not quite copy shown').toBe(true);
    expect(await buttonByText('Try again').count(), 'still no Try again button').toBe(0);

    // --- 3: board still interactive, and the wrong move was snapped back.
    const manipulable = await page.evaluate(() =>
      document.querySelector('.cg-wrap').classList.contains('manipulable'),
    );
    expect(manipulable, 'board still manipulable after wrong move').toBe(true);
    await waitForPosition(A.fen, 'wrong move reverted');

    // --- 4: Hint + Reveal both offered after the mistake.
    expect(await buttonByText('Hint').count(), 'Hint visible post-mistake').toBeAtLeast(1);
    expect(await buttonByText('Reveal').count(), 'Reveal visible post-mistake').toBeAtLeast(1);

    // --- 5: hint ring centred on the solution's from-square.
    await buttonByText('Hint').first().click();
    await sleep(300);

    const want = await squareCenter(A.solution[0].slice(0, 2));
    const ring = await page.evaluate(() => {
      const wrap = document.querySelector('.cg-wrap');
      const overlayRoot = wrap.parentElement;
      const rings = Array.from(overlayRoot.querySelectorAll('div[style*="border-radius"]'));
      if (rings.length === 0) return { rings: 0 };
      const r = rings[0].getBoundingClientRect();
      return { rings: rings.length, gotX: r.left + r.width / 2, gotY: r.top + r.height / 2 };
    });
    expect(ring.rings, 'hint ring count').toBeAtLeast(1);
    const dx = ring.gotX - want.x;
    const dy = ring.gotY - want.y;
    expect(Math.abs(dx), `hint dx (${dx})`).toBeAtMost(1.5);
    expect(Math.abs(dy), `hint dy (${dy})`).toBeAtMost(1.5);

    // --- 6: the correct line completes the puzzle.
    await playFrom(A, 0, new Chess(A.fen));
    await page.waitForSelector('text=Solved!', { timeout: 10_000 });

    // Themes are revealed only after completion — before it they would give
    // the answer away. Assert the reveal actually happened.
    const themesShown = /themes/i.test(
      await page.evaluate(() => document.querySelector('aside')?.innerText ?? ''),
    );
    expect(themesShown, 'themes revealed after solving').toBe(true);

    const rowA = await storedRow(A.id);
    console.log(`puzzle A row: ${JSON.stringify({ ...rowA, fen: undefined })}`);
    expect(rowA.attempts, 'A: attempt count').toBe(1);
    // We deliberately used a hint, so this must NOT count as a clean solve —
    // the anti-laundering rule in `recordAttempt`.
    expect(rowA.hintUsed, 'A: hint recorded').toBe(true);
    expect(rowA.solvedClean, 'A: hinted solve is not clean').toBe(false);
    expect(rowA.history?.[0]?.outcome, 'A: history[0].outcome').toBe('hint');
    expect(rowA.history[0].bad, 'A: the wrong move is counted').toBe(1);

    /* ===================================== puzzle B: Restart can't launder */
    await openPuzzle(B);

    await dragSquares(B.wrong.from, B.wrong.to);
    await page.waitForSelector('text=/Not quite/', { timeout: 5_000 });
    await waitForPosition(B.fen, 'B: wrong move reverted');

    // Correct first move; wait for the reply so Restart is on offer.
    await playFrom({ ...B, solution: B.solution.slice(0, 2) }, 0, new Chess(B.fen));
    const restart = buttonByText('Restart');
    await restart.first().waitFor({ timeout: 5_000 });
    await restart.first().click();
    await waitForPosition(B.fen, 'B: Restart returned to the start');

    // The whole line, with no mistake this time.
    await playFrom(B, 0, new Chess(B.fen));
    await page.waitForSelector('text=Solved!', { timeout: 10_000 });

    const rowB = await storedRow(B.id);
    const userMovesB = Math.ceil(B.solution.length / 2);
    console.log(`puzzle B row: ${JSON.stringify({ ...rowB, fen: undefined })}`);
    expect(rowB.attempts, 'B: attempt count').toBe(1);
    expect(rowB.hintUsed, 'B: no hint').toBe(false);
    expect(rowB.history?.[0]?.outcome, 'B: history[0].outcome after wrong move + Restart').toBe(
      'mistake',
    );
    expect(rowB.solvedClean, 'B: wrong move then Restart is not a clean solve').toBe(false);
    expect(rowB.history[0].bad, 'B: wrong move survives Restart').toBe(1);
    // The first correct move before Restart counts too: tallies are over the
    // whole attempt, restarts included.
    expect(rowB.history[0].good, 'B: correct moves over the whole attempt').toBe(userMovesB + 1);
    // The rail must not claim this was clean: a missed puzzle says it is
    // headed for Review.
    expect(
      /comes back in Review/i.test(
        await page.evaluate(() => document.querySelector('aside')?.innerText ?? ''),
      ),
      'B: rail says the puzzle goes to Review',
    ).toBe(true);

    // Surface anything beyond the known placeholder-Clerk noise (TESTING.md
    // § Running the browser tiers), so a new page error is visible in a
    // green run instead of hiding in the "non-fatal page logs" count.
    const unexpected = errors.filter((e) => !/clerk|ERR_CONNECTION_REFUSED|Failed to load resource/i.test(e));
    if (unexpected.length) console.log('unexpected page logs:', JSON.stringify(unexpected));
  },
});
