import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { Trans, useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { countByStatus, listGamesLight, requeueAllErrors } from '@/db/queries';
import { db } from '@/db/schema';
import { isDue } from '@/srs/sm2';
import { ProgressCharts } from './ProgressCharts';
import { StorageBanner } from './StorageBanner';
import { useThrottledLiveQuery } from '@/lib/useThrottledLiveQuery';
import { totalSecondsPlayed } from './progress';

export function DashboardPage() {
  const { t } = useTranslation();
  // Throttled to 1.5 s. The dashboard's `games` query reads a *light*
  // projection (`listGamesLight` — no PGN) so each refire allocates
  // ~50 KB of metadata instead of ~2 MB of PGN strings. Combined with
  // cached `userTimeSec` (populated by the analyzer / backfill), this
  // keeps the dashboard fast even while the analyzer is firing per-game
  // writes through `useLiveQuery`.
  const counts = useThrottledLiveQuery(() => countByStatus(), [], 1500);
  const games = useThrottledLiveQuery(() => listGamesLight(), [], 1500);
  const duePuzzles = useThrottledLiveQuery(
    async () => {
      const ps = await db.puzzles.toArray();
      return ps.filter((p) => isDue(p.srs)).length;
    },
    [],
    1500,
  );
  const dueRepCards = useThrottledLiveQuery(
    async () => {
      const cs = await db.repertoireCards.toArray();
      return cs.filter((c) => isDue(c.srs)).length;
    },
    [],
    1500,
  );

  const total = games?.length ?? 0;
  const wins = games?.filter((g) => g.result === 'win').length ?? 0;
  const losses = games?.filter((g) => g.result === 'loss').length ?? 0;
  const draws = games?.filter((g) => g.result === 'draw').length ?? 0;
  const decisive = wins + losses + draws;
  const winPct = decisive > 0 ? Math.round((wins / decisive) * 100) : 0;

  // Memoised because `totalSecondsPlayed` parses every PGN to extract
  // clocks. With a 1 k-game library that's non-trivial CPU; we don't
  // want to re-run on every dashboard re-render.
  const hoursPlayed = useMemo(
    () => totalSecondsPlayed(games ?? []) / 3600,
    [games],
  );

  // Analysis status is operational, not a KPI. We only surface it in
  // the dashboard grid when there's something the user might act on:
  // games actively queued/running, errored, or sitting unanalyzed.
  // The QueueIndicator pill handles the live-progress affordance.
  const analyzed = counts?.done ?? 0;
  const queued = (counts?.pending ?? 0) + (counts?.running ?? 0);
  const errored = counts?.error ?? 0;
  const unanalyzed = Math.max(0, total - analyzed - queued - errored);

  const recent = games?.slice(0, 5) ?? [];

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t('dashboard.title')}</h1>
          <p className="text-sm text-text-muted">{t('dashboard.subtitle')}</p>
        </div>
        <Link to="/import" className="btn-primary self-start sm:self-auto">
          {t('dashboard.importGames')}
        </Link>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat label={t('dashboard.stats.games')} value={total} />
        <RecordStat wins={wins} draws={draws} losses={losses} winPct={winPct} />
        <Stat
          label={t('dashboard.stats.avgAccuracy')}
          value={avgAccuracy(games ?? [])}
          suffix={avgAccuracy(games ?? []) === '—' ? '' : '%'}
        />
        <Stat
          label={t('dashboard.stats.hoursPlayed')}
          value={formatHours(hoursPlayed, t)}
        />
      </div>

      <AnalysisStatus
        total={total}
        analyzed={analyzed}
        queued={queued}
        unanalyzed={unanalyzed}
        errored={errored}
        onRetryErrors={() => void requeueAllErrors()}
      />

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <Link to="/weaknesses" className="card p-4 hover:border-accent/60 transition-colors">
          <div className="text-xs text-text-muted">{t('dashboard.studyCards.study')}</div>
          <div className="text-lg font-semibold">{t('dashboard.studyCards.weaknesses')}</div>
          <div className="text-xs text-text-muted mt-1">
            {t('dashboard.studyCards.weaknessesDesc')}
          </div>
        </Link>
        <Link to="/puzzles" className="card p-4 hover:border-accent/60 transition-colors">
          <div className="text-xs text-text-muted">{t('dashboard.studyCards.drill')}</div>
          <div className="text-lg font-semibold">
            {t('dashboard.studyCards.puzzles')}{' '}
            {duePuzzles ? (
              <span className="text-accent">
                {t('dashboard.studyCards.puzzlesDue', { count: duePuzzles })}
              </span>
            ) : null}
          </div>
          <div className="text-xs text-text-muted mt-1">
            {t('dashboard.studyCards.puzzlesDesc')}
          </div>
        </Link>
        <Link to="/repertoire" className="card p-4 hover:border-accent/60 transition-colors">
          <div className="text-xs text-text-muted">{t('dashboard.studyCards.prep')}</div>
          <div className="text-lg font-semibold">
            {t('dashboard.studyCards.repertoire')}{' '}
            {dueRepCards ? (
              <span className="text-accent">
                {t('dashboard.studyCards.repertoireDue', { count: dueRepCards })}
              </span>
            ) : null}
          </div>
          <div className="text-xs text-text-muted mt-1">
            {t('dashboard.studyCards.repertoireDesc')}
          </div>
        </Link>
      </div>

      <StorageBanner />

      <ProgressCharts games={games ?? []} />

      <section className="card p-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-medium">{t('dashboard.recent.title')}</h2>
          <Link to="/games" className="text-xs text-text-muted hover:text-text">
            {t('common.viewAll')}
          </Link>
        </div>
        {recent.length === 0 ? (
          <div className="text-sm text-text-muted py-8 text-center">
            {t('dashboard.recent.empty')}{' '}
            <Link to="/import" className="text-accent">
              {t('dashboard.recent.emptyCta')}
            </Link>
            .
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {recent.map((g) => (
              <li key={g.id} className="py-2 flex items-center gap-3 text-sm">
                <span
                  className={`w-1.5 h-1.5 rounded-full ${
                    g.result === 'win'
                      ? 'bg-good'
                      : g.result === 'loss'
                        ? 'bg-blunder'
                        : 'bg-text-muted'
                  }`}
                />
                <span className="flex-1 truncate">
                  {t('dashboard.recent.vs')}{' '}
                  <span className="font-medium">{g.opponent}</span>
                  <span className="text-text-muted">
                    {' · '}
                    {g.opening ?? t('dashboard.recent.unknownOpening')}
                  </span>
                </span>
                <span className="text-xs text-text-muted">{g.timeClass}</span>
                <Link to={`/review/${g.id}`} className="btn text-xs py-0.5 px-2">
                  {t('common.review')}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
  suffix,
}: {
  label: string;
  value: number | string;
  tone?: 'good' | 'bad';
  suffix?: string;
}) {
  const toneClass = tone === 'good' ? 'text-good' : tone === 'bad' ? 'text-blunder' : '';
  return (
    <div className="card p-4">
      <div className="text-xs text-text-muted">{label}</div>
      <div className={`text-2xl font-semibold ${toneClass}`}>
        {value}
        {suffix}
      </div>
    </div>
  );
}

/** Combined W/D/L stat. Shows the win-rate as the headline number and a
 *  chess.com-style stacked bar with W·D·L counts beneath it, so a single
 *  tile carries the full record without losing the per-bucket detail.
 *  Uses `useTranslation` directly rather than receiving `t` as a prop —
 *  the i18n hook is cheap (one shared subscription via context) and
 *  prop-drilling translation functions across every leaf component
 *  becomes noisy fast. */
function RecordStat({
  wins,
  draws,
  losses,
  winPct,
}: {
  wins: number;
  draws: number;
  losses: number;
  winPct: number;
}) {
  const { t } = useTranslation();
  const total = wins + draws + losses;
  const winW = total > 0 ? (wins / total) * 100 : 0;
  const drawW = total > 0 ? (draws / total) * 100 : 0;
  const lossW = total > 0 ? (losses / total) * 100 : 0;
  return (
    <div className="card p-4 flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <div className="text-xs text-text-muted">{t('dashboard.stats.record')}</div>
        <div className="text-xs text-text-muted tabular-nums">
          <span className="text-good">{t('dashboard.stats.wins', { count: wins })}</span>
          <span> · </span>
          <span>{t('dashboard.stats.draws', { count: draws })}</span>
          <span> · </span>
          <span className="text-blunder">{t('dashboard.stats.losses', { count: losses })}</span>
        </div>
      </div>
      <div className="text-2xl font-semibold tabular-nums">
        {total > 0 ? `${winPct}%` : '—'}
      </div>
      <div
        className="h-1.5 w-full rounded-full bg-bg-raised overflow-hidden flex"
        role="img"
        aria-label={t('dashboard.stats.wdlAria', { wins, draws, losses })}
      >
        {winW > 0 && <div className="h-full bg-good" style={{ width: `${winW}%` }} />}
        {drawW > 0 && <div className="h-full bg-text-muted/60" style={{ width: `${drawW}%` }} />}
        {lossW > 0 && <div className="h-full bg-blunder" style={{ width: `${lossW}%` }} />}
      </div>
    </div>
  );
}

/** Single conditional banner for analysis state. Renders nothing in the
 *  steady state (everything analyzed, nothing queued, no errors) so the
 *  dashboard isn't cluttered with three tiles that are almost always
 *  zero. Surfaces actionable state otherwise:
 *    - errors → red, with retry-all
 *    - queued → accent, "analyzing N games"
 *    - unanalyzed-but-idle → muted, with a hint that import / requeue
 *      will pick them up
 */
function AnalysisStatus({
  total,
  analyzed,
  queued,
  unanalyzed,
  errored,
  onRetryErrors,
}: {
  total: number;
  analyzed: number;
  queued: number;
  unanalyzed: number;
  errored: number;
  onRetryErrors: () => void;
}) {
  const { t } = useTranslation();
  if (total === 0) return null;
  if (queued === 0 && errored === 0 && unanalyzed === 0) return null;

  return (
    <div className="card p-3 flex flex-wrap items-center gap-x-4 gap-y-2">
      <span className="text-sm text-text-muted">
        {/* `<Trans>` renders the embedded `<strong>` tag from the
         *  translation string with the right interpolated values. We
         *  keep the markup in the catalog string so translators can
         *  reorder around it (Portuguese flows the noun before the
         *  number quite differently from English in some sentences). */}
        <Trans
          i18nKey="dashboard.analysis.summary"
          values={{ analyzed, total }}
          components={{ strong: <span className="text-text" /> }}
        />
      </span>
      {queued > 0 && (
        <span className="text-sm text-accent">
          {t('dashboard.analysis.inQueue', { count: queued })}
        </span>
      )}
      {unanalyzed > 0 && queued === 0 && (
        <span className="text-sm text-text-muted">
          {t('dashboard.analysis.pending', { count: unanalyzed })}
        </span>
      )}
      {errored > 0 && (
        <span className="text-sm text-blunder flex items-center gap-2">
          {t('dashboard.analysis.errored', { count: errored })}
          <button type="button" className="btn text-xs" onClick={onRetryErrors}>
            {t('common.retryAll')}
          </button>
        </span>
      )}
    </div>
  );
}

function avgAccuracy(games: ReadonlyArray<{ accuracy?: { white: number; black: number }; userColor: 'white' | 'black' }>): string {
  const withAcc = games.filter((g) => g.accuracy);
  if (withAcc.length === 0) return '—';
  const sum = withAcc.reduce((acc, g) => acc + (g.userColor === 'white' ? g.accuracy!.white : g.accuracy!.black), 0);
  return (sum / withAcc.length).toFixed(1);
}

/** Compact hours-played formatter. Below an hour we show minutes; below
 *  ten hours we keep one decimal of precision (so 6.4 h doesn't round to
 *  6 h on a few short sessions); past that we show whole hours since
 *  the decimal is just noise. The unit suffix flows through i18n so
 *  pt-BR can render the same string ("min" / "h" both happen to be the
 *  same in pt-BR, but a future locale could differ — e.g. ja-JP "分" /
 *  "時間"). Receives `t` as a parameter rather than calling
 *  `useTranslation` because it's a plain helper, not a component, and
 *  hooks must only be called from React render paths. */
function formatHours(h: number, t: TFunction): string {
  if (!Number.isFinite(h) || h <= 0) return '—';
  if (h < 1) return t('dashboard.format.minutes', { value: Math.round(h * 60) });
  if (h < 10) return t('dashboard.format.hours', { value: h.toFixed(1) });
  return t('dashboard.format.hours', { value: Math.round(h) });
}
