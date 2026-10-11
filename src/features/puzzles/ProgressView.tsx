import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PuzzleAttempt, PuzzleOutcome } from '@/db/schema';
import { MiniBoard } from '@/components/MiniBoard';
import { requestAttemptSync } from '@/features/sync/useCloudSync';
import { backfillAttemptContent } from './attempts';
import type { PuzzleRating, RatingPoint } from './rating';
import {
  MIN_THEME_SAMPLE,
  activityByDay,
  bandStats,
  dayKey,
  overallStats,
  summarize,
  themeStats,
  type PuzzleSummary,
  type ThemeStat,
} from './stats';
import { formatThemeName } from './themeLabels';
import { OUTCOME_DOT } from './LibraryPuzzleSolver';

/**
 * The Progress view: what your puzzle history says, and every puzzle in it.
 *
 * Each block answers one question a player actually asks, and points at
 * what to do about it:
 *
 *  - **Am I improving?** Rating + its recent trend.
 *  - **How do I lose puzzles?** First-try rate vs move accuracy. 40% first
 *    try with 85% move accuracy is "I find the idea and slip at the end" —
 *    a calculation problem — which pass/fail alone can't distinguish from
 *    "I don't see the idea".
 *  - **Where's my ceiling?** Success by puzzle rating.
 *  - **What should I train?** Themes ranked by performance *against your own
 *    rating*, each one click from a run of that theme.
 *  - **What did I do?** The history grid, every puzzle re-playable.
 */

export function ProgressView({
  rows,
  loaded,
  rating,
  now,
  reviewDue,
  onOpen,
  onTrainTheme,
}: {
  rows: readonly PuzzleAttempt[];
  loaded: boolean;
  rating: PuzzleRating;
  now: number;
  reviewDue: number;
  onOpen: (row: PuzzleAttempt) => void;
  onTrainTheme: (theme: string) => void;
}) {
  const { t } = useTranslation();
  useContentBackfill(rows);

  const overall = useMemo(() => overallStats(rows, now), [rows, now]);
  const themes = useMemo(() => themeStats(rows, now), [rows, now]);

  if (!loaded) return <div className="text-text-muted text-sm">{t('common.loading')}</div>;
  if (rows.length === 0) {
    return (
      <div className="card p-6 text-sm text-text-muted">{t('puzzles.progress.empty')}</div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
        <RatingTile rating={rating} now={now} />
        <Tile
          label={t('puzzles.progress.firstTry')}
          value={pct(overall.firstTryRate)}
          sub={t('puzzles.progress.firstTrySub')}
        />
        <Tile
          label={t('puzzles.progress.moveAccuracy')}
          value={pct(overall.moveAccuracy)}
          sub={t('puzzles.progress.moveAccuracySub')}
        />
        <Tile
          label={t('puzzles.progress.puzzles')}
          value={overall.puzzles.toLocaleString()}
          sub={t('puzzles.progress.attemptsSub', { count: overall.attempts })}
        />
        <Tile
          label={t('puzzles.progress.medianTime')}
          value={overall.medianCleanMs !== null ? formatMs(overall.medianCleanMs) : '—'}
          sub={t('puzzles.progress.medianTimeSub')}
        />
        <Tile
          label={t('puzzles.progress.streak')}
          value={t('puzzles.progress.days', { count: overall.dayStreak })}
          sub={t('puzzles.progress.today', {
            count: overall.today.attempts,
            clean: overall.today.clean,
          })}
        />
      </div>

      <Insight overall={overall} reviewDue={reviewDue} />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ThemeTable themes={themes} onTrain={onTrainTheme} />
        <div className="space-y-4">
          <BandChart rows={rows} rating={rating.rating} />
          <ActivityCalendar rows={rows} now={now} />
        </div>
      </div>

      <HistoryGrid rows={rows} now={now} onOpen={onOpen} />
    </div>
  );
}

/** Legacy rows have no puzzle content; fetch it once so they can be drawn
 *  and replayed, then let sync carry it to other devices. */
function useContentBackfill(rows: readonly PuzzleAttempt[]) {
  const started = useRef(false);
  const missing = rows.some((r) => !r.fen);
  useEffect(() => {
    if (!missing || started.current) return;
    started.current = true;
    void backfillAttemptContent().then((n) => {
      if (n > 0) requestAttemptSync();
    });
  }, [missing]);
}

function pct(x: number | null): string {
  return x === null ? '—' : `${Math.round(x * 100)}%`;
}

function formatMs(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="card p-3 min-w-0">
      <div className="text-[11px] text-text-muted truncate">{label}</div>
      <div className="text-xl font-semibold tabular-nums mt-0.5">{value}</div>
      {sub && <div className="text-[10px] text-text-muted mt-0.5 truncate">{sub}</div>}
    </div>
  );
}

