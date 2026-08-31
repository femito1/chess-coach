import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import {
  db,
  getSettings,
  normalizeTimeClassSelection,
  type Analysis,
  type TimeClassSelection,
} from '@/db/schema';
import { listAllGamesLight, type GameLight } from '@/db/queries';
import { useThrottledLiveQuery } from '@/lib/useThrottledLiveQuery';
import { gameMatchesSelection } from '@/lib/timeClass';
import { usePersistedState } from '@/lib/usePersistedState';
import { tMotifLabel } from '@/i18n/chess';
import { PUZZLE_TOTAL } from '@/data/puzzles.meta.generated';
import {
  shardsForRatingWindow,
  shardsForTier,
  tierPuzzleCount,
  tierRatingRange,
  type LibraryPuzzle,
  type TierId,
} from './corpus';
import {
  buildRecommendedQueue,
  START_CURSOR,
  takeTierPuzzles,
  type QueueCursor,
} from './queue';
import {
  estimateUserRating,
  recommendationPlan,
  type RecommendationPlan,
} from './recommend';
import { buildMistakes } from './mistakes';
import { loadSolvedIds, recordAttempt } from './attempts';
import {
  BOARD_CLAMP_PX,
  BOARD_CLAMP_WITH_SUMMARY_PX,
  LibraryPuzzleSolver,
  type SolveOutcome,
} from './LibraryPuzzleSolver';

/**
 * The Puzzles page.
 *
 * Serves the bundled Lichess corpus (191k vetted, human-rated positions —
 * see `scripts/build-puzzles.mjs`) across five tabs. Four are difficulty
 * ladders; the fifth, Recommended, is matched to the motifs the user has
 * been fumbling *lately* (`recommend.ts`).
 *
 * This replaces a page that generated puzzles from the user's own blunders.
 * That model produced a small, uneven pool of positions the user had
 * already seen, which doesn't hold up for someone playing a lot of games.
 */

type TabId = TierId | 'recommended';

const TABS: TabId[] = ['recommended', 'easy', 'medium', 'hard', 'all'];

/** Puzzles fetched per run. One shard is 4k rows, so a 20-puzzle run is
 *  always satisfied from a single fetch in the common case. */
const RUN_LENGTH = 20;

function isTabId(v: unknown): v is TabId {
  return typeof v === 'string' && (TABS as string[]).includes(v);
}

export function PuzzlesPage() {
  const { t } = useTranslation();
  const [tab, setTab] = usePersistedState<TabId>('puzzles.tab', 'recommended', {
    isValid: isTabId,
  });

  const solved = useSolvedIds();
  // Only pay for the games + analyses read when Recommended is actually
  // showing. Analyses carry full move lists, so this is the single most
  // expensive read on the page and the tier tabs don't need it at all.
  const recommendation = useRecommendation(tab === 'recommended');

  const run = useRun({
    tab,
    solved: solved.ids,
    solvedLoaded: solved.loaded,
    plan: recommendation.plan,
    planLoaded: recommendation.loaded,
  });

  const [streak, setStreak] = useState(0);

  const onDone = useCallback(
    async (outcome: SolveOutcome) => {
      setStreak((n) => (outcome.clean ? n + 1 : 0));
      await recordAttempt({
        puzzleId: outcome.puzzleId,
        rating: outcome.rating,
        clean: outcome.clean,
        hintUsed: outcome.hintUsed,
        msTaken: outcome.msTaken,
      });
      // Deliberately NOT refreshing `solved` here. Retiring the puzzle
      // mid-run would renumber the strip under the user and could yank the
      // current puzzle out from under them. The exclusion set is re-read
      // when the next run is built.
    },
    [],
  );

  const current = run.puzzles[run.idx];
  const showRecommendedSummary = Boolean(
    tab === 'recommended' &&
      recommendation.loaded &&
      recommendation.plan &&
      recommendation.plan.motifs.length > 0,
  );

  return (
    <div className="space-y-4">
      <Header tab={tab} />

      <TabBar tab={tab} onChange={setTab} />

      {showRecommendedSummary && recommendation.plan && (
        <RecommendedSummary plan={recommendation.plan} />
      )}

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

      {!run.error && !run.loading && !current && (
        <EmptyState tab={tab} recommendation={recommendation} />
      )}

      {!run.error && current && (
        <LibraryPuzzleSolver
          key={current.id}
          puzzle={current}
          index={run.idx + 1}
          total={run.puzzles.length}
          streak={streak}
          // The Recommended summary card sits above the board, so the board
          // has less vertical room there than on a tier tab.
          boardClampPx={
            showRecommendedSummary ? BOARD_CLAMP_WITH_SUMMARY_PX : BOARD_CLAMP_PX
          }
          sessionNote={
            tab === 'recommended' && recommendation.plan
              ? sessionNoteFor(recommendation.plan, t)
              : undefined
          }
          onDone={onDone}
          onNext={run.next}
          hasNext={run.idx + 1 < run.puzzles.length || run.canExtend}
        />
      )}
    </div>
  );
}

