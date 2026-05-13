import { describe, it, expect } from 'vitest';
import {
  applyInfo,
  resetSlotForStart,
  freshestActiveSlot,
  diffCacheStats,
  type CockpitSlot,
} from './cockpit';

const FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

describe('resetSlotForStart', () => {
  it('produces a zeroed slot tagged with the start fen + worker', () => {
    const s = resetSlotForStart(2, FEN, 22, 1000);
    expect(s).toEqual({
      workerIndex: 2,
      fen: FEN,
      requestedDepth: 22,
      depth: 0,
      seldepth: 0,
      scoreCp: null,
      scoreMate: null,
      pvUci: [],
      nps: 0,
      nodes: 0,
      time: 0,
      lastUpdate: 1000,
    });
  });
});

describe('applyInfo', () => {
  const t0 = 1000;
  const fresh = resetSlotForStart(0, FEN, 22, t0);

  it('merges depth / score / pv from a stockfish info into a fresh slot', () => {
    const next = applyInfo(
      fresh,
      0,
      FEN,
      22,
      { depth: 12, scoreCp: 18, pv: ['e2e4', 'e7e5'] },
      t0 + 50,
    );
    expect(next.depth).toBe(12);
    expect(next.scoreCp).toBe(18);
    expect(next.pvUci).toEqual(['e2e4', 'e7e5']);
    expect(next.lastUpdate).toBe(t0 + 50);
  });

  it('preserves prior fields when the latest info omits them', () => {
    const after1 = applyInfo(
      fresh,
      0,
      FEN,
      22,
      { depth: 12, scoreCp: 18, pv: ['e2e4'] },
      t0 + 50,
    );
    // Next info bumps depth + nps but doesn't include a pv. Keep
    // the previous pv around so the cockpit doesn't blink to empty.
    const after2 = applyInfo(after1, 0, FEN, 22, { depth: 14, nps: 1500000 }, t0 + 100);
    expect(after2.depth).toBe(14);
    expect(after2.scoreCp).toBe(18);
    expect(after2.pvUci).toEqual(['e2e4']);
    expect(after2.nps).toBe(1500000);
  });

  it('caps the stored PV at 12 plies so the cockpit ribbon stays compact', () => {
    const long = Array.from({ length: 30 }, (_, i) => `e2e${i % 8}`);
    const next = applyInfo(fresh, 0, FEN, 22, { pv: long }, t0 + 50);
    expect(next.pvUci.length).toBe(12);
  });

  it('handles the score=mate transition (cp goes null, mate filled)', () => {
    const cpFirst = applyInfo(fresh, 0, FEN, 22, { depth: 10, scoreCp: 200 }, t0 + 50);
    expect(cpFirst.scoreCp).toBe(200);
    const matePromoted = applyInfo(cpFirst, 0, FEN, 22, { depth: 14, scoreMate: 5 }, t0 + 100);
    expect(matePromoted.scoreMate).toBe(5);
    // Critically: scoreCp is preserved as the previous best non-null
    // value so a brief mate-info snapshot doesn't wipe a usable cp.
    // (The UI prefers mate over cp anyway when both exist.)
    expect(matePromoted.scoreCp).toBe(200);
  });

  it('bootstraps a slot when prev is undefined', () => {
    const out = applyInfo(undefined, 1, FEN, 18, { depth: 8 }, t0);
    expect(out.workerIndex).toBe(1);
    expect(out.requestedDepth).toBe(18);
    expect(out.depth).toBe(8);
  });
});

describe('freshestActiveSlot', () => {
  const slot = (idx: number, fen: string | null, lastUpdate: number): CockpitSlot => ({
    workerIndex: idx,
    fen,
    requestedDepth: 22,
    depth: 10,
    seldepth: 12,
    scoreCp: 0,
    scoreMate: null,
    pvUci: [],
    nps: 1,
    nodes: 1,
    time: 1,
    lastUpdate,
  });

  it('returns null when no slot is active (all fens null)', () => {
    const slots = { 0: slot(0, null, 100), 1: slot(1, null, 200) };
    expect(freshestActiveSlot(slots)).toBeNull();
  });

  it('returns null on an empty slots map', () => {
    expect(freshestActiveSlot({})).toBeNull();
  });

  it('picks the slot with the most recent lastUpdate among active ones', () => {
    const slots = {
      0: slot(0, FEN, 100),
      1: slot(1, FEN, 500),
      2: slot(2, FEN, 200),
    };
    expect(freshestActiveSlot(slots)?.workerIndex).toBe(1);
  });

  it('ignores inactive (fen=null) slots even if they are most recent', () => {
    // Worker 1 just finished its job (fen=null) AFTER worker 0 emitted
    // a fresh info update. The "freshest active" pick is worker 0.
    const slots = {
      0: slot(0, FEN, 300),
      1: slot(1, null, 500),
    };
    expect(freshestActiveSlot(slots)?.workerIndex).toBe(0);
  });
});

describe('diffCacheStats', () => {
  // Regression: this is the load-bearing helper for the cockpit's
  // "X served from cache, Y sent to Stockfish" line. The bug we're
  // guarding against is the cockpit silently showing 0 / 0 because
  // global counters were uninitialized when we snapshotted, leaving
  // the user with no signal that anything is happening during a
  // fully-cached analysis.
  it('returns deltas for each counter', () => {
    const prev = { hits: 5, misses: 2, bookSkips: 1, inflightCoalesced: 0 };
    const curr = { hits: 12, misses: 4, bookSkips: 3, inflightCoalesced: 1 };
    expect(diffCacheStats(prev, curr)).toEqual({
      hits: 7,
      misses: 2,
      bookSkips: 2,
      inflightCoalesced: 1,
    });
  });

  it('clamps negative diffs at 0 (counter resets / hot reload)', () => {
    // The dev-server HMR can wipe `cacheStats` on module reload, leaving
    // `prev` higher than `curr`. We don't want the readout to flash
    // negative numbers in that edge case.
    const prev = { hits: 100, misses: 50, bookSkips: 10, inflightCoalesced: 5 };
    const curr = { hits: 0, misses: 0, bookSkips: 0, inflightCoalesced: 0 };
    expect(diffCacheStats(prev, curr)).toEqual({
      hits: 0,
      misses: 0,
      bookSkips: 0,
      inflightCoalesced: 0,
    });
  });

  it('returns all-zero when nothing changed (idle cockpit)', () => {
    const same = { hits: 10, misses: 10, bookSkips: 10, inflightCoalesced: 10 };
    expect(diffCacheStats(same, same)).toEqual({
      hits: 0,
      misses: 0,
      bookSkips: 0,
      inflightCoalesced: 0,
    });
  });
});
