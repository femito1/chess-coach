import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import {
  db,
  getSettings,
  normalizeTimeClassSelection,
  type PuzzleOutcome,
  type TimeClassSelection,
} from '@/db/schema';
import { forEachAnalysis, listAllGamesLight, type GameLight } from '@/db/queries';
import { useThrottledLiveQuery } from '@/lib/useThrottledLiveQuery';
import { gameMatchesSelection } from '@/lib/timeClass';
import { usePersistedState } from '@/lib/usePersistedState';
import { tMotifLabel } from '@/i18n/chess';
import { shardsForRatingWindow, type LibraryPuzzle } from './corpus';
import { buildRecommendedQueue, buildTrainQueue, windowForTheme } from './queue';
import {
  estimateUserRating,
  recommendationPlan,
  type RecommendationPlan,
} from './recommend';
import { mistakeRowsForGame, type MistakeRow } from './mistakes';
import {
  findPuzzle,
  loadAttemptedIds,
  puzzleFromAttempt,
  recordAttempt,
} from './attempts';
import { ratingFromAttempts, reviewQueue } from './stats';
import type { PuzzleRating } from './rating';
import { requestAttemptSync } from '@/features/sync/useCloudSync';
import {
  BOARD_CLAMP_PX,
  BOARD_CLAMP_WITH_SUMMARY_PX,
  LibraryPuzzleSolver,
  type SolveOutcome,
} from './LibraryPuzzleSolver';
import {
  TrainBar,
  centerFor,
  isDifficulty,
  isThemeChoice,
  type Difficulty,
  type ThemeChoice,
} from './TrainBar';
import { ProgressView } from './ProgressView';
import { formatThemeName } from './themeLabels';

/**
 * The Puzzles page.
 *
 * Serves the bundled Lichess corpus (191k vetted, human-rated positions —
 * see `scripts/build-puzzles.mjs`) through three views:
 *
 *  - **Train** — new puzzles. A theme (mixed, one Lichess theme, or "from
 *    your games", which targets the motifs you've been blundering lately —
 *    `recommend.ts`) and a difficulty *relative to your puzzle rating*
 *    (`rating.ts`). Replaces five tabs of fixed tiers that were each ~600
 *    points wide.
 *  - **Review** — puzzles you missed, back on a spaced schedule
 *    (`stats.ts` § Review).
 *  - **Progress** — rating history, accuracy, per-theme strengths and
 *    weaknesses measured against your own rating, and a grid of every
 *    puzzle you've done, each re-playable.
 */

type View = 'train' | 'review' | 'progress';
const VIEWS: View[] = ['train', 'review', 'progress'];

/** New puzzles fetched per batch. Small on purpose: the rating window is
 *  re-centred on your *current* rating at every batch, so a short batch is
 *  what keeps difficulty tracking you within a session. */
const TRAIN_BATCH = 10;
/** Run length "From your games" plans allocate across motifs. */
const RECOMMENDED_RUN = 20;

function isView(v: unknown): v is View {
  return typeof v === 'string' && (VIEWS as string[]).includes(v);
}

/** What the solver is currently working through. */
type RunSpec =
  | { kind: 'train' }
  | { kind: 'review'; ids: string[]; startedAt: number }
  | { kind: 'single'; puzzle: LibraryPuzzle; from: View };