/**
 * One sentence reading the two accuracy numbers together, when they say
 * something specific. Only fires on enough data to mean it.
 */
function Insight({
  overall,
  reviewDue,
}: {
  overall: ReturnType<typeof overallStats>;
  reviewDue: number;
}) {
  const { t } = useTranslation();
  const lines: string[] = [];
  if (
    overall.puzzles >= 20 &&
    overall.firstTryRate !== null &&
    overall.moveAccuracy !== null &&
    overall.moveAccuracy - overall.firstTryRate > 0.3
  ) {
    lines.push(t('puzzles.progress.insightCalculation'));
  }
  if (reviewDue >= 5) lines.push(t('puzzles.progress.insightReview', { count: reviewDue }));
  if (lines.length === 0) return null;
  return (
    <div className="card p-3 text-sm space-y-1 border-accent/30">
      {lines.map((l) => (
        <p key={l}>{l}</p>
      ))}
    </div>
  );
}

/* -------------------------------------------------------------- rating */

const WEEK_MS = 7 * 86_400_000;

function RatingTile({ rating, now }: { rating: PuzzleRating; now: number }) {
  const { t } = useTranslation();
  const { series } = rating;
  const weekAgo = [...series].reverse().find((p) => p.at <= now - WEEK_MS);
  const base = weekAgo?.rating ?? series[0]?.rating;
  const delta = base !== undefined ? Math.round(rating.rating - base) : 0;
  return (
    <div className="card p-3 min-w-0 col-span-2 sm:col-span-1">
      <div className="text-[11px] text-text-muted truncate">{t('puzzles.yourRating')}</div>
      <div className="flex items-baseline gap-1.5 mt-0.5">
        <span className="text-xl font-semibold tabular-nums">
          {Math.round(rating.rating)}
          {rating.provisional && <span className="text-text-muted">?</span>}
        </span>
        {delta !== 0 && (
          <span className={`text-xs tabular-nums ${delta > 0 ? 'text-good' : 'text-blunder'}`}>
            {delta > 0 ? `+${delta}` : delta}
          </span>
        )}
      </div>
      <Sparkline points={series.slice(-60)} />
      <div className="text-[10px] text-text-muted truncate">
        {rating.provisional ? t('puzzles.progress.provisional') : t('puzzles.progress.weekChange')}
      </div>
    </div>
  );
}

