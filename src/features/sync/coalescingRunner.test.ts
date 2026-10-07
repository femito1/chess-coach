import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCoalescingRunner } from './coalescingRunner';

/** A job whose completion the test controls. */
function controllable() {
  const calls: Array<() => void> = [];
  const run = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        calls.push(resolve);
      }),
  );
  return { run, finish: (i = calls.length - 1) => calls[i]() };
}

const settle = () => vi.advanceTimersByTimeAsync(0);

describe('createCoalescingRunner', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('runs once, after the delay', async () => {
    const run = vi.fn(async () => {});
    const r = createCoalescingRunner({ delayMs: 1000, run });
    r.request();
    await vi.advanceTimersByTimeAsync(999);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('coalesces a burst of requests into one job', async () => {
    const run = vi.fn(async () => {});
    const r = createCoalescingRunner({ delayMs: 1000, run });
    for (let i = 0; i < 5; i++) {
      r.request();
      await vi.advanceTimersByTimeAsync(500);
    }
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  /** The case that matters: an attempt recorded during an upload was read
   *  before it existed, so it needs a job of its own — exactly one. */
  it('never overlaps, and follows a mid-run request with exactly one more job', async () => {
    const job = controllable();
    const r = createCoalescingRunner({ delayMs: 1000, run: job.run });
    r.request();
    await vi.advanceTimersByTimeAsync(1000);
    expect(job.run).toHaveBeenCalledTimes(1);

    r.request();
    r.request();
    await vi.advanceTimersByTimeAsync(5000);
    expect(job.run, 'no second job while the first is running').toHaveBeenCalledTimes(1);

    job.finish();
    await settle();
    await vi.advanceTimersByTimeAsync(1000);
    expect(job.run, 'one follow-up for the mid-run requests').toHaveBeenCalledTimes(2);
    job.finish();
    await settle();
    await vi.advanceTimersByTimeAsync(5000);
    expect(job.run).toHaveBeenCalledTimes(2);
    expect(r.pending()).toBe(false);
  });

  it('flush runs a pending job immediately', async () => {
    const run = vi.fn(async () => {});
    const r = createCoalescingRunner({ delayMs: 10_000, run });
    r.request();
    r.flush();
    await settle();
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(run, 'the flushed job is not run again by the timer').toHaveBeenCalledTimes(1);
  });

  it('flush with nothing pending costs nothing', async () => {
    const run = vi.fn(async () => {});
    const r = createCoalescingRunner({ delayMs: 1000, run });
    r.flush();
    await vi.advanceTimersByTimeAsync(5000);
    expect(run).not.toHaveBeenCalled();
  });

  it('reports a failure and recovers on the next request', async () => {
    const onError = vi.fn();
    const run = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(undefined);
    const r = createCoalescingRunner({ delayMs: 100, run, onError });
    r.request();
    await vi.advanceTimersByTimeAsync(100);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(r.pending()).toBe(false);
    r.request();
    await vi.advanceTimersByTimeAsync(100);
    expect(run).toHaveBeenCalledTimes(2);
  });
});
