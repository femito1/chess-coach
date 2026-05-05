import { useLiveQuery } from 'dexie-react-hooks';
import { countByStatus } from '@/db/queries';
import { useQueueStore } from './queue';

export function QueueIndicator() {
  const counts = useLiveQuery(() => countByStatus(), []);
  const { running, currentPly, currentTotal, paused, setPaused } = useQueueStore();

  if (!counts) return null;
  const pending = counts.pending + counts.running;
  const done = counts.done;
  const total = pending + done + counts.error;

  if (total === 0) return null;

  return (
    <div className="flex items-center gap-3 text-xs">
      {running && currentTotal > 0 ? (
        <div className="flex items-center gap-2">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-accent opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-accent" />
          </span>
          <span className="text-text-muted">
            Analyzing {currentPly}/{currentTotal}
          </span>
        </div>
      ) : pending > 0 ? (
        <span className="text-text-muted">Queued: {pending}</span>
      ) : (
        <span className="text-text-muted">All analyzed</span>
      )}
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