export function PuzzlesPage() {
  const { t } = useTranslation();
  const [view, setView] = usePersistedState<View>('puzzles.view', 'train', {
    isValid: isView,
  });
  const [theme, setTheme] = usePersistedState<ThemeChoice>('puzzles.theme', 'mix', {
    isValid: isThemeChoice,
  });
  const [difficulty, setDifficulty] = usePersistedState<Difficulty>(
    'puzzles.difficulty',
    'rel:0',
    { isValid: isDifficulty },
  );
  const [searchParams, setSearchParams] = useSearchParams();

  const rows = useThrottledLiveQuery(() => db.puzzleAttempts.toArray(), [], 1000);
  // Minute resolution is plenty for "is it due yet", and keeps the memos
  // below from recomputing on every render.
  const now = useMinuteClock();
  const rating = useMemo(() => ratingFromAttempts(rows ?? [], now), [rows, now]);
  const review = useMemo(() => reviewQueue(rows ?? [], now), [rows, now]);

  /* ------------------------------------------------------------ run spec */
  const [spec, setSpec] = useState<RunSpec>({ kind: 'train' });
  const runKey =
    spec.kind === 'single'
      ? `single:${spec.puzzle.id}`
      : spec.kind === 'review'
        ? `review:${spec.startedAt}`
        : `train:${theme}:${difficulty}`;

  // "From your games" centres its plan on the puzzle rating once that's
  // established — captured when the run starts, not tracked live: the plan
  // feeds the run, so a plan that moved with every puzzle would rebuild the
  // run under the user mid-session.
  // A memo rather than an effect + state: an effect lands one render late, so
  // the run's first batch could read a plan centred for the previous run.
  const rowsLoaded = rows !== undefined;
  const planCenter = useMemo(
    () => (rating.provisional ? null : centerFor(difficulty, rating.rating)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [runKey, rowsLoaded],
  );
  const recommendation = useRecommendation(
    view === 'train' && theme === 'foryou',
    planCenter,
    difficulty,
  );

  // `/puzzles?puzzle=<id>&rating=<n>` opens one puzzle. The rating narrows
  // the lookup to one or two shards (there is no id index). Also the hook
  // the browser tests use to get a known puzzle without a random draw.
  const deepId = searchParams.get('puzzle');
  const deepRating = Number(searchParams.get('rating'));
  useEffect(() => {
    if (!deepId || !Number.isFinite(deepRating)) return;
    let cancelled = false;
    void findPuzzle(deepId, deepRating).then((p) => {
      if (cancelled || !p) return;
      setView('train');
      setSpec({ kind: 'single', puzzle: p, from: 'train' });
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deepId, deepRating]);

  const closeSingle = useCallback(
    (from: View) => {
      if (searchParams.has('puzzle')) setSearchParams({}, { replace: true });
      setSpec({ kind: 'train' });
      setView(from);
    },
    [searchParams, setSearchParams, setView],
  );

  // Leaving a view abandons its review run or single puzzle.
  const switchView = (v: View) => {
    if (searchParams.has('puzzle')) setSearchParams({}, { replace: true });
    setSpec({ kind: 'train' });
    setView(v);
  };

  /* ------------------------------------------------------ batch loading */
  // Read at batch-build time through refs, NOT listed as run deps: the
  // rating moves after every puzzle, and a dep on it would rebuild the run
  // under the user mid-session. The "From your games" plan is the same: it
  // is recomputed on every refire of the games table — which the analysis
  // queue writes constantly — and as a dep it swapped the puzzle on screen
  // mid-solve. A new plan therefore shapes only the next batch; the first
  // batch waits for a settled one through `runReady` instead.
  const ratingRef = useRef(rating);
  ratingRef.current = rating;
  const planRef = useRef(recommendation.plan);
  planRef.current = recommendation.plan;
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  /** Ids served in this page session, excluded on top of recorded attempts
   *  so a batch built before the last attempt was written can't repeat it. */
  const servedRef = useRef(new Set<string>());
  const [trainWindow, setTrainWindow] = useState<{
    lo: number;
    hi: number;
    widened: boolean;
  } | null>(null);

  const solving = spec.kind !== 'train' || view === 'train';
  // A Train batch is centred on the rating (and, "From your games", built
  // from the plan) as they stand when it loads, and nothing reloads it once
  // they settle — so wait for both. Before `rows` lands the rating reads
  // as the 1500 default.
  const runReady =
    spec.kind !== 'train' || (rowsLoaded && (theme !== 'foryou' || recommendation.loaded));

  const loadBatch = useCallback(
    async (generation: number): Promise<LibraryPuzzle[]> => {
      if (spec.kind === 'single') return generation === 0 ? [spec.puzzle] : [];
      if (spec.kind === 'review') {
        if (generation > 0) return [];
        const byId = new Map((rowsRef.current ?? []).map((r) => [r.puzzleId, r]));
        const out: LibraryPuzzle[] = [];
        for (const id of spec.ids) {
          const row = byId.get(id);
          if (!row) continue;
          const p = puzzleFromAttempt(row) ?? (await findPuzzle(row.puzzleId, row.rating));
          if (p) out.push(p);
        }
        return out;
      }

      const attempted = await loadAttemptedIds();
      const isExcluded = (id: string) => attempted.has(id) || servedRef.current.has(id);
      const seed = generation * 7919 + Math.floor(Date.now() / 60_000);

      if (theme === 'foryou') {
        const plan = planRef.current;
        if (!plan || plan.allocation.length === 0) return [];
        setTrainWindow({ lo: plan.ratingLo, hi: plan.ratingHi, widened: false });
        return buildRecommendedQueue({
          plan,
          shards: shardsForRatingWindow(plan.ratingLo, plan.ratingHi),
          isExcluded,
          seed,
        });
      }

      const themeFilter = theme === 'mix' ? null : theme;
      const win = windowForTheme({
        center: centerFor(difficulty, ratingRef.current.rating),
        theme: themeFilter,
        want: TRAIN_BATCH * 6,
      });
      setTrainWindow(win);
      return buildTrainQueue({
        lo: win.lo,
        hi: win.hi,
        theme: themeFilter,
        count: TRAIN_BATCH,
        isExcluded,
        seed,
      });
    },
    // `runKey` covers spec/theme/difficulty; rating and plan are read
    // through refs (see above).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [runKey],
  );

  const run = useRun({ runKey, ready: solving && runReady, loadBatch });
  useEffect(() => {
    for (const p of run.puzzles) servedRef.current.add(p.id);
  }, [run.puzzles]);

  /* ----------------------------------------------------------- recording */
  const [results, setResults] = useState<PuzzleOutcome[]>([]);
  useEffect(() => setResults([]), [runKey]);
  const [ratingChange, setRatingChange] = useState<{
    id: string;
    from: number;
    to: number;
  } | null>(null);

  const onDone = useCallback(async (outcome: SolveOutcome) => {
    setResults((r) => [...r, outcome.outcome]);
    // Read fresh rather than from the live query, which is throttled and
    // can lag the previous puzzle's write.
    const before = await db.puzzleAttempts.toArray();
    const firstAttempt = !before.some((r) => r.puzzleId === outcome.puzzle.id);
    const saved = await recordAttempt({
      puzzle: outcome.puzzle,
      outcome: outcome.outcome,
      good: outcome.good,
      bad: outcome.bad,
      msTaken: outcome.msTaken,
    });
    if (firstAttempt) {
      const t0 = Date.now();
      setRatingChange({
        id: outcome.puzzle.id,
        from: ratingFromAttempts(before, t0).rating,
        to: ratingFromAttempts([...before, saved], t0).rating,
      });
    }
    // Progress is only as safe as its cloud copy — local data on this device
    // has been wiped before — and nothing else would upload it this session.
    requestAttemptSync();
  }, []);

  const current = run.puzzles[run.idx];
  const loadedRows = rows ?? [];

  return (
    <div className="space-y-4">
      <Header rating={rating} hasHistory={loadedRows.length > 0} />

      <ViewTabs view={view} onChange={switchView} reviewDue={review.due.length} />

      {view === 'train' && spec.kind === 'train' && (
        <TrainBar
          theme={theme}
          onTheme={setTheme}
          difficulty={difficulty}
          onDifficulty={setDifficulty}
          rating={rating}
          rows={loadedRows}
          window={trainWindow}
          plan={recommendation.plan}
          planLoaded={recommendation.loaded}
          hasAnalyzedGames={recommendation.hasAnalyzedGames}
        />
      )}

      {spec.kind === 'single' && (
        <button
          type="button"
          className="btn text-xs"
          onClick={() => closeSingle(spec.from)}
        >
          {spec.from === 'progress' ? t('puzzles.backToProgress') : t('puzzles.backToTraining')}
        </button>
      )}

      {view === 'review' && spec.kind !== 'review' && spec.kind !== 'single' && (
        <ReviewOverview
          review={review}
          now={now}
          onStart={(ids) => setSpec({ kind: 'review', ids, startedAt: Date.now() })}
        />
      )}

      {view === 'progress' && spec.kind !== 'single' && (
        <ProgressView
          rows={loadedRows}
          loaded={rows !== undefined}
          rating={rating}
          now={now}
          reviewDue={review.due.length}
          onOpen={(row) => {
            const p = puzzleFromAttempt(row);
            if (p) setSpec({ kind: 'single', puzzle: p, from: 'progress' });
          }}
          onTrainTheme={(th) => {
            setTheme(th);
            switchView('train');
          }}
        />
      )}

      {solving && (
        <>
          {run.error && (
            <div
              role="alert"
              className="card p-4 text-sm border-blunder/40 bg-blunder/5 space-y-1"
            >
              <div className="font-medium text-blunder">{t('puzzles.loadFailed')}</div>
              <div className="text-text-muted text-xs font-mono">{run.error}</div>
            </div>
          )}

          {!run.error && run.loading && (
            <div className="text-text-muted text-sm">{t('common.loading')}</div>
          )}

          {!run.error && !run.loading && !current && spec.kind === 'review' && (
            <ReviewDone results={results} onBack={() => setSpec({ kind: 'train' })} />
          )}

          {!run.error && !run.loading && !current && spec.kind === 'train' && (
            <EmptyState
              theme={theme}
              recommendation={recommendation}
              onMix={() => setTheme('mix')}
            />
          )}

          {!run.error && current && (
            <LibraryPuzzleSolver
              key={current.id}
              puzzle={current}
              session={{
                results,
                position:
                  spec.kind === 'review'
                    ? t('puzzles.progressOf', { index: run.idx + 1, total: run.puzzles.length })
                    : undefined,
              }}
              ratingChange={
                ratingChange?.id === current.id
                  ? { from: ratingChange.from, to: ratingChange.to }
                  : undefined
              }
              unratedNote={
                // Only where it's always true. A train puzzle's rating change
                // lands a beat after the solve, and must not be preceded by
                // a flash of "doesn't count".
                spec.kind === 'review' || (spec.kind === 'single' && spec.from === 'progress')
                  ? t('puzzles.retryUnrated')
                  : undefined
              }
              boardClampPx={
                spec.kind === 'train' && theme === 'foryou' && recommendation.plan?.motifs.length
                  ? BOARD_CLAMP_WITH_SUMMARY_PX
                  : BOARD_CLAMP_PX
              }
              sessionNote={
                spec.kind === 'train' && theme === 'foryou' && recommendation.plan
                  ? sessionNoteFor(recommendation.plan, t)
                  : spec.kind === 'train' && theme !== 'mix' && theme !== 'foryou'
                    ? t('puzzles.themeSessionNote', { theme: formatThemeName(theme) })
                    : undefined
              }
              onDone={onDone}
              onNext={
                spec.kind === 'single' && run.idx + 1 >= run.puzzles.length
                  ? () => closeSingle(spec.from)
                  : run.next
              }
              hasNext={
                spec.kind === 'single' || run.idx + 1 < run.puzzles.length || run.canExtend
              }
              nextLabel={
                spec.kind === 'single'
                  ? spec.from === 'progress'
                    ? t('puzzles.backToProgress')
                    : t('puzzles.startTraining')
                  : spec.kind === 'review' && run.idx + 1 >= run.puzzles.length
                    ? t('puzzles.review.finish')
                    : undefined
              }
            />
          )}
        </>
      )}
    </div>
  );
}

/* =======================================================================
 *  Header + view tabs
 * =======================================================================
 */

function Header({ rating, hasHistory }: { rating: PuzzleRating; hasHistory: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="flex items-end justify-between gap-4 flex-wrap">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{t('puzzles.title')}</h1>
        <p className="text-sm text-text-muted mt-0.5">{t('puzzles.subtitle')}</p>
      </div>
      {hasHistory && (
        <div
          className="text-right"
          title={t('puzzles.ratingTitle', { rd: Math.round(rating.rd) })}
        >
          <div className="text-[10px] uppercase tracking-wide text-text-muted">
            {t('puzzles.yourRating')}
          </div>
          <div className="text-lg font-semibold tabular-nums leading-tight">
            {Math.round(rating.rating)}
            {rating.provisional && <span className="text-text-muted">?</span>}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * View switcher. Three short labels fit any width, so this is a plain flex
 * row with no overflow handling — the old tab bar's `overflow-x-auto`, with
 * the `-mb-px` underline poking 1px past it, produced a vertical scrollbar
 * that scrolled nothing.
 */
function ViewTabs({
  view,
  onChange,
  reviewDue,
}: {
  view: View;
  onChange: (v: View) => void;
  reviewDue: number;
}) {
  const { t } = useTranslation();
  return (
    <div
      role="tablist"
      aria-label={t('puzzles.title')}
      className="inline-flex gap-1 p-1 rounded-lg bg-bg-soft border border-border"
    >
      {VIEWS.map((id) => {
        const active = id === view;
        return (
          <button
            key={id}
            role="tab"
            aria-selected={active}
            type="button"
            onClick={() => onChange(id)}
            className={`px-3 py-1.5 text-sm rounded-md whitespace-nowrap transition-colors flex items-center gap-1.5 ${
              active ? 'bg-bg-raised text-text font-medium' : 'text-text-muted hover:text-text'
            }`}
          >
            {t(`puzzles.views.${id}`)}
            {id === 'review' && reviewDue > 0 && (
              <span className="text-[10px] tabular-nums px-1.5 rounded-full bg-accent/20 text-accent">
                {reviewDue}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/* =======================================================================
 *  Review
 * =======================================================================
 */

function ReviewOverview({
  review,
  now,
  onStart,
}: {
  review: ReturnType<typeof reviewQueue>;
  now: number;
  onStart: (ids: string[]) => void;
}) {
  const { t } = useTranslation();
  const { due, later, learned, nextDueAt } = review;
  const nextDueIn =
    nextDueAt !== null ? Math.max(1, Math.round((nextDueAt - now) / 3_600_000)) : null;

  return (
    <div className="card p-4 space-y-4 max-w-2xl">
      <div className="grid grid-cols-3 gap-3 text-center">
        <Count n={due.length} label={t('puzzles.review.dueNow')} accent />
        <Count n={later.length} label={t('puzzles.review.later')} />
        <Count n={learned} label={t('puzzles.review.learned')} />
      </div>
      <p className="text-xs text-text-muted leading-relaxed">{t('puzzles.review.explain')}</p>
      <div className="flex flex-wrap gap-2">
        {due.length > 0 ? (
          <button
            type="button"
            className="btn border-accent/50 text-accent hover:bg-accent/10"
            onClick={() => onStart(due.map((r) => r.puzzleId))}
          >
            {t('puzzles.review.start', { count: due.length })}
          </button>
        ) : (
          <p className="text-sm text-text-muted">
            {later.length > 0 && nextDueIn !== null
              ? t('puzzles.review.nothingDueNext', { hours: nextDueIn })
              : t('puzzles.review.empty')}
          </p>
        )}
        {due.length === 0 && later.length > 0 && (
          <button
            type="button"
            className="btn text-xs"
            onClick={() => onStart(later.map((r) => r.puzzleId))}
          >
            {t('puzzles.review.early', { count: later.length })}
          </button>
        )}
      </div>
    </div>
  );
}

function Count({ n, label, accent }: { n: number; label: string; accent?: boolean }) {
  return (
    <div>
      <div className={`text-2xl font-semibold tabular-nums ${accent && n > 0 ? 'text-accent' : ''}`}>
        {n}
      </div>
      <div className="text-[11px] text-text-muted">{label}</div>
    </div>
  );
}

function ReviewDone({ results, onBack }: { results: PuzzleOutcome[]; onBack: () => void }) {
  const { t } = useTranslation();
  const clean = results.filter((r) => r === 'clean').length;
  return (
    <div className="card p-4 space-y-3 max-w-2xl text-sm">
      <div className="font-medium">
        {results.length > 0
          ? t('puzzles.review.doneScore', { clean, total: results.length })
          : t('puzzles.review.empty')}
      </div>
      {results.length > clean && (
        <p className="text-xs text-text-muted">{t('puzzles.review.doneMissed')}</p>
      )}
      <button type="button" className="btn text-xs" onClick={onBack}>
        {t('puzzles.review.backToOverview')}
      </button>
    </div>
  );
}

/* =======================================================================
 *  Empty states + notes
 * =======================================================================
 */

function sessionNoteFor(
  plan: RecommendationPlan,
  t: TFunction,
): string | undefined {
  if (plan.motifs.length === 0) return undefined;
  // Labels are full phrases ("Walked into a fork", "Back-rank weakness"), not
  // nouns, so they can't be embedded in a possessive frame like "your ...
  // mistakes" — that reads as "your walked into a fork mistakes". Present them
  // as a plain list instead, with their own capitalisation preserved.
  return t('puzzles.sessionNote', {
    motifs: plan.motifs.map((m) => tMotifLabel(t, m.motif)).join(' · '),
  });
}

function EmptyState({
  theme,
  recommendation,
  onMix,
}: {
  theme: ThemeChoice;
  recommendation: ReturnType<typeof useRecommendation>;
  onMix: () => void;
}) {
  const { t } = useTranslation();

  if (theme === 'foryou') {
    // Distinguish "no analyzed games yet" from "analyzed games, but no
    // motif cleared the noise floor" — they need different next steps.
    const reason = recommendation.hasAnalyzedGames
      ? t('puzzles.recommendedNoMotifs')
      : t('puzzles.recommendedNeedsGames');
    return (
      <div className="card p-6 text-sm text-text-muted space-y-3">
        <p>{reason}</p>
        <button type="button" className="btn text-xs" onClick={onMix}>
          {t('puzzles.switchToMixed')}
        </button>
      </div>
    );
  }

  return (
    <div className="card p-6 text-sm text-text-muted">{t('puzzles.windowExhausted')}</div>
  );
}

/* =======================================================================
 *  Data hooks
 * =======================================================================
 */

function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, []);
  return now;
}

/** An established puzzle rating is on the corpus's own scale, so "From your
 *  games" can centre on it with a tighter window than the game-rating
 *  fallback needs (see `ratingWindowFor`). */
const RECOMMENDED_HALF_WINDOW_ESTABLISHED = 150;

/**
 * Compute the "From your games" plan from the user's analyzed games.
 *
 * Only runs when `active`: scoring needs every move of every analyzed game, so
 * there is no point paying for it until the user picks that theme. Throttled
 * live queries keep it from refiring on every write during an analysis run.
 *
 * It reads those move lists through a cursor and folds each one into
 * `MistakeRow`s as it arrives (`forEachAnalysis` + `mistakeRowsForGame`). It used
 * to `bulkGet` the lot — the same cost the old Weaknesses page paid, which is why
 * that page was slow on large libraries, and on a phone the last of the
 * whole-table loads in ARCHITECTURE.md § Memory on mobile. Only the user's own
 * blundery moves survive the fold, so what stays resident is a few thousand small
 * rows instead of ~1 200 full move lists.
 */
function useRecommendation(
  active: boolean,
  /** Puzzle-rating centre, offset already applied; null while the rating is
   *  provisional, which falls back to game rating + offset. */
  center: number | null,
  difficulty: Difficulty,
): {
  plan: RecommendationPlan | null;
  loaded: boolean;
  hasAnalyzedGames: boolean;
} {
  // Every input below is `undefined` (not empty) until it is known, so that
  // `loaded` means "the plan is real". The run builds its first batch the
  // moment `loaded` turns true and never rebuilds it when the plan later
  // changes; an inactive query that answered `[]` made `loaded` true, the
  // instant the theme was picked, with an empty plan.
  const games = useThrottledLiveQuery<GameLight[] | undefined>(
    () => (active ? listAllGamesLight() : Promise.resolve(undefined)),
    [active],
    1000,
  );

  /**
   * Time-class selection from Settings, default `['rapid']`.
   *
   * Honoured for the reason the setting exists: bullet mistakes are
   * high-volume and low-signal — you blunder in bullet because of the clock,
   * not because of a pattern gap — so letting them into the motif scoring
   * would drown out the mistakes that actually indicate a weakness.
   */
  const [timeClasses, setTimeClasses] = useState<TimeClassSelection | null>(null);
  useEffect(() => {
    void getSettings().then((s) =>
      setTimeClasses(normalizeTimeClassSelection(s.timeClassFilter)),
    );
  }, []);

  const analyzed = useMemo(
    () =>
      games && timeClasses
        ? games.filter(
            (g) => g.analysisStatus === 'done' && gameMatchesSelection(g, timeClasses),
          )
        : [],
    [games, timeClasses],
  );

  const mistakes = useThrottledLiveQuery<MistakeRow[] | undefined>(
    async () => {
      if (!active || !games || !timeClasses) return undefined;
      if (analyzed.length === 0) return [];
      // The join is on game metadata the light rows already carry, so the game
      // side costs nothing extra; only the analysis is streamed.
      const byId = new Map(analyzed.map((g) => [g.id, g]));
      const rows: MistakeRow[] = [];
      await forEachAnalysis(
        analyzed.map((g) => g.id),
        (a) => {
          const g = byId.get(a.gameId);
          // An analysis whose game fell out of the filter between the two reads.
          if (!g) return;
          for (const r of mistakeRowsForGame(g, a)) rows.push(r);
        },
      );
      return rows;
    },
    [active, analyzed],
    1000,
  );

  const gameCenter = estimateUserRating(analyzed);

  const plan = useMemo(() => {
    if (!active || !games || !mistakes) return null;
    return recommendationPlan({
      // Row order does not matter: `scoreMotifs` sums into a map keyed by motif
      // and sorts its own output.
      rows: mistakes,
      now: Date.now(),
      userRating:
        center ?? (gameCenter !== undefined ? centerFor(difficulty, gameCenter) : undefined),
      queueLength: RECOMMENDED_RUN,
      halfWindow: center !== null ? RECOMMENDED_HALF_WINDOW_ESTABLISHED : undefined,
    });
    // `Date.now()` in a memo is fine here: the deps only change on a data
    // refire, and re-scoring on a stale clock would at worst shift decay
    // weights by minutes on a 30-day half-life.
  }, [active, games, mistakes, center, gameCenter, difficulty]);

  return {
    plan,
    loaded: !active || (Boolean(games) && Boolean(mistakes)),
    hasAnalyzedGames: analyzed.length > 0,
  };
}

/**
 * Owns the current run of puzzles and the position within it.
 *
 * `loadBatch(generation)` supplies puzzles: generation 0 when `runKey`
 * changes, and the next generation when the user reaches the end of a
 * batch. An empty batch marks the run exhausted.
 */
function useRun(args: {
  runKey: string;
  ready: boolean;
  loadBatch: (generation: number) => Promise<LibraryPuzzle[]>;
}): {
  puzzles: LibraryPuzzle[];
  idx: number;
  loading: boolean;
  error: string | null;
  canExtend: boolean;
  next: () => void;
} {
  const { runKey, ready, loadBatch } = args;
  const [puzzles, setPuzzles] = useState<LibraryPuzzle[]>([]);
  const [idx, setIdx] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [exhausted, setExhausted] = useState(false);
  const [generation, setGeneration] = useState(0);
  const keyRef = useRef<string | null>(null);

  // ONE effect owns loading. Two effects (a reset keyed on the run plus a
  // loader) double-loaded on every switch and raced each other — see git
  // history of this file for the bug that taught that.
  useEffect(() => {
    if (!ready) return;
    let gen = generation;
    if (keyRef.current !== runKey) {
      keyRef.current = runKey;
      gen = 0;
      if (generation !== 0) {
        // Reset and let the effect re-fire with generation 0.
        setGeneration(0);
        return;
      }
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    // Clear immediately so the previous run's puzzle can't stay on screen
    // (and be interacted with) while this load is in flight.
    setPuzzles([]);
    setIdx(0);
    setExhausted(false);

    void (async () => {
      try {
        const got = await loadBatch(gen);
        if (cancelled) return;
        setPuzzles(got);
        setIdx(0);
        setExhausted(got.length === 0);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
    // `loadBatch` is keyed on `runKey` alone, so it is a fair dep. It must
    // stay that way: a new identity reloads the batch and swaps the puzzle
    // under the user.
  }, [runKey, ready, generation, loadBatch]);

  const next = useCallback(() => {
    // Branch outside the updater: calling `setGeneration` from inside a
    // `setIdx` callback is a side effect in a reducer, which React is free to
    // invoke twice (it does in StrictMode) — double-bumping the generation and
    // skipping a whole batch.
    if (idx + 1 < puzzles.length) {
      setIdx(idx + 1);
    } else {
      setGeneration((g) => g + 1);
    }
  }, [idx, puzzles.length]);

  return { puzzles, idx, loading, error, canExtend: !exhausted, next };
}
