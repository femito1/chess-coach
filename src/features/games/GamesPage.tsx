import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { listGamesLight, requeueGame } from '@/db/queries';
import type {
  AnalysisStatus,
  GameResult,
  TimeClass,
  TimeClassSelection,
} from '@/db/schema';
import { useThrottledLiveQuery } from '@/lib/useThrottledLiveQuery';
import { TimeClassChips } from '@/components/TimeClassFilter';
import { gameMatchesSelection } from '@/lib/timeClass';
import { usePersistedState } from '@/lib/usePersistedState';

type ResultFilter = 'all' | GameResult;
type StatusFilter = 'all' | AnalysisStatus;

const RESULT_VALUES: readonly ResultFilter[] = ['all', 'win', 'loss', 'draw', 'unknown'];
const STATUS_VALUES: readonly StatusFilter[] = [
  'all',
  'pending',
  'running',
  'done',
  'error',
];
const TIME_CLASS_VALUES: readonly TimeClass[] = [
  'bullet',
  'blitz',
  'rapid',
  'classical',
  'daily',
];
/** The chip bar uses this sentinel to represent "deselect all" while
 *  keeping the persisted shape `TimeClass[]`-compatible (see the
 *  comment in `src/lib/timeClass.ts`). It's not a real `TimeClass`
 *  value — we accept it on read for round-trip stability. */
const TIME_CLASS_SENTINEL = '__none__';

function isResultFilter(v: unknown): v is ResultFilter {
  return typeof v === 'string' && (RESULT_VALUES as readonly string[]).includes(v);
}
function isStatusFilter(v: unknown): v is StatusFilter {
  return typeof v === 'string' && (STATUS_VALUES as readonly string[]).includes(v);
}
function isTimeClassSelection(v: unknown): v is TimeClassSelection {
  if (!Array.isArray(v)) return false;
  return v.every(
    (item) =>
      item === TIME_CLASS_SENTINEL ||
      (typeof item === 'string' && (TIME_CLASS_VALUES as readonly string[]).includes(item)),
  );
}

export function GamesPage() {
  const { t } = useTranslation();
  // Throttled + light projection: the page only needs metadata
  // (opponent, opening, result, accuracy, time class) for the table
  // rows. Without `pgn` the per-refire allocation drops from ~2 MB to
  // ~50 KB on a 1 k-game library, which removes the dominant cause of
  // page lag during analysis runs.
  const games = useThrottledLiveQuery(() => listGamesLight(), [], 1000);
  // The live search query is intentionally NOT persisted — typing a
  // throwaway opponent name shouldn't leak into the next session.
  // The structural filters (result / status / time class) ARE
  // persisted because the user's preference for "rapid only" is the
  // kind of thing they expect to survive reloads, and the lack of
  // persistence on this page (vs the Weaknesses + dashboard pages
  // that already persist) was the user's specific complaint.
  const [query, setQuery] = useState('');
  const [resultFilter, setResultFilter] = usePersistedState<ResultFilter>(
    'games:result-filter',
    'all',
    { isValid: isResultFilter },
  );
  const [statusFilter, setStatusFilter] = usePersistedState<StatusFilter>(
    'games:status-filter',
    'all',
    { isValid: isStatusFilter },
  );
  const [timeClassSelection, setTimeClassSelection] =
    usePersistedState<TimeClassSelection>(
      'games:time-class-selection',
      [],
      { isValid: isTimeClassSelection },
    );

  const filtered = useMemo(() => {
    if (!games) return [];
    return games.filter((g) => {
      if (resultFilter !== 'all' && g.result !== resultFilter) return false;
      if (statusFilter !== 'all' && g.analysisStatus !== statusFilter) return false;
      if (!gameMatchesSelection(g, timeClassSelection)) return false;
      if (query) {
        const q = query.toLowerCase();
        const hay = `${g.opponent} ${g.opening ?? ''} ${g.eco ?? ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [games, resultFilter, statusFilter, timeClassSelection, query]);

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t('games.title')}</h1>
          <p className="text-sm text-text-muted">{t('games.filteredCount', { filtered: filtered.length, total: games?.length ?? 0 })}</p>
        </div>
      </div>

      <div className="card p-3 flex flex-wrap gap-2 items-center text-sm">
        <input
          className="input flex-1 min-w-[200px]"
          placeholder={t('games.searchPlaceholder')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select
          className="input w-auto"
          value={resultFilter}
          onChange={(e) => setResultFilter(e.target.value as ResultFilter)}
        >
          <option value="all">{t('games.filters.allResults')}</option>
          <option value="win">{t('games.filters.wins')}</option>
          <option value="loss">{t('games.filters.losses')}</option>
          <option value="draw">{t('games.filters.draws')}</option>
        </select>
        <select
          className="input w-auto"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
        >
          <option value="all">{t('games.filters.anyStatus')}</option>
          <option value="pending">{t('games.filters.pending')}</option>
          <option value="running">{t('games.filters.running')}</option>
          <option value="done">{t('games.filters.analyzed')}</option>
          <option value="error">{t('games.filters.error')}</option>
        </select>
        <TimeClassChips
          selection={timeClassSelection}
          onChange={setTimeClassSelection}
          available={games ?? []}
        />
      </div>

      {/* Card wraps an overflow-x-auto scroller so the 8-column table
          can horizontal-scroll on phones instead of breaking layout.
          `min-w-[640px]` on the table forces the horizontal scroll on
          narrow viewports while still letting the table fill wide ones. */}
      <div className="card overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm">
          <thead className="bg-bg-raised text-text-muted text-xs">
            <tr>
              <th className="text-left p-2 font-medium">{t('games.table.date')}</th>
              <th className="text-left p-2 font-medium">{t('games.table.opponent')}</th>
              <th className="text-left p-2 font-medium">{t('games.table.opening')}</th>
              <th className="text-left p-2 font-medium">{t('games.table.result')}</th>
              <th className="text-left p-2 font-medium">{t('games.table.time')}</th>
              <th className="text-left p-2 font-medium">{t('games.table.accuracy')}</th>
              <th className="text-left p-2 font-medium">{t('games.table.status')}</th>
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
                      {t('games.table.youAs', { color: g.userColor === 'white' ? t('common.white').toLowerCase() : t('common.black').toLowerCase() })}
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
                        {t('games.retry')}
                      </button>
                    )}
                    <Link to={`/review/${g.id}`} className="btn-primary text-xs py-0.5 px-2">
                      {t('games.review')}
                    </Link>
                  </td>
                </tr>
              );
            })}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={8} className="p-8 text-center text-text-muted">
                  {t('games.noMatches')}
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
  const { t } = useTranslation();
  const cls =
    result === 'win'
      ? 'bg-good/15 text-good'
      : result === 'loss'
        ? 'bg-blunder/15 text-blunder'
        : 'bg-bg-raised text-text-muted';
  const label = t(`games.result.${result}`);
  return <span className={`px-2 py-0.5 rounded text-xs ${cls}`}>{label}</span>;
}

function StatusBadge({ status, error }: { status: AnalysisStatus; error?: string }) {
  const { t } = useTranslation();
  const map: Record<AnalysisStatus, string> = {
    pending: 'bg-bg-raised text-text-muted',
    running: 'bg-accent/15 text-accent',
    done: 'bg-good/15 text-good',
    error: 'bg-blunder/15 text-blunder',
  };
  return (
    <span className={`px-2 py-0.5 rounded text-xs ${map[status]}`} title={error ?? ''}>
      {t(`games.status.${status}`)}
    </span>
  );
}