/* =======================================================================
 *  Header + tabs
 * =======================================================================
 */

function Header({ tab }: { tab: TabId }) {
  const { t } = useTranslation();
  return (
    <div className="flex items-end justify-between gap-4 flex-wrap">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{t('puzzles.title')}</h1>
        <p className="text-sm text-text-muted mt-0.5">
          {tab === 'recommended'
            ? t('puzzles.subtitleRecommended')
            : t('puzzles.subtitleLibrary', { total: PUZZLE_TOTAL.toLocaleString() })}
        </p>
      </div>
    </div>
  );
}

/**
 * Tab bar. Each tier tab carries its real rating range as a subtitle,
 * pulled from the shard manifest rather than hard-coded — so the label can
 * never claim a range the shipped corpus doesn't actually hold.
 */
function TabBar({ tab, onChange }: { tab: TabId; onChange: (t: TabId) => void }) {
  const { t } = useTranslation();
  return (
    <div
      role="tablist"
      aria-label={t('puzzles.title')}
      className="flex gap-1 overflow-x-auto border-b border-border -mb-px"
    >
      {TABS.map((id) => {
        const active = id === tab;
        const range = id === 'recommended' ? null : tierRatingRange(id);
        return (
          <button
            key={id}
            role="tab"
            aria-selected={active}
            type="button"
            onClick={() => onChange(id)}
            className={`px-3 py-2 text-sm whitespace-nowrap border-b-2 -mb-px transition-colors ${
              active
                ? 'border-accent text-accent'
                : 'border-transparent text-text-muted hover:text-text'
            }`}
          >
            <span className="block font-medium">{t(`puzzles.tabs.${id}`)}</span>
            <span className="block text-[10px] tabular-nums opacity-70">
              {id === 'recommended'
                ? t('puzzles.tabs.forYou')
                : range
                  ? `${range.lo}-${range.hi}`
                  : '—'}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * The session-level "why these puzzles" line for Recommended.
 *
 * Names the matched motifs ONCE for the whole run. It deliberately stops
 * there: it never says which motif the puzzle on screen belongs to, because
 * that would be handing over the answer. You know the session is about
 * forks and back-rank; you don't know which one this position is.
 */
function RecommendedSummary({ plan }: { plan: RecommendationPlan }) {
  const { t } = useTranslation();
  if (plan.motifs.length === 0) return null;

  return (
    <div className="card p-3 space-y-2">
      <div className="text-xs uppercase tracking-wide text-text-muted">
        {t('puzzles.matchedTo')}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {plan.motifs.map((m) => (
          <span
            key={m.motif}
            className="text-xs px-2 py-1 rounded bg-bg-raised flex items-baseline gap-1.5"
            title={t('puzzles.motifWeight', {
              count: m.mistakeCount,
              days: Math.max(1, Math.round((Date.now() - m.lastSeenAt) / 86_400_000)),
            })}
          >
            <span className="font-medium">{tMotifLabel(t, m.motif)}</span>
            <span className="text-text-muted tabular-nums">
              {Math.round(m.share * 100)}%
            </span>
          </span>
        ))}
      </div>
      <p className="text-[11px] text-text-muted">
        {t('puzzles.recencyNote', {
          lo: plan.ratingLo,
          hi: plan.ratingHi,
        })}
      </p>
    </div>
  );
}

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
  tab,
  recommendation,
}: {
  tab: TabId;
  recommendation: ReturnType<typeof useRecommendation>;
}) {
  const { t } = useTranslation();

  if (tab === 'recommended') {
    // Distinguish "no analyzed games yet" from "analyzed games, but no
    // motif cleared the noise floor" — they need different next steps.
    const reason = recommendation.hasAnalyzedGames
      ? t('puzzles.recommendedNoMotifs')
      : t('puzzles.recommendedNeedsGames');
    return (
      <div className="card p-6 text-sm text-text-muted space-y-2">
        <p>{reason}</p>
        <p>{t('puzzles.recommendedFallbackHint')}</p>
      </div>
    );
  }

  return (
    <div className="card p-6 text-sm text-text-muted">
      {t('puzzles.tierExhausted', { count: tierPuzzleCount(tab as TierId) })}
    </div>
  );
}

/* =======================================================================
 *  Data hooks
 * =======================================================================
 */

function useSolvedIds(): { ids: Set<string>; loaded: boolean } {
  const [ids, setIds] = useState<Set<string>>(() => new Set());
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void loadSolvedIds().then((s) => {
      if (cancelled) return;
      setIds(s);
      setLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return { ids, loaded };
}

/**
 * Compute the recommendation plan from the user's analyzed games.
 *
 * Only runs when `active`, because it reads every analysis's full move list
 * — the same cost the old Weaknesses page paid, which is why that page was
 * slow on large libraries. Throttled live queries keep it from refiring on
 * every write during an analysis run.
 */
function useRecommendation(active: boolean): {
  plan: RecommendationPlan | null;
  loaded: boolean;
  hasAnalyzedGames: boolean;
} {
  const games = useThrottledLiveQuery(
    () => (active ? listAllGamesLight() : Promise.resolve([] as GameLight[])),
    [active],
    1000,
  );

  /**
   * Time-class selection from Settings, default `['rapid']`.
   *
   * Recommended honours it for the reason the setting exists: bullet
   * mistakes are high-volume and low-signal — you blunder in bullet because
   * of the clock, not because of a pattern gap — so letting them into the
   * motif scoring would drown out the mistakes that actually indicate a
   * weakness. This is the same filter the old Weaknesses and Puzzles pages
   * applied, and `Settings.timeClassFilter` is documented as governing it.
   */
  const [timeClasses, setTimeClasses] = useState<TimeClassSelection>(['rapid']);
  useEffect(() => {
    void getSettings().then((s) =>
      setTimeClasses(normalizeTimeClassSelection(s.timeClassFilter)),
    );
  }, []);

  const analyzed = useMemo(
    () =>
      (games ?? []).filter(
        (g) => g.analysisStatus === 'done' && gameMatchesSelection(g, timeClasses),
      ),
    [games, timeClasses],
  );

  const analyses = useThrottledLiveQuery(
    async () => {
      if (!active || analyzed.length === 0) return [] as Analysis[];
      const rows = await db.analyses.bulkGet(analyzed.map((g) => g.id));
      return rows.filter((a): a is Analysis => Boolean(a));
    },
    [active, analyzed],
    1000,
  );

  const plan = useMemo(() => {
    if (!active || !games || !analyses) return null;
    const map = new Map<string, Analysis>();
    for (const a of analyses) map.set(a.gameId, a);
    const rows = buildMistakes(analyzed, map);
    return recommendationPlan({
      rows,
      now: Date.now(),
      userRating: estimateUserRating(analyzed),
      queueLength: RUN_LENGTH,
    });
    // `Date.now()` in a memo is fine here: the deps only change on a data
    // refire, and re-scoring on a stale clock would at worst shift decay
    // weights by minutes on a 30-day half-life.
  }, [active, games, analyses, analyzed]);

  return {
    plan,
    loaded: !active || (Boolean(games) && Boolean(analyses)),
    hasAnalyzedGames: analyzed.length > 0,
  };
}

/**
 * Owns the current run of puzzles and the position within it.
 *
 * Tier tabs walk their shards with a persistent cursor, so asking for more
 * resumes where the last run stopped rather than rescanning shards the user
 * has already cleared. Recommended rebuilds from its plan instead — its
 * selection isn't a linear walk, so there's no cursor to advance.
 */
function useRun(args: {
  tab: TabId;
  solved: Set<string>;
  solvedLoaded: boolean;
  plan: RecommendationPlan | null;
  planLoaded: boolean;
}): {
  puzzles: LibraryPuzzle[];
  idx: number;
  loading: boolean;
  error: string | null;
  canExtend: boolean;
  next: () => void;
} {
  const { tab, solved, solvedLoaded, plan, planLoaded } = args;

  const [puzzles, setPuzzles] = useState<LibraryPuzzle[]>([]);
  const [idx, setIdx] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [exhausted, setExhausted] = useState(false);
  const cursorRef = useRef<QueueCursor>(START_CURSOR);
  /** Bumped to pull the NEXT batch after the user finishes a run. */
  const [generation, setGeneration] = useState(0);
  /** Which tab the current `cursorRef` belongs to, so we can tell a tab
   *  switch (reset the cursor) from a run extension (keep it). */
  const cursorTabRef = useRef<TabId | null>(null);

  const ready = solvedLoaded && (tab !== 'recommended' || planLoaded);

  // ONE effect owns loading.
  //
  // This used to be two — a reset effect keyed on `tab` that bumped
  // `generation`, plus this loader. That double-loaded on every tab switch
  // (both effects listed `tab`), and the two async loads then raced for
  // `cursorRef`: whichever read it first won, so the user non-
  // deterministically got either the first 20 puzzles or puzzles 20-40,
  // silently skipping the easiest ones. Keeping a single effect makes the
  // load order unambiguous.
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;

    // A tab switch restarts that tier's ladder from its easiest unsolved
    // puzzle. Resuming mid-tier would be wrong: solved puzzles are already
    // filtered out by `isExcluded`, so restarting costs only a rescan and
    // guarantees "hardest thing you haven't cleared" stays true even after
    // you solve some, navigate away, and come back.
    if (cursorTabRef.current !== tab) {
      cursorRef.current = START_CURSOR;
      cursorTabRef.current = tab;
    }

    setLoading(true);
    setError(null);
    // Clear immediately so the previous tab's puzzle can't stay on screen
    // (and be interacted with) while this load is in flight.
    setPuzzles([]);
    setIdx(0);
    // Otherwise a tab whose ladder was exhausted leaves `canExtend` false on
    // the next tab, disabling its "Next puzzle" button.
    setExhausted(false);

    const isExcluded = (id: string) => solved.has(id);

    void (async () => {
      try {
        if (tab === 'recommended') {
          if (!plan || plan.allocation.length === 0) {
            if (!cancelled) {
              setPuzzles([]);
              setExhausted(true);
            }
            return;
          }
          const shards = shardsForRatingWindow(plan.ratingLo, plan.ratingHi);
          const got = await buildRecommendedQueue({
            plan,
            shards,
            isExcluded,
            // Vary the run between sessions, but keep it stable across the
            // re-renders within one.
            seed: generation * 7919 + Math.floor(Date.now() / 3_600_000),
          });
          if (cancelled) return;
          setPuzzles(got);
          setIdx(0);
          setExhausted(got.length === 0);
          return;
        }

        const shards = shardsForTier(tab);
        const res = await takeTierPuzzles({
          shards,
          cursor: cursorRef.current,
          count: RUN_LENGTH,
          isExcluded,
        });
        if (cancelled) return;
        cursorRef.current = res.cursor;
        setPuzzles(res.puzzles);
        setIdx(0);
        setExhausted(res.puzzles.length === 0);
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
    // `solved` is intentionally not a dep: it's captured for exclusion at
    // run-build time, and re-running on every recorded attempt would
    // rebuild the run mid-session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, ready, plan, generation]);

  const next = useCallback(() => {
    // Branch outside the updater: calling `setGeneration` from inside a
    // `setIdx` callback is a side effect in a reducer, which React is free to
    // invoke twice (it does in StrictMode) — double-bumping the generation and
    // skipping a whole batch.
    if (idx + 1 < puzzles.length) {
      setIdx(idx + 1);
    } else {
      // End of the run: pull the next batch. Tier tabs continue from
      // `cursorRef`; Recommended re-draws from its plan.
      setGeneration((g) => g + 1);
    }
  }, [idx, puzzles.length]);

  return {
    puzzles,
    idx,
    loading,
    error,
    canExtend: !exhausted,
    next,
  };
}
