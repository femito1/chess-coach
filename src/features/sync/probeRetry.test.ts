import { describe, expect, it, vi } from 'vitest';
import { PROBE_RETRY_DELAYS_MS, probeSyncEnabledWithRetry } from './probeRetry';

/** Never actually wait in tests. */
const instant = () => Promise.resolve();
const open = () => ({ aborted: false });

describe('probeSyncEnabledWithRetry', () => {
  it('returns a first-try success without retrying', async () => {
    const probe = vi.fn().mockResolvedValue({ enabled: true });
    const out = await probeSyncEnabledWithRetry(probe, open(), [10, 20], instant);
    expect(out).toEqual({ enabled: true, attempts: 1 });
    expect(probe).toHaveBeenCalledOnce();
  });

  it('rides out a transient failure and then syncs', async () => {
    // The case that motivated this: a cold start fails the probe once, and the
    // old code gave up and waited for the user to press a button.
    const probe = vi
      .fn()
      .mockResolvedValueOnce({ enabled: false, error: 'network' })
      .mockResolvedValueOnce({ enabled: true });
    const out = await probeSyncEnabledWithRetry(probe, open(), [10, 20], instant);
    expect(out).toEqual({ enabled: true, attempts: 2 });
  });

  it('absorbs a throw the same as a returned error', async () => {
    const probe = vi
      .fn()
      .mockRejectedValueOnce(new Error('from() exploded'))
      .mockResolvedValueOnce({ enabled: true });
    const out = await probeSyncEnabledWithRetry(probe, open(), [10], instant);
    expect(out.enabled).toBe(true);
    expect(out.attempts).toBe(2);
  });

  it('gives up after the last delay and reports the final error', async () => {
    const probe = vi.fn().mockResolvedValue({ enabled: false, error: 'still down' });
    const out = await probeSyncEnabledWithRetry(probe, open(), [10, 20], instant);
    expect(out.error).toBe('still down');
    expect(probe).toHaveBeenCalledTimes(3); // initial + one per delay
  });

  it('does NOT retry a definitive "not enrolled"', async () => {
    // `enabled: false` with no error is authoritative — retrying it would
    // hammer the allowlist for every unenrolled account on every page load.
    const probe = vi.fn().mockResolvedValue({ enabled: false });
    const out = await probeSyncEnabledWithRetry(probe, open(), [10, 20], instant);
    expect(out).toEqual({ enabled: false, attempts: 1 });
    expect(probe).toHaveBeenCalledOnce();
  });

  it('stops immediately once the pass is aborted', async () => {
    // Clerk resolves userId in stages, so effects abort and re-run; a retry
    // loop that ignored the signal would keep probing for a dead pass.
    const signal = { aborted: false };
    const probe = vi.fn().mockImplementation(() => {
      signal.aborted = true;
      return Promise.resolve({ enabled: false, error: 'network' });
    });
    const out = await probeSyncEnabledWithRetry(probe, signal, [10, 20], instant);
    expect(probe).toHaveBeenCalledOnce();
    expect(out.error).toBe('network');
  });

  it('ships a backoff that is short enough to be invisible', async () => {
    const total = PROBE_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0);
    expect(total).toBeLessThanOrEqual(15_000);
  });
});
