import { create } from 'zustand';
import { useCallback, useEffect, useRef } from 'react';
import { useSupabase } from '@/lib/supabase';
import { useEffectiveAuth } from '@/lib/testAuth';
import { useQueueStore } from '@/engine/queue';
import {
  countsTotal,
  emptyCounts,
  isAbort,
  isSyncEnabled,
  runCloudSync,
  type SyncCounts,
  type SyncProgress,
  type SyncResult,
} from './cloudSync';

/**
 * Cloud-sync state and triggers.
 *
 * State lives in a zustand store rather than component state so the Settings
 * card and any future indicator observe the same run — a sync can take minutes
 * on a first upload, and it must not restart or lose its status because the
 * user navigated away from Settings.
 */

export type SyncPhase =
  | { kind: 'idle' }
  | { kind: 'checking' }
  /** Account is not in the allowlist. Expected for everyone but the enrolled
   *  account; the UI hides the card entirely in this state. */
  | { kind: 'disabled' }
  | { kind: 'ready' }
  | { kind: 'syncing'; progress: SyncProgress }
  | { kind: 'error'; message: string };

interface SyncStore {
  phase: SyncPhase;
  /** Result of the most recent successful run, for the card. */
  last: (SyncResult & { at: number }) | null;
  /** Cumulative counts across runs this session. */
  session: SyncCounts;
  setPhase: (p: SyncPhase) => void;
  setLast: (r: SyncResult & { at: number }) => void;
  addCounts: (c: SyncCounts) => void;
}

export const useSyncStore = create<SyncStore>((set) => ({
  phase: { kind: 'idle' },
  last: null,
  session: emptyCounts(),
  setPhase: (phase) => set({ phase }),
  setLast: (last) => set({ last }),
  addCounts: (c) =>
    set((s) => ({
      session: {
        gamesPushed: s.session.gamesPushed + c.gamesPushed,
        gamesPulled: s.session.gamesPulled + c.gamesPulled,
        analysesPushed: s.session.analysesPushed + c.analysesPushed,
        analysesPulled: s.session.analysesPulled + c.analysesPulled,
        attemptsPushed: s.session.attemptsPushed + c.attemptsPushed,
        attemptsPulled: s.session.attemptsPulled + c.attemptsPulled,
      },
    })),
}));

/** Module-level so two mounted consumers can't start overlapping runs — the
 *  engine is resumable but concurrent runs would duplicate work and could
 *  interleave writes confusingly. */
let inFlight: Promise<void> | null = null;

/**
 * Mount once, high in the tree (`AppLayout`), alongside `useProfileSync`.
 *
 * Triggers a sync:
 *   - shortly after sign-in, once the allowlist check passes;
 *   - when the analysis queue goes from running to idle, so a batch of
 *     freshly-analyzed games uploads without the user asking;
 *   - on demand from the Settings card.
 *
 * There is deliberately no polling timer. Nothing changes the cloud except this
 * device and the user's other devices, and a timer would burn requests to
 * discover "nothing new" on a project where the user is the only writer.
 */
export function useCloudSync(): void {
  const { isLoaded, isSignedIn, userId } = useEffectiveAuth();
  const supabase = useSupabase();
  const setPhase = useSyncStore((s) => s.setPhase);
  const phaseKind = useSyncStore((s) => s.phase.kind);

  const abortRef = useRef({ aborted: false });
  const enabledRef = useRef(false);

  // ---- allowlist check + first sync -------------------------------------
  useEffect(() => {
    if (!isLoaded || !isSignedIn || !userId) {
      setPhase({ kind: 'idle' });
      enabledRef.current = false;
      return;
    }
    const signal = { aborted: false };
    abortRef.current = signal;
    setPhase({ kind: 'checking' });

    void (async () => {
      // try/catch, not just the returned `error`: a Supabase client can throw
      // synchronously from `.from()` (the E2E bypass stub does, for tables it
      // doesn't model), and an escaping rejection here would show up as a page
      // error in every browser test rather than as a sync state.
      let enabled = false;
      let error: string | undefined;
      try {
        const res = await isSyncEnabled(supabase, userId);
        enabled = res.enabled;
        error = res.error;
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }
      if (signal.aborted) return;
      if (error) {
        // Can't tell — most likely offline, or the tables don't exist yet.
        // That is not the same as "not enrolled", so don't claim that.
        setPhase({ kind: 'error', message: error });
        return;
      }
      if (!enabled) {
        enabledRef.current = false;
        setPhase({ kind: 'disabled' });
        return;
      }
      enabledRef.current = true;
      setPhase({ kind: 'ready' });
      await startSync({ supabase, userId, signal });
    })();

    return () => {
      signal.aborted = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoaded, isSignedIn, userId]);

  // ---- sync when the analysis queue finishes a batch ---------------------
  const queueRunning = useQueueStore((s) => s.running);
  const wasRunning = useRef(queueRunning);
  useEffect(() => {
    const justWentIdle = wasRunning.current && !queueRunning;
    wasRunning.current = queueRunning;
    if (!justWentIdle) return;
    if (!enabledRef.current || !userId) return;
    if (phaseKind === 'syncing') return;
    void startSync({ supabase, userId, signal: abortRef.current });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queueRunning, userId]);
}

/** Imperative trigger shared by the hook and the Settings button. */
export async function startSync(args: {
  supabase: Parameters<typeof runCloudSync>[0]['supabase'];
  userId: string;
  signal?: { aborted: boolean };
}): Promise<void> {
  if (inFlight) return inFlight;
  const { setPhase, setLast, addCounts } = useSyncStore.getState();

  inFlight = (async () => {
    setPhase({
      kind: 'syncing',
      progress: { phase: 'manifest', done: 0, total: 0 },
    });
    try {
      const result = await runCloudSync({
        supabase: args.supabase,
        userId: args.userId,
        signal: args.signal,
        onProgress: (progress) => setPhase({ kind: 'syncing', progress }),
      });
      setLast({ ...result, at: Date.now() });
      addCounts(result);
      setPhase({ kind: 'ready' });
    } catch (err) {
      if (isAbort(err)) {
        setPhase({ kind: 'ready' });
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.error('[cloud-sync] failed:', err);
      setPhase({ kind: 'error', message });
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

/** For the Settings card's "Sync now" button. */
export function useManualSync(): {
  phase: SyncPhase;
  last: (SyncResult & { at: number }) | null;
  session: SyncCounts;
  sessionTotal: number;
  syncNow: () => void;
  canSync: boolean;
} {
  const { userId } = useEffectiveAuth();
  const supabase = useSupabase();
  const phase = useSyncStore((s) => s.phase);
  const last = useSyncStore((s) => s.last);
  const session = useSyncStore((s) => s.session);

  const syncNow = useCallback(() => {
    if (!userId) return;
    void startSync({ supabase, userId });
  }, [supabase, userId]);

  return {
    phase,
    last,
    session,
    sessionTotal: countsTotal(session),
    syncNow,
    canSync:
      Boolean(userId) && phase.kind !== 'syncing' && phase.kind !== 'checking',
  };
}
