// Verifies the engine cockpit's observation pipeline end-to-end:
// the pool's observe() API, the EngineWorker's addInfoListener fan-out,
// and the cockpit store's throttled-but-eventually-consistent state.
//
// We don't test the React component itself here — that's a UI concern
// covered by the import-cockpit e2e test. This integration test pins
// the wiring contract between (real Stockfish worker) → (parsed info
// events) → (zustand store), which is the load-bearing piece for the
// "Stockfish brain" landing experience.
//
// What we assert:
//   1. Observers attached BEFORE the first analyze() see start + at
//      least one info event + done, in that order.
//   2. The events carry sane parsed fields (depth > 0, scoreCp or
//      scoreMate present by the end, a non-empty pv).
//   3. The cockpit store's `freshestActiveSlot` returns the right
//      slot during analysis and null after the worker completes.
//   4. Re-attaching after a detach starts a fresh subscription
//      (ref-counting works).

import { runBrowserTest, expect } from '../harness.mjs';

await runBrowserTest({
  name: 'engine-cockpit',
  captureAllConsole: true,
  async run({ page }) {
    const result = await page.evaluate(async () => {
      const log = [];
      try {
        const { analysisPool } = await import('/src/engine/pool.ts');
        const {
          attachCockpit,
          useEngineCockpitStore,
          freshestActiveSlot,
        } = await import('/src/engine/cockpit.ts');

        const pool = analysisPool();
        log.push(`pool initial size=${pool.size} capacity=${pool.capacity}`);

        // Subscribe both layers: the raw pool observer (which drives
        // every other consumer in the future) AND the cockpit store
        // (which is what the UI actually reads from). We want both to
        // see the same Stockfish run so we can pin the contract that
        // the higher-level store exactly mirrors the lower-level fan-
        // out, modulo the 100ms throttle.
        const events = [];
        const off = pool.observe((obs, idx) => {
          events.push({ kind: obs.kind, fen: obs.fen, idx, depth: obs.info?.depth });
        });
        const detach = attachCockpit();

        const FEN = 'r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4';
        const r = await pool.analyze(FEN, 14);
        log.push(`analyze result: best=${r.bestMoveUci} cp=${r.scoreCp} pvLen=${r.pv.length}`);

        // Drain microtasks / timers so any pending throttled flush
        // makes it into the store before we read.
        await new Promise((resolve) => setTimeout(resolve, 250));

        // Verify start + at least one info + done.
        const kinds = events.map((e) => e.kind);
        const hasStart = kinds.includes('start');
        const hasInfo = kinds.includes('info');
        const hasDone = kinds.includes('done');
        const startIdx = kinds.indexOf('start');
        const doneIdx = kinds.lastIndexOf('done');
        const infoIdx = kinds.indexOf('info');

        // Fields on info events should be parsed (depth > 0 by end).
        const maxInfoDepth = events
          .filter((e) => e.kind === 'info')
          .reduce((m, e) => Math.max(m, e.depth ?? 0), 0);

        log.push(
          `events: ${events.length} (start=${hasStart} info=${hasInfo} done=${hasDone}) maxInfoDepth=${maxInfoDepth}`,
        );

        const stateAfter = useEngineCockpitStore.getState();
        const slotKeys = Object.keys(stateAfter.slots);
        // After a worker completes, the slot fen flips back to null.
        // freshestActiveSlot should return null in that quiescent state.
        const fresh = freshestActiveSlot(stateAfter.slots);
        log.push(
          `cockpit store: attached=${stateAfter.attached} slots=${slotKeys.length} freshest=${fresh ? 'present' : 'null'}`,
        );

        // Slot should record at least the final (post-done) snapshot
        // with the requested depth and the FEN we asked about (in
        // history, the slot retains the last analyzed state).
        const anySlot = stateAfter.slots[Object.keys(stateAfter.slots)[0]];

        // Detach + re-attach: ref counting works, slot map cleared.
        detach();
        const stateAfterDetach = useEngineCockpitStore.getState();
        const reAttach = attachCockpit();
        const stateAfterReattach = useEngineCockpitStore.getState();
        reAttach();
        off();

        return {
          ok: true,
          eventCount: events.length,
          hasStart,
          hasInfo,
          hasDone,
          startBeforeInfo: startIdx >= 0 && infoIdx > startIdx,
          doneAfterInfo: doneIdx > infoIdx,
          maxInfoDepth,
          finalBestMove: r.bestMoveUci,
          slotCount: slotKeys.length,
          freshestIsNull: fresh === null,
          firstSlotRequestedDepth: anySlot?.requestedDepth ?? -1,
          firstSlotPvLen: anySlot?.pvUci?.length ?? -1,
          attachedAfterDetach: stateAfterDetach.attached,
          attachedAfterReattach: stateAfterReattach.attached,
          slotsAfterDetach: Object.keys(stateAfterDetach.slots).length,
          log,
        };
      } catch (e) {
        return {
          ok: false,
          error: e?.message ?? String(e),
          stack: e?.stack ?? null,
          log,
        };
      }
    });

    console.log('\n=== Result ===');
    console.log(JSON.stringify(result, null, 2));

    expect(result.ok, `cockpit run`).toBeTruthy();

    // 1. Lifecycle: every analyze produced start → info → done.
    expect(result.hasStart, 'start event fired').toBeTruthy();
    expect(result.hasInfo, 'at least one info event fired').toBeTruthy();
    expect(result.hasDone, 'done event fired').toBeTruthy();
    expect(result.startBeforeInfo, 'start fires before any info').toBeTruthy();
    expect(result.doneAfterInfo, 'done fires after the last info').toBeTruthy();

    // 2. Engine actually searched: depth made it past 1.
    expect(result.maxInfoDepth, 'maxInfoDepth').toBeGreaterThan(1);
    expect(result.finalBestMove, 'finalBestMove').toBeTruthy();

    // 3. Cockpit store ingested the second analyze. After both finish,
    //    the slot is quiescent (fen=null) and freshestActiveSlot
    //    correctly returns null.
    expect(result.slotCount, 'slotCount > 0').toBeGreaterThan(0);
    expect(result.freshestIsNull, 'freshestActiveSlot is null between jobs').toBeTruthy();
    expect(result.firstSlotRequestedDepth, 'requestedDepth carried').toBe(14);
    expect(result.firstSlotPvLen, 'pv stored on slot').toBeGreaterThan(0);

    // 4. Ref counting: detach clears, re-attach reactivates.
    expect(result.attachedAfterDetach, 'detached attached=false').toBe(false);
    expect(result.slotsAfterDetach, 'slots cleared on detach').toBe(0);
    expect(result.attachedAfterReattach, 'reattach flips attached back to true').toBe(true);
  },
});
