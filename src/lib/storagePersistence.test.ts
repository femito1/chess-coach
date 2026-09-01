import { describe, expect, it, vi } from 'vitest';
import {
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
