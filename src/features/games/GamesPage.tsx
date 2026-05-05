import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { listGames, requeueGame } from '@/db/queries';
import type { AnalysisStatus, GameResult } from '@/db/schema';
import { useThrottledLiveQuery } from '@/lib/useThrottledLiveQuery';

type ResultFilter = 'all' | GameResult;
type StatusFilter = 'all' | AnalysisStatus;

export function GamesPage() {
  // Throttled — `listGames()` pulls every game (with PGN). Without
  // throttling the analyzer's per-move writes refetch the whole table on
  // each move, which is the dominant cause of lag while the queue runs.
  const games = useThrottledLiveQuery(() => listGames(), [], 1000);
  const [query, setQuery] = useState('');
  const [resultFilter, setResultFilter] = useState<ResultFilter>('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [timeClass, setTimeClass] = useState<string>('all');

  const timeClasses = useMemo(() => {
    if (!games) return [];
    return Array.from(new Set(games.map((g) => g.timeClass).filter((x): x is string => !!x)));
  }, [games]);

  const filtered = useMemo(() => {
    if (!games) return [];
    return games.filter((g) => {
      if (resultFilter !== 'all' && g.result !== resultFilter) return false;
      if (statusFilter !== 'all' && g.analysisStatus !== statusFilter) return false;
      if (timeClass !== 'all' && g.timeClass !== timeClass) return false;
      if (query) {
        const q = query.toLowerCase();
        const hay = `${g.opponent} ${g.opening ?? ''} ${g.eco ?? ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [games, resultFilter, statusFilter, timeClass, query]);

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Games</h1>
          <p className="text-sm text-text-muted">{filtered.length} of {games?.length ?? 0} games</p>
        </div>
      </div>

      <div className="card p-3 flex flex-wrap gap-2 text-sm">
        <input
          className="input flex-1 min-w-[200px]"
          placeholder="Search opponent, opening…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select
          className="input w-auto"
          value={resultFilter}
          onChange={(e) => setResultFilter(e.target.value as ResultFilter)}
        >
          <option value="all">All results</option>
          <option value="win">Wins</option>
          <option value="loss">Losses</option>
          <option value="draw">Draws</option>
        </select>
        <select
          className="input w-auto"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
        >
          <option value="all">Any status</option>
          <option value="pending">Pending</option>
          <option value="running">Running</option>
          <option value="done">Analyzed</option>
          <option value="error">Error</option>
        </select>
        <select
          className="input w-auto"
          value={timeClass}
          onChange={(e) => setTimeClass(e.target.value)}
        >
          <option value="all">All time controls</option>
          {timeClasses.map((tc) => (
            <option key={tc} value={tc}>
              {tc}
            </option>
          ))}
        </select>
      </div>

      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-bg-raised text-text-muted text-xs">
            <tr>
              <th className="text-left p-2 font-medium">Date</th>
              <th className="text-left p-2 font-medium">Opponent</th>
              <th className="text-left p-2 font-medium">Opening</th>
              <th className="text-left p-2 font-medium">Result</th>
              <th className="text-left p-2 font-medium">Time</th>
              <th className="text-left p-2 font-medium">Accuracy</th>
              <th className="text-left p-2 font-medium">Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {filtered.map((g) => {
              const userAcc = g.accuracy
                ? g.userColor === 'white'
                  ? g.accuracy.white
                  : g.accuracy.black
                : null;
              return (
                <tr key={g.id} className="hover:bg-bg-raised/60">
                  <td className="p-2 text-text-muted whitespace-nowrap">
                    {new Date(g.endTime).toLocaleDateString()}
                  </td>
                  <td className="p-2">
                    <span className="font-medium">{g.opponent}</span>
                    {g.opponentRating && (
                      <span className="text-text-muted"> ({g.opponentRating})</span>
                    )}
                    <div className="text-xs text-text-muted">
                      you as {g.userColor}
                      {g.userRating ? ` (${g.userRating})` : ''}
                    </div>
                  </td>
                  <td className="p-2 text-text-muted truncate max-w-[200px]">
                    {g.opening ?? '—'}
                  </td>
                  <td className="p-2">
                    <ResultBadge result={g.result} />
                  </td>
                  <td className="p-2 text-text-muted">{g.timeClass ?? g.timeControl}</td>
                  <td className="p-2 font-mono">{userAcc != null ? `${userAcc}%` : '—'}</td>
                  <td className="p-2">
                    <StatusBadge status={g.analysisStatus} error={g.analysisError} />
                  </td>
                  <td className="p-2 text-right whitespace-nowrap">
                    {g.analysisStatus === 'error' && (
                      <button
                        type="button"
                        className="btn text-xs py-0.5 px-2 mr-1"
                        onClick={() => requeueGame(g.id)}
                      >
                        Retry
                      </button>
                    )}
                    <Link to={`/review/${g.id}`} className="btn-primary text-xs py-0.5 px-2">
                      Review
                    </Link>
                  </td>
                </tr>
              );
            })}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={8} className="p-8 text-center text-text-muted">
                  No games match your filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ResultBadge({ result }: { result: GameResult }) {
  const cls =
    result === 'win'
      ? 'bg-good/15 text-good'
      : result === 'loss'
        ? 'bg-blunder/15 text-blunder'
        : 'bg-bg-raised text-text-muted';
  const label = result === 'unknown' ? '?' : result[0].toUpperCase() + result.slice(1);
  return <span className={`px-2 py-0.5 rounded text-xs ${cls}`}>{label}</span>;
}

function StatusBadge({ status, error }: { status: AnalysisStatus; error?: string }) {
  const map: Record<AnalysisStatus, string> = {
    pending: 'bg-bg-raised text-text-muted',
    running: 'bg-accent/15 text-accent',
    done: 'bg-good/15 text-good',
    error: 'bg-blunder/15 text-blunder',
  };
  return (
    <span className={`px-2 py-0.5 rounded text-xs ${map[status]}`} title={error ?? ''}>
      {status}
    </span>
  );
}
