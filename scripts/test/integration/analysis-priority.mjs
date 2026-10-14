// Does the game you are LOOKING AT get analyzed next?
//
// The queue is otherwise strictly newest-first (`nextPendingGame` walks the
// `endTime` index in reverse). That is the right default — you usually care about
// the game you just played — but it makes opening an *older* unanalyzed game a
// wait behind every newer pending one. On a fresh import of a few hundred games
// that is minutes, for a review that takes ~10 s on its own.
//
// `requestAnalysisNow(gameId)` fixes it, and this pins the three things that have
// to be true for it to be a fix rather than a hazard:
//
//   1. **The requested game is analyzed before newer pending ones.** The actual
//      behaviour, and the only assertion that would notice if the priority list
//      were ignored.
//
//   2. **A preempted game is left `pending`, never `error`.** The analyzer throws
//      `aborted` when its signal trips, and the queue's catch would otherwise
//      record that as an analysis failure — surfacing a scary "analysis failed"
//      on a game whose analysis we cancelled on purpose, which `requeueStaleErrors`
//      would then have to undo.
//
//   3. **Requesting the game already in flight does nothing.** The review page
//      re-runs its effect on every relevant re-render, so if a request for the
//      in-flight game preempted it, the game the user is staring at would abort
//      and restart forever and never finish. This is the assertion that stops a
//      livelock.
//
//   4. **The chooser asks about the analysis row, not just the status.** An
//      `error` game is dropped (re-choosing it was a tight retry loop), and a
//      `done` game with no analysis row — which the review page requests on
//      purpose — is analyzed rather than discarded.
//
// Run: node scripts/run-tests.mjs --only=analysis-priority

import { runBrowserTest, expect, appendBypass } from '../harness.mjs';

// Short games so the test is about ordering, not engine throughput.
const PGN = `[Event "T"]
[Site "?"]
[Date "2024.01.01"]
[Round "-"]
[White "me"]
[Black "opp"]
[Result "1-0"]
[TimeControl "600"]

1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 b5 5. Bb3 Nf6 6. Ng5 d5 7. exd5 Nd4 1-0
`;

