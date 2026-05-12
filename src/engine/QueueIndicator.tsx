import { useEffect, useState } from 'react';
import { countByStatus } from '@/db/queries';
import { useQueueStore } from './queue';
import type { AnalysisStatus } from '@/db/schema';

/**
 * Floating analysis-queue status pill in the bottom-right of the
 * viewport. Lives outside the header flex flow so its width changes
 * (e.g. "Analyzing 198/200" vs "Queued: 3") cannot push the logo, nav,
 * or profile chip around — that bug used to wrap "Chess Coach" onto
 * two lines whenever analysis kicked in.
 *
 * Hidden completely when there's nothing to communicate (no games at
 * all, or every game finished without errors and the queue is idle).
 *
 * Performance note: we deliberately do NOT use `useLiveQuery` here.
 * `countByStatus` reads the `games` table; with `useLiveQuery`, every
 * single per-move write the analyzer makes (and there are *thousands*
 * during a queue run) would re-fire all four indexed counts AND
 * re-render the always-mounted layout. Instead we poll on a slow
 * interval when the queue is running and only re-count on queue
 * state transitions (start / stop / current-game-change) plus the
 * initial mount. That's enough to keep the pill accurate without
 * making the rest of the app feel glued to the engine.
 */
const POLL_RUNNING_MS = 1500;
const POLL_IDLE_MS = 5000;

export function QueueIndicator() {
  const { running, currentPly, currentTotal, currentGameId, paused, setPaused } =
    useQueueStore();
  const [counts, setCounts] = useState<Record<AnalysisStatus, number> | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      if (cancelled) return;
      try {
        const next = await countByStatus();
        if (!cancelled) setCounts(next);
      } catch {
        /* ignore — UI-only signal */
      }
      if (cancelled) return;
      timer = setTimeout(tick, running ? POLL_RUNNING_MS : POLL_IDLE_MS);
    };

    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // We re-establish the polling loop whenever the queue's "running"
    // state flips OR the current game changes. That way new imports show
    // up promptly in the pill without us watching every single move
    // write through Dexie's table-change firehose.
  }, [running, currentGameId]);

  if (!counts) return null;
  const pending = counts.pending + counts.running;
  const done = counts.done;
  const errors = counts.error;
  const total = pending + done + errors;

  if (total === 0) return null;
  if (!running && pending === 0 && errors === 0) return null;

  return (
    <div
      className="fixed bottom-3 right-3 sm:bottom-4 sm:right-4 z-20 card flex items-center gap-2 sm:gap-3 text-[11px] sm:text-xs px-2.5 sm:px-3 py-1.5 sm:py-2 shadow-lg whitespace-nowrap tabular-nums max-w-[calc(100vw-1.5rem)]"
      role="status"
      aria-live="polite"
    >
      {running && currentTotal > 0 ? (
        <div className="flex items-center gap-2">
          <span className="relative flex h-2 w-2 shrink-0">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-accent opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-accent" />
          </span>
          <span className="text-text-muted">
            Analyzing {currentPly}/{currentTotal}
          </span>
        </div>
      ) : pending > 0 ? (
        <span className="text-text-muted">Queued: {pending}</span>
      ) : errors > 0 ? (
        <span className="text-blunder">{errors} error{errors === 1 ? '' : 's'}</span>
      ) : null}
      <span className="text-text-muted">
        {done}/{total} done
      </span>
      <button
        type="button"
        onClick={() => setPaused(!paused)}
        className="btn text-xs px-2 py-1"
        title={paused ? 'Resume queue' : 'Pause queue'}
      >
        {paused ? 'Resume' : 'Pause'}
      </button>
    </div>
  );
}
