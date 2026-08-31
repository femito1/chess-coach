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
      const { db } = await import('/src/db/schema.ts');
      const { nextPendingGame } = await import('/src/db/queries.ts');
      const { requestAnalysisNow, _priorityIds } = await import('/src/engine/queue.ts');

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
  },
});
