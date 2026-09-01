import { describe, expect, it, vi } from 'vitest';
import {
  CRITICAL_REMAINING_BYTES,
  LOW_REMAINING_BYTES,
  assessStoragePressure,
  requestDurability,
  type DurabilityApi,
} from './storagePersistence';

function api(over: Partial<DurabilityApi>): DurabilityApi {
  return {
    persisted: vi.fn().mockResolvedValue(false),
    persist: vi.fn().mockResolvedValue(false),
    ...over,
  } as DurabilityApi;
}

describe('requestDurability', () => {
  it('reports unsupported when there is no Storage API', async () => {
    expect(await requestDurability(undefined)).toEqual({ kind: 'unsupported' });
  });

  it('reports unsupported when the methods are missing', async () => {
    // Older Safari exposes `navigator.storage` without `persist`.
    expect(
      await requestDurability({ estimate: () => {} } as unknown as DurabilityApi),
    ).toEqual({ kind: 'unsupported' });
  });

  it('does not re-ask when the browser already granted', async () => {
    const persist = vi.fn().mockResolvedValue(true);
    const a = api({ persisted: vi.fn().mockResolvedValue(true), persist });
    expect(await requestDurability(a)).toEqual({ kind: 'persisted' });
    // Re-asking can re-prompt in browsers that prompt.
    expect(persist).not.toHaveBeenCalled();
  });

  it('asks when not yet granted, and reports a grant', async () => {
    const a = api({ persist: vi.fn().mockResolvedValue(true) });
    expect(await requestDurability(a)).toEqual({ kind: 'persisted' });
    expect(a.persist).toHaveBeenCalledOnce();
  });

  it('records a refusal as best-effort, asked', async () => {
    // Chrome commonly refuses silently on engagement grounds.
    const a = api({ persist: vi.fn().mockResolvedValue(false) });
    expect(await requestDurability(a)).toEqual({ kind: 'best-effort', asked: true });
  });

  it('turns a throw into an error state rather than propagating', async () => {
    // Private windows and blocked-site-data settings throw here; boot must
    // not care.
    const a = api({ persisted: vi.fn().mockRejectedValue(new Error('denied')) });
    expect(await requestDurability(a)).toEqual({ kind: 'error', message: 'denied' });
  });
});

describe('assessStoragePressure', () => {
  it('is unknown when the browser will not say', () => {
    expect(assessStoragePressure(null)).toEqual({ kind: 'unknown' });
  });

  it('reports plenty of room as ok', () => {
    // The healthy reading measured after the disk was freed.
    expect(assessStoragePressure({ usage: 23_067_069, quota: 10_760_485_309 })).toEqual({
      kind: 'ok',
      remaining: 10_737_418_240,
    });
  });

  it('pins the critical boundary in both directions', () => {
    expect(
      assessStoragePressure({ usage: 0, quota: CRITICAL_REMAINING_BYTES - 1 }).kind,
    ).toBe('critical');
    expect(
      assessStoragePressure({ usage: 0, quota: CRITICAL_REMAINING_BYTES }).kind,
    ).toBe('low');
  });

  it('calls a collapsed quota critical, which is the disk-full fingerprint', () => {
    // Chromium derives quota from free disk, so a nearly-full disk reports
    // almost nothing — the state that actually lost this app's data.
    expect(assessStoragePressure({ usage: 0, quota: 13_900_000 }).kind).toBe('critical');
    expect(assessStoragePressure({ usage: 0, quota: 0 }).kind).toBe('critical');
  });

  it('does not read a missing quota as unlimited room', () => {
    // The dangerous misreading: 0 quota means the browser is promising nothing,
    // not that everything fits.
    expect(assessStoragePressure({ usage: 5_000_000, quota: 0 })).toEqual({
      kind: 'critical',
      remaining: 0,
    });
  });

  it('warns before it is critical', () => {
    expect(
      assessStoragePressure({ usage: 0, quota: LOW_REMAINING_BYTES - 1 }).kind,
    ).toBe('low');
    expect(assessStoragePressure({ usage: 0, quota: LOW_REMAINING_BYTES }).kind).toBe('ok');
  });

  it('measures headroom, not device size', () => {
    // A small quota on a small device is fine as long as there is room left;
    // a huge quota that is nearly consumed is not.
    expect(assessStoragePressure({ usage: 10_000, quota: 400_000_000 }).kind).toBe('ok');
    expect(
      assessStoragePressure({ usage: 9_990_000_000, quota: 10_000_000_000 }).kind,
    ).toBe('critical');
  });

  it('never reports negative headroom', () => {
    // Usage can exceed a shrunken quota after the disk fills.
    expect(assessStoragePressure({ usage: 900, quota: 100 })).toEqual({
      kind: 'critical',
      remaining: 0,
    });
  });
});