/** Rating over the last 60 rated puzzles. Hover reads out a point. */
function Sparkline({ points }: { points: RatingPoint[] }) {
  const [hover, setHover] = useState<number | null>(null);
  if (points.length < 2) return <div className="h-8" />;
  const W = 120;
  const H = 32;
  const ys = points.map((p) => p.rating);
  const min = Math.min(...ys);
  const max = Math.max(...ys);
  const span = Math.max(1, max - min);
  const x = (i: number) => (i / (points.length - 1)) * W;
  const y = (r: number) => H - 2 - ((r - min) / span) * (H - 4);
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.rating).toFixed(1)}`).join('');
  const h = hover !== null ? points[hover] : null;

  return (
    <div className="relative h-8 mt-1">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="w-full h-8 text-accent overflow-visible"
        onMouseMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const i = Math.round(((e.clientX - r.left) / r.width) * (points.length - 1));
          setHover(Math.max(0, Math.min(points.length - 1, i)));
        }}
        onMouseLeave={() => setHover(null)}
        role="img"
        aria-label={`${Math.round(points[0].rating)} → ${Math.round(points[points.length - 1].rating)}`}
      >
        <path
          d={d}
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
        {hover !== null && (
          <line
            x1={x(hover)}
            x2={x(hover)}
            y1={0}
            y2={H}
            className="text-text-muted"
            stroke="currentColor"
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
        )}
      </svg>
      {h && (
        <div className="absolute -top-5 right-0 text-[10px] tabular-nums bg-bg-raised border border-border rounded px-1">
          {Math.round(h.rating)}{' '}
          <span className="text-text-muted">{new Date(h.at).toLocaleDateString()}</span>
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------- themes */

function ThemeTable({
  themes,
  onTrain,
}: {
  themes: ThemeStat[];
  onTrain: (theme: string) => void;
}) {
  const { t } = useTranslation();
  const [all, setAll] = useState(false);
  const ranked = themes.filter((s) => s.attempts >= MIN_THEME_SAMPLE);
  const shown = all ? ranked : ranked.slice(0, 8);

  return (
    <section className="card p-3 space-y-3">
      <div>
        <h2 className="text-sm font-medium">{t('puzzles.progress.themesTitle')}</h2>
        <p className="text-[11px] text-text-muted mt-0.5">{t('puzzles.progress.themesExplain')}</p>
      </div>
      {ranked.length === 0 ? (
        <p className="text-xs text-text-muted">
          {t('puzzles.progress.themesNeedMore', { count: MIN_THEME_SAMPLE })}
        </p>
      ) : (
        <ul className="space-y-2">
          {shown.map((s) => {
            const rate = s.clean / s.attempts;
            const exp = s.expected / s.attempts;
            const edgePts = Math.round(s.edge * 100);
            return (
              <li key={s.theme} className="flex items-center gap-2 text-xs">
                <div className="w-32 shrink-0 truncate" title={formatThemeName(s.theme)}>
                  {formatThemeName(s.theme)}
                </div>
                <div
                  className="relative flex-1 h-2 rounded-full bg-bg-raised"
                  title={t('puzzles.progress.themeBarTitle', {
                    rate: Math.round(rate * 100),
                    expected: Math.round(exp * 100),
                    count: s.attempts,
                  })}
                >
                  <div
                    className="absolute inset-y-0 left-0 rounded-full bg-accent"
                    style={{ width: `${Math.max(2, rate * 100)}%` }}
                  />
                  {/* Expected rate, as a tick, so "below the tick" reads at a glance. */}
                  <div
                    className="absolute -inset-y-1 w-0.5 rounded bg-text"
                    style={{ left: `calc(${exp * 100}% - 1px)` }}
                  />
                </div>
                <div className="w-14 text-right tabular-nums text-text-muted">
                  {Math.round(rate * 100)}%
                  <span className="text-[10px]"> · {s.attempts}</span>
                </div>
                <div
                  className={`w-10 text-right tabular-nums ${
                    edgePts <= -5 ? 'text-blunder' : edgePts >= 5 ? 'text-good' : 'text-text-muted'
                  }`}
                >
                  {edgePts > 0 ? `+${edgePts}` : edgePts}
                </div>
                <button
                  type="button"
                  className="btn text-[11px] px-2 py-0.5"
                  onClick={() => onTrain(s.theme)}
                >
                  {t('puzzles.progress.train')}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {ranked.length > 8 && (
        <button type="button" className="text-xs text-accent" onClick={() => setAll((a) => !a)}>
          {all ? t('puzzles.progress.showFewer') : t('puzzles.progress.showAll', { count: ranked.length })}
        </button>
      )}
    </section>
  );
}

/* ------------------------------------------------------- by difficulty */

function BandChart({ rows, rating }: { rows: readonly PuzzleAttempt[]; rating: number }) {
  const { t } = useTranslation();
  const bands = useMemo(() => bandStats(rows), [rows]);
  const yours = Math.floor(rating / 100) * 100;
  return (
    <section className="card p-3 space-y-2">
      <h2 className="text-sm font-medium">{t('puzzles.progress.bandsTitle')}</h2>
      <ul className="space-y-1">
        {bands.map((b) => {
          const rate = b.clean / b.attempts;
          return (
            <li
              key={b.lo}
              className="flex items-center gap-2 text-xs"
              title={t('puzzles.progress.bandTitle', {
                lo: b.lo,
                hi: b.lo + 99,
                clean: b.clean,
                count: b.attempts,
              })}
            >
              <div className={`w-20 shrink-0 tabular-nums ${b.lo === yours ? 'text-accent' : 'text-text-muted'}`}>
                {b.lo}–{b.lo + 99}
              </div>
              <div className="flex-1 h-2 rounded-full bg-bg-raised">
                <div
                  className="h-full rounded-full bg-accent"
                  style={{ width: `${Math.max(2, rate * 100)}%` }}
                />
              </div>
              <div className="w-16 text-right tabular-nums text-text-muted">
                {Math.round(rate * 100)}%<span className="text-[10px]"> · {b.attempts}</span>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/* ------------------------------------------------------------ activity */

const CAL_WEEKS = 18;
const CAL_LEVELS = ['bg-bg-raised', 'bg-accent/25', 'bg-accent/45', 'bg-accent/70', 'bg-accent'];

function calLevel(n: number): number {
  return n === 0 ? 0 : n < 5 ? 1 : n < 10 ? 2 : n < 20 ? 3 : 4;
}

function ActivityCalendar({ rows, now }: { rows: readonly PuzzleAttempt[]; now: number }) {
  const { t, i18n } = useTranslation();
  const counts = useMemo(() => activityByDay(rows), [rows]);
  // Columns are weeks ending with the current one; rows are weekdays,
  // Monday first. Built by calendar date so DST can't skip a cell.
  const today = new Date(now);
  const monday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - ((today.getDay() + 6) % 7));
  const weeks: { key: string; date: Date; n: number; future: boolean }[][] = [];
  for (let w = CAL_WEEKS - 1; w >= 0; w--) {
    const col = [];
    for (let d = 0; d < 7; d++) {
      const date = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() - w * 7 + d);
      const key = dayKey(date.getTime());
      col.push({ key, date, n: counts.get(key) ?? 0, future: date.getTime() > now });
    }
    weeks.push(col);
  }
  const fmt = new Intl.DateTimeFormat(i18n.resolvedLanguage, { month: 'short', day: 'numeric' });
  const active = weeks.flat().filter((c) => c.n > 0).length;

  return (
    <section className="card p-3 space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-medium">{t('puzzles.progress.activityTitle')}</h2>
        <span className="text-[11px] text-text-muted">
          {t('puzzles.progress.activeDays', { count: active, weeks: CAL_WEEKS })}
        </span>
      </div>
      <div className="flex gap-[3px] overflow-hidden">
        {weeks.map((col, i) => (
          <div key={i} className="flex flex-col gap-[3px] flex-1 min-w-0 max-w-[14px]">
            {col.map((c) => (
              <div
                key={c.key}
                className={`aspect-square rounded-[2px] ${c.future ? 'opacity-0' : CAL_LEVELS[calLevel(c.n)]}`}
                title={c.future ? undefined : t('puzzles.progress.dayTitle', { date: fmt.format(c.date), count: c.n })}
              />
            ))}
          </div>
        ))}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------- history */

type HistoryFilter = 'all' | 'missed' | 'clean' | 'review';
type HistorySort = 'recent' | 'hardest' | 'easiest' | 'attempts';
const HISTORY_PAGE = 24;

function HistoryGrid({
  rows,
  now,
  onOpen,
}: {
  rows: readonly PuzzleAttempt[];
  now: number;
  onOpen: (row: PuzzleAttempt) => void;
}) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState<HistoryFilter>('all');
  const [sort, setSort] = useState<HistorySort>('recent');
  const [limit, setLimit] = useState(HISTORY_PAGE);

  const all = useMemo(() => rows.map((r) => summarize(r, now)), [rows, now]);
  const list = useMemo(() => {
    const keep = (s: PuzzleSummary) =>
      filter === 'all' ||
      (filter === 'missed' && s.first !== 'clean') ||
      (filter === 'clean' && s.first === 'clean') ||
      (filter === 'review' && (s.review.status === 'due' || s.review.status === 'later'));
    const cmp: Record<HistorySort, (a: PuzzleSummary, b: PuzzleSummary) => number> = {
      recent: (a, b) => b.row.lastAttemptedAt - a.row.lastAttemptedAt,
      hardest: (a, b) => b.row.rating - a.row.rating,
      easiest: (a, b) => a.row.rating - b.row.rating,
      attempts: (a, b) => b.row.attempts - a.row.attempts || b.row.lastAttemptedAt - a.row.lastAttemptedAt,
    };
    return all.filter(keep).sort(cmp[sort]);
  }, [all, filter, sort]);

  const counts: Record<HistoryFilter, number> = {
    all: all.length,
    missed: all.filter((s) => s.first !== 'clean').length,
    clean: all.filter((s) => s.first === 'clean').length,
    review: all.filter((s) => s.review.status === 'due' || s.review.status === 'later').length,
  };

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-medium">{t('puzzles.progress.historyTitle')}</h2>
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-md border border-border overflow-hidden">
            {(['all', 'missed', 'clean', 'review'] as const).map((f) => (
              <button
                key={f}
                type="button"
                aria-pressed={filter === f}
                onClick={() => {
                  setFilter(f);
                  setLimit(HISTORY_PAGE);
                }}
                className={`px-2 py-1 text-xs transition-colors ${
                  filter === f ? 'bg-accent/15 text-accent' : 'text-text-muted hover:text-text'
                }`}
              >
                {t(`puzzles.progress.filter.${f}`)}{' '}
                <span className="tabular-nums opacity-70">{counts[f]}</span>
              </button>
            ))}
          </div>
          <select
            className="input w-auto text-xs py-1"
            value={sort}
            onChange={(e) => setSort(e.target.value as HistorySort)}
            aria-label={t('puzzles.progress.sortLabel')}
          >
            {(['recent', 'hardest', 'easiest', 'attempts'] as const).map((s) => (
              <option key={s} value={s}>
                {t(`puzzles.progress.sort.${s}`)}
              </option>
            ))}
          </select>
        </div>
      </div>

      {list.length === 0 ? (
        <p className="text-xs text-text-muted">{t('puzzles.progress.historyEmpty')}</p>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6 gap-2">
          {list.slice(0, limit).map((s) => (
            <HistoryCard key={s.row.puzzleId} s={s} onOpen={onOpen} />
          ))}
        </div>
      )}

      {list.length > limit && (
        <button
          type="button"
          className="btn text-xs w-full"
          onClick={() => setLimit((l) => l + HISTORY_PAGE)}
        >
          {t('puzzles.progress.showMore', { count: list.length - limit })}
        </button>
      )}
    </section>
  );
}

const OUTCOME_LABEL_KEY: Record<PuzzleOutcome, string> = {
  clean: 'puzzles.outcome.clean',
  mistake: 'puzzles.outcome.mistake',
  hint: 'puzzles.outcome.hint',
  revealed: 'puzzles.outcome.revealed',
};

function HistoryCard({ s, onOpen }: { s: PuzzleSummary; onOpen: (row: PuzzleAttempt) => void }) {
  const { t, i18n } = useTranslation();
  const { row } = s;
  const canOpen = Boolean(row.fen && row.solution);
  const orientation = row.fen?.split(' ')[1] === 'b' ? 'black' : 'white';
  const date = new Date(row.lastAttemptedAt).toLocaleDateString(i18n.resolvedLanguage, {
    month: 'short',
    day: 'numeric',
  });

  return (
    <button
      type="button"
      disabled={!canOpen}
      onClick={() => onOpen(row)}
      className="card p-1.5 text-left flex flex-col justify-start gap-1.5 hover:border-accent/50 transition-colors disabled:opacity-60 disabled:cursor-default"
      title={canOpen ? t('puzzles.progress.cardTitle') : undefined}
      data-puzzle-id={row.puzzleId}
    >
      {row.fen ? (
        <MiniBoard fen={row.fen} orientation={orientation} />
      ) : (
        <div className="aspect-square rounded bg-bg-raised" />
      )}
      <div className="px-0.5 space-y-0.5">
        <div className="flex items-center justify-between gap-1 text-xs">
          <span className="tabular-nums font-medium">{row.rating}</span>
          <span className="flex items-center gap-0.5" aria-label={t(OUTCOME_LABEL_KEY[s.first])}>
            {s.events.slice(-6).map((e, i) => (
              <span
                key={i}
                className={`h-1.5 w-1.5 rounded-full ${OUTCOME_DOT[e.outcome]}`}
                title={t(OUTCOME_LABEL_KEY[e.outcome])}
              />
            ))}
          </span>
        </div>
        <div className="flex items-center justify-between gap-1 text-[10px] text-text-muted tabular-nums">
          <span>
            {t('puzzles.progress.tries', { count: row.attempts })}
            {s.moveAccuracy !== null &&
              ` · ${t('puzzles.progress.movesPct', { pct: Math.round(s.moveAccuracy * 100) })}`}
          </span>
          <span>{date}</span>
        </div>
        {(s.review.status === 'due' || s.review.status === 'learned') && (
          <div
            className={`text-[10px] ${s.review.status === 'due' ? 'text-accent' : 'text-good'}`}
          >
            {t(`puzzles.progress.review.${s.review.status}`)}
          </div>
        )}
      </div>
    </button>
  );
}
