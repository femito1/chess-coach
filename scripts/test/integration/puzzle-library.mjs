// Integration coverage for the Puzzles page: Train / Review / Progress.
//
// The page serves the bundled Lichess corpus (static TSV shards under
// `public/puzzles/<buildId>/`) through three views, picked from a three-button
// tab bar. Train draws RANDOM unattempted puzzles from a window around your
// puzzle rating, so nothing a test sees there is predictable; anything that
// needs a known puzzle opens it through the deep link
// `/puzzles?puzzle=<id>&rating=<n>`, reading the target straight out of a
// shard first so no id is hard-coded and a corpus refresh can't break it.
//
// What this pins, all of it only observable in a real browser:
//
//   1. **The view bar.** Exactly three tabs, and no scrollbar on the tablist.
//      The old five-tab bar was an `overflow-x-auto` row whose `-mb-px`
//      underline poked a pixel past it, which gave it a vertical scrollbar
//      that scrolled nothing. Headless Chromium draws no scrollbar gutter (see
//      TESTING.md § Traps), so the check is on the geometry, not a screenshot.
//
//   2. **Train loads shards.** A board with pieces, the puzzle's rating in the
//      rail, and that rating inside the window the Train bar says the run was
//      drawn from — the last is what ties "a board rendered" to "Train's own
//      query produced it" rather than to some fallback.
//
//   3. **"From your games" reflects RECENT mistakes.** We seed two synthetic
//      analyzed games — a fork blunder 3 days ago and a pin blunder 130 days
//      ago — and assert the plan ranks fork far above pin. This is the
//      end-to-end version of the decay maths in `recommend.test.ts`: it goes
//      through Dexie, `forEachAnalysis` + `mistakeRowsForGame`, the
//      motif→theme mapping, and the plan, so it catches a break anywhere
//      along that chain. The pin game has MORE mistakes, so a lifetime count
//      would rank it first; only the recency decay can pass this.
//
//   4. **The no-spoiler rule.** A puzzle's themes must NOT be in the rail
//      before it's solved (the theme is the answer), and must appear after.
//      Checked inside the rail (`aside`) only: the Train bar's own "Theme"
//      button and the theme picker legitimately say "theme".
//
//   5. **A solve is recorded honestly.** Deep-link one puzzle, assert the
//      board really is that puzzle's position (piece-for-piece against its
//      FEN, not just "a board"), play its solution with real drags, and check
//      the stored row: one attempt, `solvedClean`, and a `history[0]` of
//      outcome `clean` with the right move tallies, plus the puzzle content
//      (`fen`, `solution`, `themes`) the history grid and Review replay from.
//      The rail must then show the rating change ("Puzzle rating").
//
//   6. **Review serves a miss.** Seed one missed attempt from two days ago
//      (past the ~20 h first interval) carrying its own content, and assert
//      the Review tab's badge and "Due now" both count exactly it, and that
//      starting the review puts THAT position on the board. Exactly one, not
//      at-least-one: the clean solve from (5) must not be in Review.
//
//   7. **Progress re-opens a puzzle.** The history grid has a card for the
//      puzzle solved in (5); clicking it opens that position in the solver
//      with a "← Back to progress" button, and the button returns to the grid.
//
// Run: node scripts/run-tests.mjs --only=puzzle-library

import { Chess } from 'chess.js';
import { runBrowserTest, expect, pollUntil, sleep, appendBypass } from '../harness.mjs';

const DAY = 86_400_000;
const BASE = 'http://localhost:5173/';
const PUZZLES = appendBypass(`${BASE}puzzles`);

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

