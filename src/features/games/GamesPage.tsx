import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { listGamesLight, requeueGame } from '@/db/queries';
import { StickyXScroll } from '@/components/StickyXScroll';
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

/** Rows mounted per page. 100 fills any realistic viewport several times
 *  over while keeping the initial commit small enough that navigating to
 *  this tab stays responsive on a multi-thousand-game library. */
const PAGE_SIZE = 100;

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

  // Render in pages. Every row here is 8 cells plus two badges and a
  // link, so a 2.5 k-game library was mounting ~40 k DOM nodes in one
  // synchronous commit — which is what made clicking this tab and
  // immediately clicking away feel stuck. Filtering still runs over the
  // *whole* library (the count below reports real totals); only the
  // number of mounted rows is capped, and "Show more" reveals the rest.
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  // Any filter change resets the window, so narrowing a search doesn't
  // leave the user scrolled into a page that no longer exists.
  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [resultFilter, statusFilter, timeClassSelection, query]);
  const visible = useMemo(
    () => filtered.slice(0, visibleCount),
    [filtered, visibleCount],
  );
  const hiddenCount = filtered.length - visible.length;

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
        {/* Both selects carry a visible field label. Bare "Wins" /
            "Any status" read as free-floating words with no indication
            of what they filter — and "Wins" in particular looks like a
            stat rather than a control. The label sits inside the same
            bordered control so it reads as one unit. */}
        <FilterSelect
          label={t('games.filters.resultLabel')}
          value={resultFilter}
          onChange={(v) => setResultFilter(v as ResultFilter)}
        >
          <option value="all">{t('games.filters.allResults')}</option>
          <option value="win">{t('games.filters.wins')}</option>
          <option value="loss">{t('games.filters.losses')}</option>
          <option value="draw">{t('games.filters.draws')}</option>
        </FilterSelect>
        <FilterSelect
          label={t('games.filters.analysisLabel')}
          value={statusFilter}
          onChange={(v) => setStatusFilter(v as StatusFilter)}
        >
          <option value="all">{t('games.filters.anyStatus')}</option>
          <option value="pending">{t('games.filters.pending')}</option>
          <option value="running">{t('games.filters.running')}</option>
          <option value="done">{t('games.filters.analyzed')}</option>
          <option value="error">{t('games.filters.error')}</option>
        </FilterSelect>
        <TimeClassChips
          selection={timeClassSelection}
          onChange={setTimeClassSelection}
          available={games ?? []}
        />
      </div>

      {/* The 8-column table horizontal-scrolls on narrow viewports rather than
          breaking layout; `min-w-[640px]` is what forces that while still letting
          it fill a wide window. `StickyXScroll` is what makes the scrollbar
          reachable: a plain `overflow-x-auto` card put it at the bottom of the
          *table*, so on a small window you had to scroll several screens down to
          find it, scroll sideways, then come back up. The card is the sticky
          container, so it must not clip — `.card` is only background + border. */}
      <StickyXScroll className="card">
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
            {visible.map((g) => {
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
                  <td className="p-2 max-w-[220px]">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="text-text-muted truncate">
                        {g.opening ?? '—'}
                      </span>
                      <BrilliantBadge count={g.brilliantCount} />
                    </div>
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
            {hiddenCount > 0 && (
              <tr>
                <td colSpan={8} className="p-3 text-center">
                  <button
                    type="button"
                    className="btn text-xs"
                    onClick={() => setVisibleCount((n) => n + PAGE_SIZE)}
                  >
                    {t('games.showMore', {
                      count: Math.min(PAGE_SIZE, hiddenCount),
                      remaining: hiddenCount,
                    })}
                  </button>
                </td>
              </tr>
            )}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={8} className="p-8 text-center text-text-muted">
                  {t('games.noMatches')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </StickyXScroll>
    </div>
  );
}

/**
 * A `<select>` with its field name rendered inline to the left, inside
 * the control's border. Keeps the filter row compact (no stacked labels
 * pushing the row taller) while making it unambiguous what each dropdown
 * acts on. The native select keeps its own arrow and keyboard handling;
 * we only strip its border so the wrapper draws the single outline.
 */
function FilterSelect({
  label,
  value,
  onChange,
  children,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: React.ReactNode;
}) {
  return (
    <label className="flex items-center gap-1.5 rounded-md bg-bg-soft border border-border pl-2.5 pr-1 text-sm focus-within:border-accent/60 focus-within:ring-2 focus-within:ring-accent/30">
      <span className="text-text-muted whitespace-nowrap text-xs">{label}</span>
      {/* Keep a real background on the select itself, not just the
          wrapper: the native option popup inherits the *select's*
          background, so `bg-transparent` here rendered a white menu.
          The dark popup chrome comes from the global `color-scheme: dark`
          in `styles/index.css`. */}
      <select
        className="border-0 bg-bg-soft py-1.5 pr-1 text-sm text-text focus:outline-none focus:ring-0"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {children}
      </select>
    </label>
  );
}

/**
 * Teal `!!` badge marking a game where the user played a brilliancy.
 * `!!` and the `brilliant` colour token are already how the move list
 * and the on-board badge mark these, so the notation carries over
 * without needing a legend.
 *
 * Renders nothing unless the count is a positive number: `undefined`
 * means "not counted yet" (unanalyzed, or analyzed before the backfill
 * ran) and `0` means "counted, none found" — neither should show a
 * badge, and neither should be confused for the other.
 */
function BrilliantBadge({ count }: { count?: number }) {
  const { t } = useTranslation();
  if (!count || count < 1) return null;
  const label = count > 1 ? `!!×${count}` : '!!';
  const title =
    count > 1
      ? t('games.brilliantTitlePlural', { count })
      : t('games.brilliantTitle');
  return (
    <span
      className="shrink-0 rounded px-1 py-0.5 text-[11px] font-mono font-semibold leading-none bg-brilliant/15 text-brilliant"
      title={title}
      aria-label={title}
    >
      {label}
    </span>
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
