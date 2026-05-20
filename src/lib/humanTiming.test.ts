import { describe, expect, test, vi } from 'vitest';
import {
  FREE_PLAY_THINK_MS,
  PUZZLE_REPLY_DELAY_MS,
  sampleDelay,
  waitUntilElapsed,
} from './humanTiming';

describe('sampleDelay', () => {
  test('returns the floor when Math.random is 0', () => {
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      expect(sampleDelay({ min: 500, max: 1000 })).toBe(500);
    } finally {
      spy.mockRestore();
    }
  });

  test('returns the ceiling when Math.random is just under 1', () => {
    // Math.random() never returns exactly 1; with 0.9999 we expect a
    // value rounded to within 1 ms of `max`.
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0.9999);
    try {
      const v = sampleDelay({ min: 500, max: 1000 });
      expect(v).toBeGreaterThanOrEqual(999);
      expect(v).toBeLessThanOrEqual(1000);
    } finally {
      spy.mockRestore();
    }
  });

  test('uniform mid-window sample lands inside the range', () => {
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    try {
      expect(sampleDelay({ min: 500, max: 1000 })).toBe(750);
    } finally {
      spy.mockRestore();
    }
  });

  test('zero-width range returns the floor exactly', () => {
    expect(sampleDelay({ min: 700, max: 700 })).toBe(700);
  });

  test('inverted range (max < min) is clamped to the floor without going negative', () => {
    // Defensive: a future tweak could swap min/max by mistake. We
    // never want a negative `setTimeout`. The current implementation
    // clamps the span at zero, so the returned value is `min`
    // regardless of `max`.
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    try {
      expect(sampleDelay({ min: 700, max: 100 })).toBe(700);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('FREE_PLAY_THINK_MS bands', () => {
  test('all four strength levels are present and have positive widths', () => {
    for (const level of ['max', '2000', '1600', '1200'] as const) {
      const r = FREE_PLAY_THINK_MS[level];
      expect(r.min).toBeGreaterThan(0);
      expect(r.max).toBeGreaterThanOrEqual(r.min);
    }
  });

  test('think windows shrink monotonically as strength drops', () => {
    // Pin the "weaker engines respond faster, like weaker humans"
    // intent so a future tweak that accidentally inverts a level
    // (e.g. 1200 ending up slower than 1600) fails fast.
    expect(FREE_PLAY_THINK_MS.max.min).toBeGreaterThanOrEqual(
      FREE_PLAY_THINK_MS['2000'].min,
    );
    expect(FREE_PLAY_THINK_MS['2000'].min).toBeGreaterThanOrEqual(
      FREE_PLAY_THINK_MS['1600'].min,
    );
    expect(FREE_PLAY_THINK_MS['1600'].min).toBeGreaterThanOrEqual(
      FREE_PLAY_THINK_MS['1200'].min,
    );
    expect(FREE_PLAY_THINK_MS.max.max).toBeGreaterThanOrEqual(
      FREE_PLAY_THINK_MS['1200'].max,
    );
  });
});

describe('PUZZLE_REPLY_DELAY_MS', () => {
  test('puzzle-reply window is shorter than even the weakest free-play band', () => {
    // Puzzle replies are scripted (chess.js move-application, no
    // search), so we don't need to "show the engine thinking" — we
    // just need a beat between the user's move and the reply so the
    // board doesn't visibly jump two plies in one frame. Pin that
    // it's bounded above by the cheapest free-play minimum.
    expect(PUZZLE_REPLY_DELAY_MS.max).toBeLessThanOrEqual(
      FREE_PLAY_THINK_MS['1200'].max,
    );
    expect(PUZZLE_REPLY_DELAY_MS.min).toBeGreaterThanOrEqual(400);
  });
});

describe('waitUntilElapsed', () => {
  test('resolves immediately when the deadline has already passed', async () => {
    const t0 = Date.now() - 1000;
    const startedAtPromise = waitUntilElapsed(t0, 500);
    // Should resolve in essentially zero ms — Promise.resolve.
    const elapsed = await Promise.race([
      startedAtPromise.then(() => 'done'),
      new Promise((r) => setTimeout(() => r('timeout'), 50)),
    ]);
    expect(elapsed).toBe('done');
  });

  test('waits the remaining time when deadline is in the future', async () => {
    const start = Date.now();
    await waitUntilElapsed(start, 60);
    const elapsed = Date.now() - start;
    // 60ms target with timer slop on the upper bound. Lower bound
    // tolerates the testing-runner scheduler — Vitest's micro-jitter
    // on Linux is up to a few ms below the requested timeout.
    expect(elapsed).toBeGreaterThanOrEqual(40);
    expect(elapsed).toBeLessThan(300);
  });
});
