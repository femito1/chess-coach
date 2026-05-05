import { useLiveQuery } from 'dexie-react-hooks';
import { countByStatus } from '@/db/queries';
import { useQueueStore } from './queue';

/**
 * Floating analysis-queue status pill in the bottom-right of the
 * viewport. Lives outside the header flex flow so its width changes
 * (e.g. "Analyzing 198/200" vs "Queued: 3") cannot push the logo, nav,
 * or profile chip around — that bug used to wrap "Chess Coach" onto
 * two lines whenever analysis kicked in.
 *
 * Hidden completely when there's nothing to communicate (no games at
 * all, or every game finished without errors and the queue is idle).
 */
export function QueueIndicator() {
  const counts = useLiveQuery(() => countByStatus(), []);
  const { running, currentPly, currentTotal, paused, setPaused } = useQueueStore();

  if (!counts) return null;
  const pending = counts.pending + counts.running;
  const done = counts.done;
  const errors = counts.error;
  const total = pending + done + errors;

  if (total === 0) return null;
  // Idle + everything analyzed cleanly: no signal to surface.
  if (!running && pending === 0 && errors === 0) return null;

  return (
    <div
      className="fixed bottom-4 right-4 z-20 card flex items-center gap-3 text-xs px-3 py-2 shadow-lg whitespace-nowrap tabular-nums"
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