await runBrowserTest({
  name: 'puzzle-library',
  waitUntil: 'domcontentloaded',
  skipInitialGoto: true,
  async run({ page, errors }) {
    /* --------------------------------------------------------- helpers */

    /** The board as chessground has it drawn, same shape as `placementFromFen`.
     *  Read from each piece node's `cgKey`, skipping pieces fading out after a
     *  capture, so it matches the position the instant the move lands. */
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

    /** Text of the solver's rail — the only place the no-spoiler rule binds. */
    const railText = () =>
      page.evaluate(() => document.querySelector('aside')?.innerText ?? '');

    async function waitForRail(re, label) {
      try {
        await page.waitForFunction(
          (src) => new RegExp(src).test(document.querySelector('aside')?.innerText ?? ''),
          re.source,
          { timeout: 15_000 },
        );
      } catch {
        expect(await railText(), `${label} (rail text)`).toBe(`matching ${re}`);
      }
    }

    async function drag(from, to) {
      const at = (sq) =>
        page.evaluate((s) => {
          const c = document.querySelector('cg-container').getBoundingClientRect();
          const black = Boolean(document.querySelector('.cg-wrap.orientation-black'));
          const f = s.charCodeAt(0) - 97;
          const r = Number(s[1]) - 1;
          const bf = black ? 7 - f : f;
          const br = black ? r : 7 - r;
          return { x: c.left + (bf + 0.5) * (c.width / 8), y: c.top + (br + 0.5) * (c.height / 8) };
        }, sq);
      const a = await at(from);
      const b = await at(to);
      await page.mouse.move(a.x, a.y);
      await page.mouse.down();
      await page.mouse.move(b.x, b.y, { steps: 6 });
      await page.mouse.up();
    }

    /** Play a whole solution, waiting after each user move for the
     *  opponent's reply to actually be on the board (it lands on a
     *  550–1100 ms human-feeling delay) rather than sleeping a guess. */
    async function playSolution(puzzle) {
      const chess = new Chess(puzzle.fen);
      for (let i = 0; i < puzzle.solution.length; i += 2) {
        const uci = puzzle.solution[i];
        await drag(uci.slice(0, 2), uci.slice(2, 4));
        chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
        const reply = puzzle.solution[i + 1];
        if (reply) {
          chess.move({ from: reply.slice(0, 2), to: reply.slice(2, 4), promotion: reply[4] });
        }
        await waitForPosition(chess.fen(), `after solution ply ${i + 1}`);
      }
    }

    async function waitForTabs() {
      await page.waitForSelector('[role="tab"]', { timeout: 15_000 });
    }

    const tabByName = (name) =>
      page.locator('[role="tab"]', { hasText: new RegExp(`^\\s*${name}`) }).first();

    // Boot once at the root so the bypass session + Dexie exist before we seed.
    await page.goto(appendBypass(BASE), { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('a[href="/puzzles"]', { timeout: 15_000 });

    /* --------------------------------------------- disarm the boot passes */
    //
    // Order here is load-bearing; getting it wrong cost a red CI run.
    //
    // `recomputeClassificationsAndAccuracies` OWNS `MoveEval.motifs` — it
    // re-derives them from each move's stored FENs and evals on boot. Our
    // synthetic moves carry placeholder positions, so it rewrites the seeded
    // `fork` / `pin` motifs to `other`, and `scoreMotifs` drops `other`.
    // Observed as chips reading `["Walked into a pin\n100%"]` (the pass had
    // rewritten one game but not yet the other) or as no chips at all.
    //
    // Stamping the version markers is the documented way to skip the pass, but
    // stamping AFTER seeding does not work: the pass reads settings at mount,
    // so it is already past that check when the stamp lands, and then walks
    // whatever is in `games` — including rows seeded a moment later.
    //
    // So: clear and stamp FIRST, while `games` is still empty. A pass already in
    // flight then finds nothing to do (and per the empty-DB rule in
    // `recompute-skip`, does not stamp anything itself). THEN navigate — every
    // pass from that point reads the stamp and short-circuits — and only then
    // seed. Under CPU load: 5 failures in 8 before, 0 after.
    //
    // The three `chess-coach:puzzles.*` keys are the page's persisted view,
    // theme and difficulty. The context is ephemeral so they start empty
    // anyway; clearing them states the starting point (Train, Mixed, your
    // level) rather than inheriting it.
    await page.evaluate(async () => {
      for (const k of ['view', 'theme', 'difficulty']) {
        localStorage.removeItem(`chess-coach:puzzles.${k}:v1`);
      }
      const { db, updateSettings } = await import('/src/db/schema.ts');
      const q = await import('/src/db/queries.ts');
      await db.puzzleAttempts.clear();
      await db.games.clear();
      await db.analyses.clear();
      await updateSettings({
        username: 'tester',
        lastRecomputeVersion: q.RECOMPUTE_VERSION,
        lastOpeningRefreshVersion: q.OPENING_REFRESH_VERSION,
        lastUserTimeBackfillVersion: q.USER_TIME_BACKFILL_VERSION,
        lastBrilliantBackfillVersion: q.BRILLIANT_BACKFILL_VERSION,
        lastAccuracyBackfillVersion: q.ACCURACY_BACKFILL_VERSION,
      });
    });

    // Fresh document so the boot passes re-read settings and see the stamp.
    await page.goto(PUZZLES, { waitUntil: 'domcontentloaded' });
    await waitForTabs();

    /* ---------------------------------------------------------------- seed */
    const seeded = await page.evaluate(async (day) => {
      const { db } = await import('/src/db/schema.ts');
      const now = Date.now();

      // A blundery move by the user. `buildMistakes` only counts moves whose
      // ply parity matches `userColor`, so odd plies for white.
      const move = (ply, motifs) => ({
        ply,
        san: 'Qxh7',
        uci: 'd1h7',
        fenBefore: 'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5Q2/PPPP1PPP/RNB1K1NR w KQkq - 0 4',
        fenAfter: 'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5Q2/PPPP1PPP/RNB1K1NR b KQkq - 0 4',
        evalCpBefore: 50,
        evalCpAfter: -450,
        winrateBefore: 0.55,
        winrateAfter: 0.1,
        bestMoveUci: 'e1g1',
        bestMoveSan: 'O-O',
        classification: 'blunder',
        depth: 16,
        phase: 'middlegame',
        motifs,
      });

      async function seedGame(id, daysAgo, motifs, count) {
        await db.games.put({
          id,
          url: `https://example.com/${id}`,
          source: 'chesscom',
          username: 'tester',
          userColor: 'white',
          opponent: 'opp',
          userRating: 1500,
          result: 'loss',
          timeControl: '600',
          timeClass: 'rapid',
          endTime: now - daysAgo * day,
          pgn: '1. e4 e5 2. Bc4 Nc6 3. Qf3 Nf6 4. Qxh7',
          importedAt: now,
          analysisStatus: 'done',
        });
        await db.analyses.put({
          gameId: id,
          depth: 16,
          analyzedAt: now,
          engine: 'stockfish-16',
          moves: Array.from({ length: count }, (_, i) => move(i * 2 + 1, motifs)),
        });
      }

      // Recent fork mistakes vs stale pin mistakes. The pin game has MORE
      // mistakes on purpose: a lifetime count would rank pin first, so this
      // only passes if the recency decay is actually applied.
      await seedGame('recent-forks', 3, ['fork'], 4);
      await seedGame('old-pins', 130, ['pin'], 10);

      return {
        games: await db.games.count(),
        analyses: await db.analyses.count(),
      };
    }, DAY);

    expect(seeded.games, 'games seeded').toBe(2);
    expect(seeded.analyses, 'analyses seeded').toBe(2);

    // Reload so the "From your games" plan starts from a DB that already
    // holds the seeded games, rather than depending on live-query timing.
    // Boot passes re-run here too, and skip thanks to the stamps above.
    await page.goto(PUZZLES, { waitUntil: 'domcontentloaded' });
    await waitForTabs();

    // Guard: the seeded motifs must have survived. Without this, a regression
    // in the disarming above resurfaces as a confusing "no fork chip" failure
    // instead of naming its own cause.
    const motifsIntact = await page.evaluate(async () => {
      const { db } = await import('/src/db/schema.ts');
      const rows = await db.analyses.toArray();
      return rows
        .map((a) => `${a.gameId}=${[...new Set(a.moves.flatMap((m) => m.motifs ?? []))].join('+')}`)
        .sort()
        .join(' ');
    });
    expect(
      motifsIntact,
      'seeded motifs survived the boot passes (if this reads "other", the ' +
        'recompute pass ran over the synthetic analyses — see the note above)',
    ).toBe('old-pins=pin recent-forks=fork');

    /* ------------------------------------------------------- 1. view bar */
    const bar = await page.evaluate(() => {
      const list = document.querySelector('[role="tablist"]');
      const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
      return {
        labels: tabs.map((t) => t.innerText.trim()),
        selected: tabs.filter((t) => t.getAttribute('aria-selected') === 'true').map((t) => t.innerText.trim()),
        scrollH: list?.scrollHeight ?? -1,
        clientH: list?.clientHeight ?? -1,
        scrollW: list?.scrollWidth ?? -1,
        clientW: list?.clientWidth ?? -1,
      };
    });
    console.log('view bar:', JSON.stringify(bar));
    expect(bar.labels, 'three view tabs').toEqual(['Train', 'Review', 'Progress']);
    expect(bar.selected, 'Train selected by default').toEqual(['Train']);
    expect(
      bar.scrollH,
      `tablist has no vertical overflow (scrollHeight ${bar.scrollH} vs clientHeight ${bar.clientH})`,
    ).toBeAtMost(bar.clientH);
    expect(
      bar.scrollW,
      `tablist has no horizontal overflow (scrollWidth ${bar.scrollW} vs clientWidth ${bar.clientW})`,
    ).toBeAtMost(bar.clientW);

    /* ------------------------------------------------ 2. Train, Mixed theme */
    // No previous board exists on this fresh document, so "pieces on a board"
    // can only be Train's first puzzle.
    await page.waitForFunction(
      () => document.querySelectorAll('cg-board piece').length > 2,
      undefined,
      { timeout: 20_000 },
    );
    await waitForRail(/Rating \d+/, 'train: puzzle rating in rail');
    const train = await page.evaluate(() => {
      const rail = document.querySelector('aside')?.innerText ?? '';
      const win = (document.body.innerText.match(/Rated (\d+)–(\d+)/) ?? []).slice(1).map(Number);
      return {
        pieces: document.querySelectorAll('cg-board piece').length,
        rating: Number((rail.match(/Rating (\d+)/) ?? [])[1]),
        win,
        themesShown: /themes/i.test(rail),
        solvedShown: /Solved!/.test(rail),
      };
    });
    console.log('train:', JSON.stringify(train));
    expect(train.pieces, 'train: pieces on board').toBeAtLeast(3);
    expect(train.rating, 'train: rating shown').toBeAtLeast(1);
    expect(train.win.length, 'train: draw window shown in the Train bar').toBe(2);
    expect(train.rating, `train: rating inside window ${train.win.join('–')}`).toBeAtLeast(train.win[0]);
    expect(train.rating, `train: rating inside window ${train.win.join('–')}`).toBeAtMost(train.win[1]);
    expect(train.themesShown, 'train: themes hidden before solving').toBe(false);

    /* ------------------------------------- 3. "From your games" ranking */
    // Through the real picker: Theme button, then the "From your games" chip.
    await page.locator('button[aria-expanded]', { hasText: /Theme/ }).first().click();
    await page.locator('button', { hasText: /^\s*From your games\s*$/ }).first().click();

    // Wait on the summary itself — the plan streams every seeded analysis
    // through a throttled live query, so a fixed sleep was a guess (and the
    // documented flake of this test was a sleep that lost that race).
    // Case-insensitive: the heading has a `uppercase` class and `innerText`
    // reports text as rendered.
    try {
      await page.waitForFunction(
        () => /matched to your recent mistakes/i.test(document.body.innerText),
        undefined,
        { timeout: 20_000 },
      );
    } catch {
      /* fall through to the assertion, which names the cause */
    }
    await page.waitForFunction(
      () => document.querySelectorAll('cg-board piece').length > 2,
      undefined,
      { timeout: 20_000 },
    ).catch(() => {});

    const rec = await page.evaluate(() => {
      const text = document.body.innerText;
      const chips = Array.from(document.querySelectorAll('span[title]'))
        .map((el) => el.innerText.trim())
        .filter((s) => /%$/.test(s));
      return {
        matched: /matched to your recent mistakes/i.test(text),
        chips,
        sessionNote: (text.match(/Targeting:[^\n]+/i) ?? [null])[0],
        hasBoard: Boolean(document.querySelector('cg-container')),
        themesShown: /themes/i.test(document.querySelector('aside')?.innerText ?? ''),
        persistedTheme: localStorage.getItem('chess-coach:puzzles.theme:v1'),
      };
    });

    console.log('from-your-games chips:', JSON.stringify(rec.chips));
    console.log('session note:', rec.sessionNote);

    expect(rec.persistedTheme, 'theme choice persisted').toBe('"foryou"');
    expect(rec.matched, 'matched-to summary shown').toBe(true);
    expect(rec.chips.length, 'at least one motif chip').toBeAtLeast(1);
    expect(rec.hasBoard, 'from-your-games rendered a board').toBe(true);
    expect(rec.themesShown, 'themes hidden before solving (from your games)').toBe(false);

    // The decisive assertion: fork (4 mistakes, 3 days old) must outrank pin
    // (10 mistakes, 130 days old). Without recency decay, pin would win.
    // JSON-encode in the messages below: chip innerText contains a newline
    // between the label and the percentage, which silently truncates a raw
    // interpolation in CI logs (it did — the first failure was unreadable).
    const forkChip = rec.chips.find((c) => /fork/i.test(c));
    const pinChip = rec.chips.find((c) => /pin/i.test(c));
    expect(Boolean(forkChip), `fork chip present (chips=${JSON.stringify(rec.chips)})`).toBe(true);
    const pct = (c) => Number((c.match(/(\d+)%/) ?? [0, 0])[1]);
    if (pinChip) {
      expect(
        pct(forkChip),
        `fork ${pct(forkChip)}% must outrank stale pin ${pct(pinChip)}%`,
      ).toBeAtLeast(pct(pinChip) + 1);
    }
    // 130 days ≈ 4.3 half-lives, so each pin mistake weighs ~5% of a fresh
    // one: 10 of them come to ~0.5 against the forks' ~3.7, which puts fork
    // near 88% and pin near 12% (observed exactly that). Without the decay it
    // would be 29% / 71% the other way round, so 80% has wide margin on both
    // sides.
    expect(pct(forkChip), 'fork dominates the plan').toBeAtLeast(80);

    /* --------------------------------- 4–5. deep-link solve, end to end */
    // Two known puzzles from the first shard: one to solve, one to seed as a
    // miss for Review. The one to solve has at least two user moves, so the
    // solve goes through the solver's two-phase opponent reply rather than
    // ending on the first drag. Skip any whose user moves promote — a
    // promotion opens a piece picker that a plain drag doesn't answer.
    const picks = await page.evaluate(async () => {
      const { PUZZLE_SHARDS } = await import('/src/data/puzzles.meta.generated.ts');
      const { shardUrl, parseShard } = await import('/src/features/puzzles/corpus.ts');
      const res = await fetch(shardUrl(PUZZLE_SHARDS[0]));
      const rows = parseShard(await res.text());
      const plain = rows.filter((p) => p.solution.every((u, i) => i % 2 === 1 || u.length === 4));
      const solve = plain.find((p) => p.solution.length >= 3);
      return { solve, miss: plain.find((p) => p.id !== solve?.id) };
    });
    const target = picks.solve;
    const missed = picks.miss;
    expect(Boolean(target?.id && missed?.id), 'read two puzzles from shard 0').toBe(true);
    expect(target.id !== missed.id, 'solve and miss puzzles differ').toBe(true);
    console.log(
      `solve target ${target.id} (rating ${target.rating}, ${target.solution.length} plies); ` +
        `review seed ${missed.id} (rating ${missed.rating})`,
    );

    await page.goto(
      appendBypass(`${BASE}puzzles?puzzle=${target.id}&rating=${target.rating}`),
      { waitUntil: 'domcontentloaded' },
    );
    // The theme persisted as "From your games", so a random Train puzzle can
    // render before the deep link resolves. Tie every wait to THIS puzzle:
    // the single-puzzle back button, its rating, and its exact position.
    await page.waitForSelector('button:has-text("Back to training")', { timeout: 15_000 });
    await waitForRail(new RegExp(`Rating ${target.rating}\\b`), 'deep link: target rating');
    await waitForPosition(target.fen, 'deep link');
    expect(/themes/i.test(await railText()), 'deep link: themes hidden before solving').toBe(false);

    await playSolution(target);
    await page.waitForSelector('text=Solved!', { timeout: 10_000 });
    // The rating change lands a beat after the solve (after the row is
    // written), so wait on it rather than reading the rail once.
    await waitForRail(/Puzzle rating/i, 'solve: rating change shown in rail');

    const userMoves = Math.ceil(target.solution.length / 2);
    const row = await pollUntil(
      async () => {
        const r = await page.evaluate(async (id) => {
          const { db } = await import('/src/db/schema.ts');
          return (await db.puzzleAttempts.get(id)) ?? null;
        }, target.id);
        return { done: Boolean(r), value: r, label: r ? 'row written' : 'waiting for row' };
      },
      { timeoutMs: 10_000, intervalMs: 200 },
    );
    const after = await page.evaluate(() => {
      const rail = document.querySelector('aside')?.innerText ?? '';
      return {
        rail,
        solvedShown: /Solved!/.test(document.body.innerText),
        themesShown: /themes/i.test(rail),
        lichessHref: document.querySelector('aside a[href*="lichess.org/training/"]')?.getAttribute('href') ?? null,
      };
    });
    console.log('solved row:', JSON.stringify({ ...row, fen: row.fen && '…' }));

    expect(after.solvedShown, 'solved status shown').toBe(true);
    // The reveal side of the no-spoiler rule.
    expect(after.themesShown, 'themes revealed after solving').toBe(true);
    expect(after.lichessHref, 'rail links to this puzzle').toBe(`https://lichess.org/training/${target.id}`);
    expect(/Puzzle rating\s*\d+\s*[+−-]?\d+/i.test(after.rail), `rating change reads "Puzzle rating <n> <delta>" (rail=${JSON.stringify(after.rail)})`).toBe(true);
    expect(row.attempts, 'attempt count').toBe(1);
    expect(row.solvedClean, 'first-try no-hint solve is clean').toBe(true);
    expect(row.hintUsed, 'no hint recorded').toBe(false);
    expect(row.rating, 'attempt rating denormalized').toBe(target.rating);
    expect(row.history?.length, 'one history event').toBe(1);
    expect(row.history[0].outcome, 'history[0].outcome').toBe('clean');
    expect(row.history[0].good, 'history[0].good = user moves played').toBe(userMoves);
    expect(row.history[0].bad, 'history[0].bad').toBe(0);
    expect(row.fen, 'puzzle fen stored on the row').toBe(target.fen);
    expect(row.solution, 'puzzle solution stored on the row').toEqual(target.solution);
    expect(row.themes, 'puzzle themes stored on the row').toEqual(target.themes);

    /* ------------------------------------------------------- 6. Review */
    // A miss two days old: past the 20 h first interval, so due now. It
    // carries its content like any row recorded today, so Review serves it
    // from the row without fetching a shard.
    await page.evaluate(async ({ p, day }) => {
      const { db } = await import('/src/db/schema.ts');
      const at = Date.now() - 2 * day;
      await db.puzzleAttempts.put({
        puzzleId: p.id,
        rating: p.rating,
        firstSeenAt: at,
        lastAttemptedAt: at,
        attempts: 1,
        solvedClean: false,
        hintUsed: false,
        msTaken: 30_000,
        history: [{ at, outcome: 'mistake', ms: 30_000, good: 0, bad: 1 }],
        fen: p.fen,
        solution: p.solution,
        themes: p.themes,
      });
    }, { p: missed, day: DAY });

    // The badge reads a throttled live query; wait for it to count the seed.
    try {
      await page.waitForFunction(
        () => {
          const tab = Array.from(document.querySelectorAll('[role="tab"]')).find((t) =>
            /^\s*Review/.test(t.innerText),
          );
          return tab?.querySelector('span')?.innerText.trim() === '1';
        },
        undefined,
        { timeout: 10_000 },
      );
    } catch {
      /* the assertion below names it */
    }
    const badge = await tabByName('Review').locator('span').allInnerTexts();
    expect(badge, 'Review tab badge counts the one due miss').toEqual(['1']);

    await tabByName('Review').click();
    await page.waitForSelector('text=Due now', { timeout: 10_000 });
    const overview = await page.evaluate(() => {
      const count = (label) => {
        const el = Array.from(document.querySelectorAll('div')).find(
          (d) => d.children.length === 0 && d.innerText.trim() === label,
        );
        return el ? Number(el.previousElementSibling?.innerText) : null;
      };
      return { due: count('Due now'), later: count('Coming up'), learned: count('Learned') };
    });
    console.log('review overview:', JSON.stringify(overview));
    expect(overview.due, 'Due now').toBe(1);
    expect(overview.later, 'Coming up').toBe(0);
    expect(overview.learned, 'Learned').toBe(0);

    await page.locator('button', { hasText: /^\s*Review 1 puzzle\s*$/ }).click();
    await waitForRail(new RegExp(`Rating ${missed.rating}\\b`), 'review: seeded puzzle rating');
    await waitForRail(/\b1\/1\b/, 'review: run position 1/1');
    await waitForPosition(missed.fen, 'review');
    expect(/themes/i.test(await railText()), 'review: themes hidden before solving').toBe(false);

    /* ----------------------------------------------------- 7. Progress */
    await tabByName('Progress').click();
    const card = page.locator(`button[data-puzzle-id="${target.id}"]`);
    await card.waitFor({ timeout: 10_000 });
    const progress = await page.evaluate(() => ({
      cards: Array.from(document.querySelectorAll('button[data-puzzle-id]')).map((b) =>
        b.getAttribute('data-puzzle-id'),
      ),
      tiles: /First-try success/.test(document.body.innerText),
      themeTable: /Strengths and weaknesses/.test(document.body.innerText),
    }));
    console.log('progress cards:', JSON.stringify(progress.cards));
    expect(progress.tiles, 'progress: stat tiles rendered').toBe(true);
    expect(progress.themeTable, 'progress: theme table rendered').toBe(true);
    expect([...progress.cards].sort(), 'progress: one card per attempted puzzle').toEqual(
      [target.id, missed.id].sort(),
    );

    await card.click();
    await page.waitForSelector('button:has-text("Back to progress")', { timeout: 10_000 });
    await waitForRail(new RegExp(`Rating ${target.rating}\\b`), 'progress replay: target rating');
    await waitForPosition(target.fen, 'progress replay');
    expect(
      await page.locator('button[data-puzzle-id]').count(),
      'history grid hidden while replaying',
    ).toBe(0);

    await page.locator('button', { hasText: 'Back to progress' }).first().click();
    await card.waitFor({ timeout: 10_000 });
    expect(
      await page.locator('button:has-text("Back to progress")').count(),
      'back button gone after returning',
    ).toBe(0);
    const selected = await page
      .locator('[role="tab"][aria-selected="true"]')
      .allInnerTexts();
    expect(selected.map((s) => s.trim()), 'Progress tab selected after returning').toEqual(['Progress']);

    // Surface anything beyond the known placeholder-Clerk noise (TESTING.md
    // § Running the browser tiers), so a new page error is visible in a
    // green run instead of hiding in the "non-fatal page logs" count.
    const unexpected = errors.filter((e) => !/clerk|ERR_CONNECTION_REFUSED|Failed to load resource/i.test(e));
    if (unexpected.length) console.log('unexpected page logs:', JSON.stringify(unexpected));
  },
});
