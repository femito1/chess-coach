import { describe, expect, it } from 'vitest';
import {
  initSession,
  reduceSession,
  PRACTICE_MODE_LABEL,
  type PracticeSessionState,
} from './practiceMode';

const FIXED_SEED = 12345;

describe('practiceMode.initSession', () => {
  it('seeds currentIndex with the first selected line', () => {
    const s = initSession({
      mode: 'sequential',
      selectedIndices: [3, 1, 2],
      randSeed: FIXED_SEED,
    });
    // selectedIndices is sorted, so the first is 1
    expect(s.selectedIndices).toEqual([1, 2, 3]);
    expect(s.currentIndex).toBe(1);
    expect(s.perfectThisSession).toEqual([]);
    expect(s.sessionPlays).toBe(0);
  });

  it('respects startAt when it is in the selection', () => {
    const s = initSession({
      mode: 'sequential',
      selectedIndices: [1, 2, 3],
      startAt: 2,
      randSeed: FIXED_SEED,
    });
    expect(s.currentIndex).toBe(2);
  });

  it('falls back to the first index when startAt is not selected', () => {
    const s = initSession({
      mode: 'sequential',
      selectedIndices: [1, 2, 3],
      startAt: 99,
      randSeed: FIXED_SEED,
    });
    expect(s.currentIndex).toBe(1);
  });

  it('sets currentIndex to null on an empty selection', () => {
    const s = initSession({
      mode: 'sequential',
      selectedIndices: [],
      randSeed: FIXED_SEED,
    });
    expect(s.currentIndex).toBeNull();
  });

  it('drops negative / non-integer indices', () => {
    const s = initSession({
      mode: 'sequential',
      selectedIndices: [-1, 2, 1.5, 3, 3],
      randSeed: FIXED_SEED,
    });
    expect(s.selectedIndices).toEqual([2, 3]);
  });
});

describe('practiceMode.reduceSession :: sequential mode', () => {
  it('walks the selection in order, wrapping around', () => {
    let s = initSession({
      mode: 'sequential',
      selectedIndices: [10, 20, 30],
      randSeed: FIXED_SEED,
    });
    expect(s.currentIndex).toBe(10);
    s = reduceSession(s, { type: 'finished', perfect: false });
    expect(s.currentIndex).toBe(20);
    s = reduceSession(s, { type: 'finished', perfect: true });
    expect(s.currentIndex).toBe(30);
    s = reduceSession(s, { type: 'finished', perfect: false });
    expect(s.currentIndex).toBe(10);
  });

  it('skip advances without bumping sessionPlays', () => {
    const s0 = initSession({
      mode: 'sequential',
      selectedIndices: [1, 2, 3],
    });
    const s1 = reduceSession(s0, { type: 'skip' });
    expect(s1.currentIndex).toBe(2);
    expect(s1.sessionPlays).toBe(0);
    const s2 = reduceSession(s1, { type: 'finished', perfect: false });
    expect(s2.currentIndex).toBe(3);
    expect(s2.sessionPlays).toBe(1);
  });
});

describe('practiceMode.reduceSession :: random mode', () => {
  it('returns the only available line when there is exactly one', () => {
    const s = initSession({
      mode: 'random',
      selectedIndices: [42],
      randSeed: FIXED_SEED,
    });
    const next = reduceSession(s, { type: 'finished', perfect: false });
    expect(next.currentIndex).toBe(42);
  });

  it('avoids picking the same line twice in a row when possible', () => {
    let s = initSession({
      mode: 'random',
      selectedIndices: [1, 2, 3, 4, 5],
      randSeed: 7,
    });
    let prev = s.currentIndex;
    for (let i = 0; i < 30; i++) {
      s = reduceSession(s, { type: 'finished', perfect: false });
      expect(s.currentIndex).not.toBe(prev);
      prev = s.currentIndex;
    }
  });

  it('is deterministic given the same seed + play count', () => {
    const a = initSession({
      mode: 'random',
      selectedIndices: [1, 2, 3, 4],
      randSeed: 99,
    });
    const b = initSession({
      mode: 'random',
      selectedIndices: [1, 2, 3, 4],
      randSeed: 99,
    });
    let sa = a;
    let sb = b;
    for (let i = 0; i < 10; i++) {
      sa = reduceSession(sa, { type: 'finished', perfect: false });
      sb = reduceSession(sb, { type: 'finished', perfect: false });
      expect(sa.currentIndex).toBe(sb.currentIndex);
    }
  });
});

