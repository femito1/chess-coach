import { useEffect, useMemo, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import {
  db,
  getSettings,
  normalizeTimeClassSelection,
  updateSettings,
} from '@/db/schema';
import type { Analysis, TimeClassSelection } from '@/db/schema';
import { listAllGamesLight } from '@/db/queries';
import { aggregateMistakes, type MistakeRow } from './aggregate';
import { TimeClassChips } from '@/components/TimeClassFilter';
import { Board } from '@/components/Board';
import { THUMBNAIL_BOARD_MAX_PX } from '@/components/BoardFrame';
import { EvalBar } from '@/components/EvalBar';
import { gameMatchesSelection } from '@/lib/timeClass';
import { useThrottledLiveQuery } from '@/lib/useThrottledLiveQuery';
import { tClassification, tMotifExplain, tMotifLabel, tTimeClassSelection } from '@/i18n/chess';
import { Chess } from 'chess.js';

export function WeaknessesPage() {
  const { t } = useTranslation();
  // Throttled to 1 s: the analyzer can fire hundreds of `db.games`
  // writes per minute during a queue run. We pull a *light* projection
  // (no PGN) since the aggregator only needs metadata + the analyses
  // table. Without the projection a 1 k-game library would haul ~2 MB
  // of PGN into memory on every refire — the dominant cause of the
  // mid-analysis page hangs the user reported on prod.
  const games = useThrottledLiveQuery(() => listAllGamesLight(), [], 1000);
  const [filter, setFilter] = useState<TimeClassSelection>(['rapid']);

  useEffect(() => {
    void getSettings().then((s) => {
      setFilter(normalizeTimeClassSelection(s.timeClassFilter));
    });
  }, []);

  const filteredGames = useMemo(
    () => (games ?? []).filter((g) => gameMatchesSelection(g, filter)),
    [games, filter],
  );

  // Only fetch analyses for the games that survive the time-class
  // filter. Each Analysis carries the full move list (often 40-100
  // entries × hundreds of bytes each), so bypassing irrelevant
  // analyses is a meaningful RAM saving on a multi-time-class library.
  const analyses = useThrottledLiveQuery(
    async () => {
      if (filteredGames.length === 0) return [] as Analysis[];
      const ids = filteredGames.map((g) => g.id);
      const rows = await db.analyses.bulkGet(ids);
      return rows.filter((a): a is Analysis => Boolean(a));
    },
    [filteredGames],
    1000,
  );

  const agg = useMemo(() => {
    if (!analyses) return null;
    const map = new Map<string, Analysis>();
    for (const a of analyses) map.set(a.gameId, a);
    return aggregateMistakes(filteredGames, map);
  }, [filteredGames, analyses]);

  function onFilterChange(next: TimeClassSelection) {
    setFilter(next);
    void updateSettings({ timeClassFilter: next });
  }

  if (!games || !analyses) {
    return <div className="text-text-muted">{t('common.loading')}</div>;
  }

  const analyzedGames = filteredGames.filter((g) => g.analysisStatus === 'done').length;
  const filterLabel = tTimeClassSelection(t, filter).toLowerCase();

  const header = (
    <div className="flex items-end justify-between gap-4 flex-wrap">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t('weaknesses.title')}</h1>
        <p className="text-sm text-text-muted">
          {analyzedGames === 0
            ? t('weaknesses.subtitleEmpty')
            : t('weaknesses.subtitle', { count: analyzedGames, label: filterLabel })}
        </p>
      </div>
      <TimeClassChips
        selection={filter}
        onChange={onFilterChange}
        available={games}
      />
    </div>
  );

  const isAll = filter.length === 0;
  if (!agg || analyzedGames === 0) {
    return (
      <div className="space-y-6">
        {header}
        <div className="card p-8 text-center text-text-muted space-y-2">
          <div className="text-lg">
            {isAll ? t('weaknesses.noAnalyzed') : t('weaknesses.noAnalyzedFiltered', { label: filterLabel })}
          </div>
          <div className="text-sm">
            {isAll ? (
              <Trans
                i18nKey="weaknesses.noAnalyzedHelpAll"
                components={{ lnk: <Link to="/import" className="text-accent" /> }}
              />
            ) : (
              <Trans
                i18nKey="weaknesses.noAnalyzedHelpFilter"
                components={{ lnk: <Link to="/import" className="text-accent" /> }}
              />
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {header}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label={t('weaknesses.stats.totalMistakes')} value={agg.totalMistakes} />
        <StatCard
          label={t('weaknesses.stats.openingDrops')}
          value={agg.byPhase.opening.count}
          sub={pct(agg.byPhase.opening.avgDrop)}
        />
        <StatCard
          label={t('weaknesses.stats.middlegameDrops')}
          value={agg.byPhase.middlegame.count}
          sub={pct(agg.byPhase.middlegame.avgDrop)}
        />
        <StatCard
          label={t('weaknesses.stats.endgameDrops')}
          value={agg.byPhase.endgame.count}
          sub={pct(agg.byPhase.endgame.avgDrop)}
        />
      </div>

      <section className="card p-4">
        <h2 className="font-medium mb-3">{t('weaknesses.tacticalMotifs')}</h2>
        {agg.byMotif.length === 0 ? (
          <div className="text-sm text-text-muted">{t('weaknesses.noMotifsYet')}</div>
        ) : (
          <div className="space-y-3">
            {agg.byMotif.map((m) => (
              <div key={m.motif} className="border border-border rounded-md p-3 bg-bg-raised/30">
                <div className="flex items-baseline justify-between">
                  <div className="font-medium">{tMotifLabel(t, m.motif)}</div>
                  <div className="text-accent font-mono">{m.count}</div>
                </div>
                <p className="mt-1 text-xs text-text-muted leading-relaxed">
                  {tMotifExplain(t, m.motif)}
                </p>
                <ul className="mt-3 divide-y divide-border">
                  {m.examples.map((ex) => (
                    <MistakeExample
                      key={`${ex.gameId}-${ex.ply}`}
                      row={ex}
                    />
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="card p-4">
        <h2 className="font-medium mb-3">{t('weaknesses.timePressure')}</h2>
        <div className="grid grid-cols-2 gap-4 text-sm">
          <TimePressureCard
            title={t('weaknesses.timePressureCardInTrouble')}
            total={agg.byTimePressure.inTrouble.count}
            mistakes={agg.byTimePressure.inTrouble.mistakes}
            rate={agg.byTimePressure.inTrouble.rate}
            bad
          />
          <TimePressureCard
            title={t('weaknesses.timePressureCardNormal')}
            total={agg.byTimePressure.normal.count}
            mistakes={agg.byTimePressure.normal.mistakes}
            rate={agg.byTimePressure.normal.rate}
          />
        </div>
        <div className="text-xs text-text-muted mt-2">
          {t('weaknesses.timePressureFootnote')}
        </div>
      </section>

      <section className="card p-4">
        <h2 className="font-medium mb-3">{t('weaknesses.openingsTitle')}</h2>
        {agg.byOpening.length === 0 ? (
          <div className="text-sm text-text-muted">{t('weaknesses.openingsEmpty')}</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-text-muted text-xs">
              <tr>
                <th className="text-left p-2 font-medium">{t('weaknesses.openingsTableOpening')}</th>
                <th className="text-right p-2 font-medium">{t('weaknesses.openingsTableGames')}</th>
                <th className="text-right p-2 font-medium">{t('weaknesses.openingsTableMistakes')}</th>
                <th className="text-right p-2 font-medium">{t('weaknesses.openingsTableYourAcc')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {agg.byOpening.slice(0, 10).map((o) => (
                <tr key={o.opening} className="hover:bg-bg-raised/60">
                  <td className="p-2 truncate max-w-[400px]">{o.opening}</td>
                  <td className="p-2 text-right font-mono">{o.games}</td>
                  <td className="p-2 text-right font-mono">{o.mistakes}</td>
                  <td className="p-2 text-right font-mono">{o.avgAcc.toFixed(1)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

    </div>
  );
}

function StatCard({ label, value, sub }: { label: string; value: number | string; sub?: string }) {
  const { t } = useTranslation();
  return (
    <div className="card p-4">
      <div className="text-xs text-text-muted">{label}</div>
      <div className="text-2xl font-semibold">{value}</div>
      {sub && <div className="text-xs text-text-muted">{t('weaknesses.stats.avgDrop', { pct: sub })}</div>}
    </div>
  );
}

function TimePressureCard({
  title,
  total,
  mistakes,
  rate,
  bad,
}: {
  title: string;
  total: number;
  mistakes: number;
  rate: number;
  bad?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className={`border rounded-md p-3 ${bad ? 'border-blunder/40 bg-blunder/5' : 'border-border bg-bg-raised/30'}`}>
      <div className="text-xs text-text-muted uppercase tracking-wide">{title}</div>
      <div className="mt-1 text-lg font-semibold">{(rate * 100).toFixed(1)}%</div>
      <div className="text-xs text-text-muted">
        {t('weaknesses.timePressureMistakes', { mistakes, total })}
      </div>
    </div>
  );
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

/**
 * One example row inside a motif card. Click to expand into a mini
 * board preview showing the FEN before the mistake, the move the user
 * played (highlighted as the wrong move), and the move the engine
 * preferred (drawn as a green arrow). An EvalBar sits to the left of
 * the board mirroring the rhythm of the review page.
 *
 * Why expand-in-place vs. just routing to `/review/:id?ply=N`: from
 * Pass 4 user-feedback, clicking through to the review page jumped the
 * board to the position *after* the mistake (no move highlighted, no
 * "this is the bad move" framing) and the user had to navigate
 * backwards to even see what move was being criticised. The inline
 * preview answers "what was the move and what was wrong with it"
 * before the user commits to a full deep-link review.
 *
 * The "Review in full" button still routes to `/review/:id?ply=N`,
 * additionally appending `?from=weakness` so the review page can
 * surface a banner explaining the deep-link context (and pre-position
 * the board exactly on the offending ply).
 */
function MistakeExample({ row }: { row: MistakeRow }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);

  return (
    <li className="py-2">
      <div className="flex items-center gap-2 text-sm">
        <button
          type="button"
          onClick={() => setExpanded((x) => !x)}
          className="text-text-muted hover:text-text shrink-0 w-5"
          aria-label={expanded ? t('weaknesses.collapseExample') : t('weaknesses.expandExample')}
          title={expanded ? t('weaknesses.collapse') : t('weaknesses.expandToSeePosition')}
        >
          {expanded ? '▼' : '▶'}
        </button>
        <span className="font-mono w-16 shrink-0">{row.san}</span>
        <span className="truncate flex-1 text-xs text-text-muted">
          {t('weaknesses.vsOpponent', { opponent: row.opponent })}
          {row.bestMoveSan && (
            <>
              {' \u00b7 '}{t('weaknesses.engineWanted')}{' '}
              <span className="font-mono text-good">{row.bestMoveSan}</span>
            </>
          )}
        </span>
        <Link
          to={buildReviewLink(row)}
          className="text-accent hover:underline shrink-0 text-xs"
        >
          {t('weaknesses.reviewInFull')}
        </Link>
      </div>
      {expanded && (
        <div className="mt-3">
          <ExpandedMistake row={row} />
        </div>
      )}
    </li>
  );
}

/**
 * Build the deep-link the "Review in full" button uses. We pin three
 * params:
 *  - `ply`        — jump straight to the offending position. Existing
 *                   behaviour, kept so the URL still works on its own.
 *  - `from`       — `'weakness'`. Tells the review page to render the
 *                   "you came from the weaknesses page" banner.
 *  - `motifs`     — comma-separated motif keys that this row was tagged
 *                   with. Lets the banner enumerate motif explanations
 *                   without re-reading the analysis row. Capped at the
 *                   first three so the URL stays sane.
 */
function buildReviewLink(row: MistakeRow): string {
  const params = new URLSearchParams();
  params.set('ply', String(row.ply));
  params.set('from', 'weakness');
  if (row.motifs.length > 0) {
    params.set('motifs', row.motifs.slice(0, 3).join(','));
  }
  return `/review/${row.gameId}?${params.toString()}`;
}

function ExpandedMistake({ row }: { row: MistakeRow }) {
  const { t } = useTranslation();
  // Compute fenAfter (= the position the user *landed on* after their
  // mistake, before the engine's reply) so we can render the played
  // move's last-move highlight cleanly. Falls back to fenBefore when
  // we can't replay the move (corrupt UCI / illegal move — shouldn't
  // happen for stored analyses but defensive code is cheap).
  const fenAfter = useMemo(() => {
    if (!row.uci) return row.fenBefore;
    try {
      const c = new Chess(row.fenBefore);
      const m = c.move({
        from: row.uci.slice(0, 2),
        to: row.uci.slice(2, 4),
        promotion: row.uci.slice(4, 5) || undefined,
      });
      if (!m) return row.fenBefore;
      return c.fen();
    } catch {
      return row.fenBefore;
    }
  }, [row.fenBefore, row.uci]);

  // Mover-POV orientation. Mover side is `row.userColor` because
  // aggregator only emits rows where the mover is the user.
  const orientation = row.userColor;
  const bestArrow = row.bestMoveUci
    ? [
        {
          from: row.bestMoveUci.slice(0, 2),
          to: row.bestMoveUci.slice(2, 4),
          brush: 'engineBest' as const,
        },
      ]
    : [];

  return (
    <div className="bg-bg-soft rounded-md p-3 space-y-2">
      <p className="text-xs text-text-muted leading-relaxed">
        {row.userColor === 'white' ? t('weaknesses.youPlayedWhite') : t('weaknesses.youPlayedBlack')}{' '}
        {t('weaknesses.onMovePlayed', { move: Math.ceil(row.ply / 2) })}{' '}
        <span className="font-mono text-blunder font-semibold">{row.san}</span>
        {row.bestMoveSan ? (
          <>
            {' '}— {t('weaknesses.engineEnginePreferred')}{' '}
            <span className="font-mono text-good font-semibold">
              {row.bestMoveSan}
            </span>
            .
          </>
        ) : (
          '.'
        )}{' '}
        {t('weaknesses.classifiedAs')}{' '}<span className="font-medium">
          {tClassification(t, row.classification)}
        </span>
        {row.inTimeTrouble && (
          <>
            {' '}<span className="text-mistake">{t('weaknesses.playedInTimeTrouble')}</span>
          </>
        )}
        .
      </p>
      <div
        className="mx-auto w-full flex gap-2 items-stretch"
        style={{ maxWidth: `min(${THUMBNAIL_BOARD_MAX_PX}px, 80vw)` }}
      >
        <EvalBar
          cpWhite={row.evalCpBefore}
          orientation={orientation}
        />
        <div className="flex-1 min-w-0">
          <Board
            fen={fenAfter}
            orientation={orientation}
            lastMoveUci={row.uci}
            lastMoveClassification={row.classification}
            arrows={bestArrow}
            viewOnly
          />
        </div>
      </div>
      <p className="text-[11px] text-text-muted">
        {t('weaknesses.evalBarShows')}
      </p>
    </div>
  );
}