await runBrowserTest({
  name: 'analysis-priority',
  waitUntil: 'domcontentloaded',
  skipInitialGoto: true,
  async run({ page }) {
    await page.goto(appendBypass('http://localhost:5173/'), {
      waitUntil: 'domcontentloaded',
    });
    await page.waitForSelector('a[href="/puzzles"]', { timeout: 15_000 });

    const result = await page.evaluate(async (pgn) => {
      const { db, updateSettings } = await import('/src/db/schema.ts');
      const { nextPendingGame } = await import('/src/db/queries.ts');
      const { requestAnalysisNow, _priorityIds } = await import('/src/engine/queue.ts');

      // Keep the live pump off the seeded rows. It polls every 2-4 s and takes
      // any pending game, and `prio-oldest` is seeded first — so on CI's slower
      // runners the pump could start analyzing it before the request below,
      // which then (correctly) no-ops on the in-flight game: priority read `[]`
      // and the chooser fell through to `prio-newest`. With background analysis
      // off the pump starts nothing on its own, while the priority list still
      // works — `nextGameToAnalyze` consults it BEFORE the toggle, so this
      // doesn't weaken the assertion: if priority were ignored, the chooser
      // would return nothing rather than `prio-oldest`. TESTING.md § Tests race
      // the live app.
      await updateSettings({ autoAnalyze: false });

      await db.games.clear();
      await db.analyses.clear();

      // Three games, ascending endTime, so `oldest` is last in newest-first order.
      const ids = ['prio-oldest', 'prio-middle', 'prio-newest'];
      for (let i = 0; i < ids.length; i++) {
        await db.games.put({
          id: ids[i],
          url: `https://example.com/${ids[i]}`,
          source: 'chesscom',
          username: 'me',
          userColor: 'white',
          opponent: 'opp',
          result: 'win',
          timeControl: '600',
          timeClass: 'rapid',
          endTime: 1_700_000_000 + i * 1000,
          pgn,
          importedAt: Date.now(),
          analysisStatus: 'pending',
        });
      }

      // Baseline: with no request, newest-first wins.
      const defaultPick = (await nextPendingGame())?.id ?? null;

      // Now say the user is looking at the OLDEST one.
      requestAnalysisNow('prio-oldest');
      const priority = _priorityIds();

      // The queue's own selection path, exercised exactly as the pump does. Not
      // reimplemented here: importing the module's chooser is the point, since a
      // hand-rolled copy would pass even if the pump ignored priority.
      const q = await import('/src/engine/queue.ts');
      const chooser = q._nextGameToAnalyzeForTest;
      const pickedWithPriority = chooser ? (await chooser())?.id ?? null : 'NO_SEAM';

      return { defaultPick, priority, pickedWithPriority };
    }, PGN);

    console.log('ordering:', JSON.stringify(result));

    expect(result.defaultPick, 'without a request the queue takes the newest').toBe(
      'prio-newest',
    );
    expect(
      result.priority[0],
      'the requested id goes to the front of the priority list',
    ).toBe('prio-oldest');
    // THE assertion. If priority were ignored this reads `prio-newest`.
    expect(
      result.pickedWithPriority,
      'the game the user is viewing is chosen next, ahead of newer pending games',
    ).toBe('prio-oldest');

    /* ---------------------------------------------------------------- */
    /*  Idempotence / livelock guard                                    */
    /* ---------------------------------------------------------------- */
    const inflight = await page.evaluate(async () => {
      const q = await import('/src/engine/queue.ts');
      const setInFlight = q._setInFlightForTest;
      if (!setInFlight) return { seam: false };
      // Pretend the queue is mid-analysis on the game the user is viewing.
      const signal = { aborted: false };
      setInFlight({ gameId: 'prio-oldest', signal });
      q.requestAnalysisNow('prio-oldest');
      const sameGameAborted = signal.aborted;

      // A request for a DIFFERENT game must preempt.
      const signal2 = { aborted: false };
      setInFlight({ gameId: 'prio-middle', signal: signal2 });
      q.requestAnalysisNow('prio-oldest');
      const otherGameAborted = signal2.aborted;

      setInFlight(null);
      return { seam: true, sameGameAborted, otherGameAborted };
    });

    console.log('preemption:', JSON.stringify(inflight));
    expect(inflight.seam, 'test seam present').toBe(true);
    expect(
      inflight.sameGameAborted,
      're-requesting the in-flight game must NOT abort it (that would livelock the ' +
        'review page: abort, restart, abort, forever)',
    ).toBe(false);
    expect(
      inflight.otherGameAborted,
      'requesting a different game preempts the one in flight',
    ).toBe(true);

    /* ---------------------------------------------------------------- */
    /*  Status vs. analysis row                                         */
    /* ---------------------------------------------------------------- */
    // The chooser used to keep any priority game not yet `done`, and drop every
    // `done` one. Both halves were wrong (`priorityGameWantsAnalysis`):
    //   - an `error` game was re-chosen at once, forever — a tight loop that
    //     also starved the rest of the library;
    //   - a `done` game with no analysis row, which the review page requests
    //     on purpose, was discarded and the page said "queued" forever.
    // `autoAnalyze` is still off from above, so "dropped" reads as null here.
    // The live pump is paused for this block: it honours the priority list
    // whatever `autoAnalyze` says, so it would otherwise start analyzing the
    // `done`-without-row game between the request and our pick.
    const status = await page.evaluate(async () => {
      const { db } = await import('/src/db/schema.ts');
      const q = await import('/src/engine/queue.ts');
      q.useQueueStore.getState().setPaused(true);
      const pick = async () => (await q._nextGameToAnalyzeForTest())?.id ?? null;

      await db.games.update('prio-oldest', {
        analysisStatus: 'error',
        analysisError: 'Invalid move: Rh8+',
      });
      q.requestAnalysisNow('prio-oldest');
      const pickedErrored = await pick();
      const erroredLeftInPriority = q._priorityIds().includes('prio-oldest');

      await db.games.update('prio-middle', { analysisStatus: 'done' });
      await db.analyses.delete('prio-middle');
      q.requestAnalysisNow('prio-middle');
      const pickedDoneWithoutRow = await pick();

      await db.analyses.put({
        gameId: 'prio-middle',
        depth: 1,
        analyzedAt: Date.now(),
        engine: 'test',
        moves: [],
      });
      const pickedDoneWithRow = await pick();
      q.useQueueStore.getState().setPaused(false);

      return {
        pickedErrored,
        erroredLeftInPriority,
        pickedDoneWithoutRow,
        pickedDoneWithRow,
      };
    });

    console.log('status:', JSON.stringify(status));
    expect(
      status.pickedErrored,
      'an errored priority game is not re-chosen (that was a tight retry loop)',
    ).toBe(null);
    expect(
      status.erroredLeftInPriority,
      'an errored priority game is dropped from the list',
    ).toBe(false);
    expect(
      status.pickedDoneWithoutRow,
      'a `done` game with no analysis row that the review page asked for is analyzed',
    ).toBe('prio-middle');
    expect(
      status.pickedDoneWithRow,
      'a `done` game whose analysis row exists is dropped',
    ).toBe(null);
  },
});
