// Integration coverage for the rebuilt Puzzles page.
//
// Three things this pins, all of which are only observable in a real browser:
//
//   1. **Shards actually load.** Every tier tab must fetch its shard over
//      HTTP, decode the TSV + base36 theme codes, and render a legal
//      position. A CORP/COEP misconfiguration or a stale build hash shows up
//      here as an empty tab.
//
//   2. **Recommended reflects RECENT mistakes.** We seed two synthetic
//      analyzed games — a fork blunder 3 days ago and a pin blunder 130 days
//      ago — and assert the Recommended tab ranks fork far above pin. This is
//      the end-to-end version of the decay maths in `recommend.test.ts`: it
//      goes through Dexie, `buildMistakes`, the motif→theme mapping, and the
//      shard query, so it catches a break anywhere along that chain.
//
//   3. **The no-spoiler rule.** A puzzle's themes must NOT be in the DOM
//      before it's solved (the theme is the answer), and must appear after.
//
// Run: node scripts/run-tests.mjs --only=puzzle-library

import { runBrowserTest, expect, sleep, appendBypass } from '../harness.mjs';

const DAY = 86_400_000;

await runBrowserTest({
  name: 'puzzle-library',
  waitUntil: 'domcontentloaded',
  skipInitialGoto: true,
  async run({ page }) {
    // Boot once at the root so the bypass session + Dexie exist before we seed.
    await page.goto(appendBypass('http://localhost:5173/'), {
      waitUntil: 'domcontentloaded',
    });
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
    await page.evaluate(async () => {
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
      });
    });

    // Fresh document so the boot passes re-read settings and see the stamp.
    await page.goto(appendBypass('http://localhost:5173/puzzles'), {
      waitUntil: 'domcontentloaded',
    });
    await page.waitForSelector('[role="tab"]', { timeout: 15_000 });

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

    /* ------------------------------------------------ tier tabs load shards */
    // Reload so `useRecommendation` starts from a DB that already holds the
    // seeded games, rather than depending on live-query timing. Boot passes
    // re-run here too, and skip thanks to the stamps above.
    await page.goto(appendBypass('http://localhost:5173/puzzles'), {
      waitUntil: 'domcontentloaded',
    });
    await page.waitForSelector('[role="tab"]', { timeout: 15_000 });

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

    const tabs = await page.locator('[role="tab"]').allInnerTexts();
    expect(tabs.length, 'five tabs rendered').toBe(5);
    console.log('tabs:', JSON.stringify(tabs));

    for (const tier of ['Easy', 'Medium', 'Hard', 'All']) {
      await page.locator('[role="tab"]', { hasText: new RegExp(`^\\s*${tier}`) }).first().click();
      // Wait for a board with pieces on it. A bare `.cg-wrap` wait would be
      // satisfied by the previous tab's board, which is still mounted.
      await page.waitForFunction(
        () => document.querySelectorAll('cg-board piece').length > 2,
        undefined,
        { timeout: 15_000 },
      );
      await sleep(600);

      const state = await page.evaluate(() => {
        const rail = document.body.innerText;
        const ratingMatch = rail.match(/Rating (\d+)/);
        return {
          hasBoard: Boolean(document.querySelector('cg-container')),
          pieces: document.querySelectorAll('cg-board piece').length,
          rating: ratingMatch ? Number(ratingMatch[1]) : null,
          // Themes must be absent pre-solve.
          themesShown: /themes/i.test(rail),
        };
      });

      expect(state.hasBoard, `${tier}: board rendered`).toBe(true);
      expect(state.pieces, `${tier}: pieces on board`).toBeAtLeast(3);
      expect(state.rating, `${tier}: rating shown`).toBeAtLeast(1);
      expect(state.themesShown, `${tier}: themes hidden before solving`).toBe(false);
      console.log(`${tier}: board ok, ${state.pieces} pieces, rating ${state.rating}`);
    }

    /* --------------------------------------------- tier ranges are ordered */
    const ranges = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[role="tab"]')).map((el) => el.innerText),
    );
    // Easy's range must sit below Hard's — a sanity check that the manifest
    // drives the labels rather than them being hard-coded.
    const nums = (s) => (s.match(/(\d+)-(\d+)/) ?? []).slice(1).map(Number);
    const easy = nums(ranges[1]);
    const hard = nums(ranges[3]);
    expect(easy[1], `easy max (${easy[1]}) below hard min (${hard[0]})`).toBeAtMost(hard[0]);

    /* ------------------------------------------------- Recommended ranking */
    await page.locator('[role="tab"]', { hasText: /^\s*Recommended/ }).first().click();
    await sleep(1800);

    const rec = await page.evaluate(() => {
      const text = document.body.innerText;
      const chips = Array.from(document.querySelectorAll('span[title]'))
        .map((el) => el.innerText.trim())
        .filter((s) => /%$/.test(s));
      return {
        // Case-insensitive: the heading carries a `uppercase` CSS class, and
        // `innerText` reports text as *rendered*, so a case-sensitive match
        // against the source string silently fails.
        matched: /matched to your recent mistakes/i.test(text),
        chips,
        sessionNote: (text.match(/Targeting:[^\n]+/i) ?? [null])[0],
        hasBoard: Boolean(document.querySelector('cg-container')),
        themesShown: /themes/i.test(text),
      };
    });

    console.log('recommended chips:', JSON.stringify(rec.chips));
    console.log('session note:', rec.sessionNote);

    expect(rec.matched, 'matched-to summary shown').toBe(true);
    expect(rec.chips.length, 'at least one motif chip').toBeAtLeast(1);
    expect(rec.hasBoard, 'recommended rendered a board').toBe(true);
    expect(rec.themesShown, 'themes hidden before solving (recommended)').toBe(false);

    // The decisive assertion: fork (4 mistakes, 3 days old) must outrank pin
    // (10 mistakes, 130 days old). Without recency decay, pin would win.
    // JSON-encode in the messages below: chip innerText contains a newline
    // between the label and the percentage, which silently truncates a raw
    // interpolation in CI logs (it did — the first failure was unreadable).
    const forkChip = rec.chips.find((c) => /fork/i.test(c));
    const pinChip = rec.chips.find((c) => /^pin/i.test(c));
    expect(
      Boolean(forkChip),
      `fork chip present (chips=${JSON.stringify(rec.chips)})`,
    ).toBe(true);
    const pct = (c) => Number((c.match(/(\d+)%/) ?? [0, 0])[1]);
    if (pinChip) {
      expect(
        pct(forkChip),
        `fork ${pct(forkChip)}% must outrank stale pin ${pct(pinChip)}%`,
      ).toBeAtLeast(pct(pinChip) + 1);
    }
    // 130 days ≈ 4.3 half-lives, so pin should fall under the 5% floor and be
    // dropped entirely — the strongest form of the assertion.
    expect(pct(forkChip), 'fork dominates the plan').toBeAtLeast(80);

    /* ----------------------------------- solve one puzzle end to end (Easy) */
    const target = await page.evaluate(async () => {
      const { PUZZLE_SHARDS } = await import('/src/data/puzzles.meta.generated.ts');
      const { shardUrl, parseShard } = await import('/src/features/puzzles/corpus.ts');
      const res = await fetch(shardUrl(PUZZLE_SHARDS[0]));
      const rows = parseShard(await res.text());
      return rows[0];
    });
    expect(Boolean(target?.id), 'read first easy puzzle').toBe(true);

    await page.locator('[role="tab"]', { hasText: /^\s*Easy/ }).first().click();
    // Wait for THIS puzzle, not just for any board.
    //
    // `waitForSelector('.cg-wrap')` is useless after a tab switch: the
    // previous tab's board is still in the DOM, so the selector resolves
    // immediately and the subsequent drag lands on a board that is about to be
    // replaced. Waiting on the target puzzle's own rating ties the wait to the
    // thing we're about to interact with.
    await page.waitForFunction(
      (rating) => new RegExp(`Rating ${rating}\\b`).test(document.body.innerText),
      target.rating,
      { timeout: 15_000 },
    );
    await sleep(600);

    // Play the solution with real drags via chessground coordinates.
    async function drag(from, to) {
      const at = (sq) =>
        page.evaluate((s) => {
          const c = document.querySelector('cg-container').getBoundingClientRect();
          const orientation = document.querySelector('.cg-wrap.orientation-black')
            ? 'black'
            : 'white';
          const f = s.charCodeAt(0) - 97;
          const r = Number(s[1]) - 1;
          const bf = orientation === 'white' ? f : 7 - f;
          const br = orientation === 'white' ? 7 - r : r;
          const sw = c.width / 8;
          const sh = c.height / 8;
          return { x: c.left + bf * sw + sw / 2, y: c.top + br * sh + sh / 2 };
        }, sq);
      const a = await at(from);
      const b = await at(to);
      await page.mouse.move(a.x, a.y);
      await page.mouse.down();
      await page.mouse.move(b.x, b.y, { steps: 6 });
      await page.mouse.up();
    }

    for (let i = 0; i < target.solution.length; i += 2) {
      const uci = target.solution[i];
      await drag(uci.slice(0, 2), uci.slice(2, 4));
      await sleep(900); // allow the auto-played opponent reply to land
    }

    const after = await page.evaluate(async (id) => {
      const { db } = await import('/src/db/schema.ts');
      const row = await db.puzzleAttempts.get(id);
      const text = document.body.innerText;
      return {
        solvedShown: /Solved!/.test(text),
        themesShown: /themes/i.test(text),
        attempt: row
          ? { attempts: row.attempts, solvedClean: row.solvedClean, rating: row.rating }
          : null,
      };
    }, target.id);

    expect(after.solvedShown, 'solved status shown').toBe(true);
    // The reveal side of the no-spoiler rule.
    expect(after.themesShown, 'themes revealed after solving').toBe(true);
    expect(Boolean(after.attempt), 'attempt persisted to Dexie').toBe(true);
    expect(after.attempt.attempts, 'attempt count').toBe(1);
    expect(after.attempt.solvedClean, 'first-try no-hint solve is clean').toBe(true);
    expect(after.attempt.rating, 'attempt rating denormalized').toBe(target.rating);

    console.log('solved', target.id, JSON.stringify(after.attempt));
  },
});
