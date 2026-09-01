/**
 * Retry wrapper for the cloud-sync allowlist probe.
 *
 * Its own module, with **no imports at all**, for the same reason `diff.ts`
 * keeps to type-only imports: anything reaching into `lib/supabase.ts` pulls in
 * `lib/env.ts`, which throws at module load without the three `VITE_*` auth
 * vars — so a test importing it would be permanently red on any machine
 * without a `.env.local` (see TESTING.md § Known-failing). Pure logic tested
 * in isolation stays cheap to test.
 */

/**
 * Backoff for the allowlist probe. Short, because the point is to ride out a
 * cold start rather than to keep trying all day.
 */
export const PROBE_RETRY_DELAYS_MS = [1_000, 3_000, 8_000] as const;

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Run the allowlist probe, retrying a *failed* probe before giving up.
 *
 * Why this exists: the probe runs before the first sync, and the old code
 * parked in `phase: 'error'` and returned the moment it failed once — so a
 * transient failure at page load (offline, a cold Supabase connection, the
 * client still warming up) meant no sync happened at all until the user
 * noticed and pressed "Sync now". On a device whose local IndexedDB has been
 * evicted, that is the difference between the library restoring itself and
 * the app looking empty.
 *
 * Retrying is safe because the probe is not the security boundary: gating
 * lives in RLS via `cloud_sync_enabled()` (ARCHITECTURE.md § Cloud sync), and
 * `isSyncEnabled` is only a UX affordance. A `false` answer is authoritative
 * enough to stop, though — only errors are retried, never "not enrolled".
 */
export async function probeSyncEnabledWithRetry(
  probe: () => Promise<{ enabled: boolean; error?: string }>,
  signal: { aborted: boolean },
  delays: readonly number[] = PROBE_RETRY_DELAYS_MS,
  sleep: (ms: number) => Promise<void> = defaultSleep,
): Promise<{ enabled: boolean; error?: string; attempts: number }> {
  let last: { enabled: boolean; error?: string } = {
    enabled: false,
    error: 'not attempted',
  };
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    if (signal.aborted) return { ...last, attempts: attempt };
    try {
      last = await probe();
    } catch (err) {
      last = {
        enabled: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    if (!last.error) return { ...last, attempts: attempt + 1 };
    if (attempt === delays.length) break;
    await sleep(delays[attempt]);
  }
  return { ...last, attempts: delays.length + 1 };
}
