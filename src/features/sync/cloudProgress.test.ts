import { describe, expect, it } from 'vitest';
import {
  NNUE_ENGINE_PATTERN,
  summarizeCloudProgress,
  type CloudCounts,
} from './cloudProgress';
import { isNnueAnalysis } from './diff';

/**
 * The card's whole readout is derived from three integers, so this is where the
 * arithmetic gets pinned. The network half (`fetchCloudCounts`) is exercised by
 * the `cloud-progress` integration script against a fake PostgREST, because what
 * matters there is the request *shape* — `head: true`, no `data` — which a unit
 * test can't observe.
 */

const counts = (over: Partial<CloudCounts> = {}): CloudCounts => ({
  games: 0,
  analyses: 0,
  nnueAnalyses: 0,
  ...over,
});

describe('summarizeCloudProgress', () => {
  it('reports a partially analyzed library', () => {
    const s = summarizeCloudProgress(counts({ games: 1783, analyses: 1204, nnueAnalyses: 1204 }));
    expect(s.percent).toBe(68);
    expect(s.complete).toBe(false);
    expect(s.allNnue).toBe(true);
    expect(s.classicalAnalyses).toBe(0);
    expect(s.empty).toBe(false);
  });

  it('separates "fully analyzed" from "fully NNUE"', () => {
    // The state the server worker actually starts from: everything analyzed,
    // all of it by the weaker classical evaluator. A bar at 100% must not imply
    // there is no work left.
    const s = summarizeCloudProgress(counts({ games: 500, analyses: 500, nnueAnalyses: 0 }));
    expect(s.percent).toBe(100);
    expect(s.complete).toBe(true);
    expect(s.allNnue).toBe(false);
    expect(s.classicalAnalyses).toBe(500);
  });

  it('treats an empty cloud as empty, not as complete', () => {
    // Complete-and-empty would read wrong AND stop the poll before the first
    // upload ever arrives.
    const s = summarizeCloudProgress(counts());
    expect(s.empty).toBe(true);
    expect(s.complete).toBe(false);
    expect(s.percent).toBe(0);
    expect(s.allNnue).toBe(false);
  });

  it('clamps more analyses than games', () => {
    // Reachable in practice: the cloud never deletes, so an analysis can outlive
    // its game row's local counterpart. The bar must stay inside its track.
    const s = summarizeCloudProgress(counts({ games: 10, analyses: 12, nnueAnalyses: 12 }));
    expect(s.percent).toBe(100);
    expect(s.complete).toBe(true);
  });

  it('clamps an NNUE count above the analysis count', () => {
    const s = summarizeCloudProgress(counts({ games: 10, analyses: 5, nnueAnalyses: 9 }));
    expect(s.nnueAnalyses).toBe(5);
    expect(s.classicalAnalyses).toBe(0);
  });

  it('ignores negative counts', () => {
    const s = summarizeCloudProgress(counts({ games: -3, analyses: -1, nnueAnalyses: -1 }));
    expect(s.games).toBe(0);
    expect(s.analyses).toBe(0);
    expect(s.percent).toBe(0);
  });

  it('rounds rather than truncating', () => {
    // 2/3 must read 67%, not 66%.
    expect(summarizeCloudProgress(counts({ games: 3, analyses: 2 })).percent).toBe(67);
    expect(summarizeCloudProgress(counts({ games: 1000, analyses: 1 })).percent).toBe(0);
  });

  it('never reports 100% while a single game is unanalyzed', () => {
    // Guards the rounding: 1999/2000 rounds to 100 but is NOT complete, and the
    // card keys "done" off `complete`, not off the percentage.
    const s = summarizeCloudProgress(counts({ games: 2000, analyses: 1999 }));
    expect(s.percent).toBe(100);
    expect(s.complete).toBe(false);
  });
});

describe('NNUE_ENGINE_PATTERN', () => {
  it('matches exactly what isNnueAnalysis considers NNUE', () => {
    // The card's NNUE tally is a `like` in Postgres while sync's conflict rule is
    // a substring test in TS. If they ever disagree, the readout silently lies
    // about how much of the library the worker has upgraded.
    const bare = NNUE_ENGINE_PATTERN.replaceAll('%', '');
    expect(isNnueAnalysis(`stockfish-16-${bare}`)).toBe(true);
    expect(isNnueAnalysis('stockfish-16-classical')).toBe(false);
    expect(isNnueAnalysis(null)).toBe(false);
  });
});
