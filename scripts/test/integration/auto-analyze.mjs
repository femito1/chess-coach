// Does `Settings.autoAnalyze` actually stop background analysis — and only that?
//
// The toggle ("Automatically analyze imported games in the background") was
// written by the Settings UI and read by NOTHING for the app's whole life: the
// queue never consulted it, so flipping it off changed no behaviour at all and
// silently misled anyone who used it to try to quiet the analyzer on a
// constrained device (ARCHITECTURE.md § Memory on mobile). It is now wired into
// the pump's chooser, and this pins the three properties that make that a fix
// rather than a new hazard:
//
//   1. **Off really stops the backfill.** Asserted against a table that still has
//      analyzable pending rows — `nextPendingGame()` is checked in the same breath
//      and must still return one. Without that precondition the test would pass
//      just as well on an empty table, which is the false pass to avoid here.
//
//   2. **Off does NOT break the review page.** `requestAnalysisNow` is the review
//      page saying "I am showing this game and it has no analysis" — the user
//      asking directly. If the toggle gated the whole chooser instead of just the
//      unattended fallback, that user would sit on a spinner forever, which is
//      worse than the inert toggle this replaces.
//
//   3. **On resumes it, with no restart.** The flag is read per call, so the loop
//      picks the change up on its next poll.
//
// Insulation (TESTING.md § Tests race the live app): `autoAnalyze` is set to false
// BEFORE any row is seeded, so for most of this test the app's own run loop is
// structurally unable to claim the fixtures — the gate under test is also the
// thing keeping the test deterministic. Rows are marked `done` as soon as they
// have been asserted on, and the toggle is restored at the end.
//
// Run: node scripts/run-tests.mjs --only=auto-analyze

import { runBrowserTest, expect, appendBypass, DEFAULT_URL } from '../harness.mjs';

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
  name: 'auto-analyze',
  waitUntil: 'domcontentloaded',
  skipInitialGoto: true,
  async run({ page }) {
    await page.goto(appendBypass(DEFAULT_URL), { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('a[href="/puzzles"]', { timeout: 15_000 });

    const result = await page.evaluate(async (pgn) => {
      const { db, updateSettings, getSettings } = await import('/src/db/schema.ts');
      const { nextPendingGame } = await import('/src/db/queries.ts');
      const q = await import('/src/engine/queue.ts');
      const chooser = q._nextGameToAnalyzeForTest;
      if (!chooser) return { seam: false };

      // Toggle OFF first, so the live run loop cannot take background work
      // against the rows seeded next.
      await updateSettings({ autoAnalyze: false });

      await db.games.clear();
      await db.analyses.clear();
      const ids = ['auto-older', 'auto-newer'];
      await db.transaction('rw', db.games, async () => {
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
      });

      // --- 1. off stops the backfill, and there IS something to stop --------
      const pendingExists = (await nextPendingGame())?.id ?? null;
      const pickedWhileOff = (await chooser())?.id ?? null;

      // --- 2. the review page's direct request still wins ------------------
      q.requestAnalysisNow('auto-older');
      const pickedByRequestWhileOff = (await chooser())?.id ?? null;
      // Drop it back out of contention immediately: `done` makes the chooser
      // drain it from the priority list on its next look, so the live pump has
      // nothing to start.
      await db.games.update('auto-older', { analysisStatus: 'done' });
      const drainedAfterDone = (await chooser())?.id ?? null;

      // --- 3. on resumes the backfill, no restart --------------------------
      await updateSettings({ autoAnalyze: true });
      const pickedWhileOn = (await chooser())?.id ?? null;
      // Leave nothing analyzable behind.
      await db.games.update('auto-newer', { analysisStatus: 'done' });

      const persisted = (await getSettings()).autoAnalyze;
      return {
        seam: true,
        pendingExists,
        pickedWhileOff,
        pickedByRequestWhileOff,
        drainedAfterDone,
        pickedWhileOn,
        persisted,
      };
    }, PGN);

    console.log('auto-analyze:', JSON.stringify(result));
    expect(result.seam, 'chooser test seam present').toBe(true);

    // The precondition. If this were null the next assertion would be vacuous.
    expect(
      result.pendingExists,
      'precondition: an analyzable pending game exists for the gate to refuse',
    ).toBe('auto-newer');
    // THE assertion. Before the toggle was wired in, this read 'auto-newer'.
    expect(
      result.pickedWhileOff,
      'autoAnalyze off: the pump takes no background work',
    ).toBe(null);

    expect(
      result.pickedByRequestWhileOff,
      'autoAnalyze off: a game the user is VIEWING is still analyzed — the toggle ' +
        'gates the unattended backfill, not the review page',
    ).toBe('auto-older');
    expect(
      result.drainedAfterDone,
      'a finished priority game is dropped, and the backfill stays gated',
    ).toBe(null);

    expect(
      result.pickedWhileOn,
      'autoAnalyze back on: the backfill resumes without a restart',
    ).toBe('auto-newer');
    expect(result.persisted, 'the toggle is left back at its default').toBe(true);
  },
});