describe('practiceMode.reduceSession :: repeat-until-perfect', () => {
  it('keeps line in queue when finished imperfectly', () => {
    const s0 = initSession({
      mode: 'repeat-until-perfect',
      selectedIndices: [1, 2],
    });
    expect(s0.currentIndex).toBe(1);
    const s1 = reduceSession(s0, { type: 'finished', perfect: false });
    // After a non-perfect finish, line 1 is still pending.
    expect(s1.perfectThisSession).toEqual([]);
    expect(s1.currentIndex).toBe(2);
    const s2 = reduceSession(s1, { type: 'finished', perfect: false });
    expect(s2.currentIndex).toBe(1);
  });

  it('crosses off lines that are finished perfectly', () => {
    const s0 = initSession({
      mode: 'repeat-until-perfect',
      selectedIndices: [1, 2],
    });
    const s1 = reduceSession(s0, { type: 'finished', perfect: true });
    expect(s1.perfectThisSession).toEqual([1]);
    expect(s1.currentIndex).toBe(2);
  });

  it('returns null currentIndex when every selected line is perfect', () => {
    let s: PracticeSessionState = initSession({
      mode: 'repeat-until-perfect',
      selectedIndices: [10, 20],
    });
    s = reduceSession(s, { type: 'finished', perfect: true });
    s = reduceSession(s, { type: 'finished', perfect: true });
    expect(s.perfectThisSession.sort()).toEqual([10, 20]);
    expect(s.currentIndex).toBeNull();
  });

  it('does not double-count a line that is finished perfectly twice', () => {
    let s = initSession({
      mode: 'repeat-until-perfect',
      selectedIndices: [10, 20],
    });
    // Manually force the same line back via jumpTo (e.g. user wanted
    // to redo a perfect line and it should still only be tracked once).
    s = reduceSession(s, { type: 'finished', perfect: true });
    s = reduceSession(s, { type: 'jumpTo', index: 10 });
    s = reduceSession(s, { type: 'finished', perfect: true });
    // Line 10 is already in `perfectThisSession`; redoing it doesn't
    // re-add the entry. Line 20 still hasn't been played.
    expect(s.perfectThisSession).toEqual([10]);
  });
});

describe('practiceMode.reduceSession :: changeSelection / changeMode', () => {
  it('drops perfectThisSession entries that are no longer selected', () => {
    let s = initSession({
      mode: 'repeat-until-perfect',
      selectedIndices: [1, 2, 3],
    });
    s = reduceSession(s, { type: 'finished', perfect: true });
    expect(s.perfectThisSession).toEqual([1]);
    s = reduceSession(s, {
      type: 'changeSelection',
      selectedIndices: [2, 3],
    });
    expect(s.perfectThisSession).toEqual([]);
    expect(s.selectedIndices).toEqual([2, 3]);
  });

  it('moves to the first valid index when current is deselected', () => {
    let s = initSession({
      mode: 'sequential',
      selectedIndices: [1, 2, 3],
    });
    s = reduceSession(s, { type: 'finished', perfect: false });
    expect(s.currentIndex).toBe(2);
    s = reduceSession(s, {
      type: 'changeSelection',
      selectedIndices: [1, 3],
    });
    expect(s.currentIndex).toBe(1);
  });

  it('resets perfectThisSession on mode change', () => {
    let s = initSession({
      mode: 'repeat-until-perfect',
      selectedIndices: [1, 2],
    });
    s = reduceSession(s, { type: 'finished', perfect: true });
    expect(s.perfectThisSession).toEqual([1]);
    s = reduceSession(s, { type: 'changeMode', mode: 'sequential' });
    expect(s.perfectThisSession).toEqual([]);
  });

  it('jumpTo no-ops when the target is not selected', () => {
    const s0 = initSession({
      mode: 'sequential',
      selectedIndices: [1, 2],
    });
    const s1 = reduceSession(s0, { type: 'jumpTo', index: 99 });
    expect(s1).toEqual(s0);
  });
});

describe('practiceMode mode labels', () => {
  it('exposes a label for every mode', () => {
    expect(PRACTICE_MODE_LABEL.sequential).toBe('Sequential');
    expect(PRACTICE_MODE_LABEL.random).toBe('Shuffle');
    expect(PRACTICE_MODE_LABEL['repeat-until-perfect']).toBe(
      'Repeat until perfect',
    );
  });
});
