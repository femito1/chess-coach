import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PuzzleAttempt } from '@/db/schema';
import { RATING_MAX, RATING_MIN } from '@/data/puzzles.meta.generated';
import { tMotifLabel } from '@/i18n/chess';
import type { PuzzleRating } from './rating';
import type { RecommendationPlan } from './recommend';
import { MIN_THEME_SAMPLE, themeStats, type ThemeStat } from './stats';
import {
  THEME_GROUP_ORDER,
  THEME_GROUPS,
  themeCountInWindow,
} from './themeCatalog';
import { formatThemeName } from './themeLabels';

/**
 * Train's two controls: what kind of puzzle, and how hard.
 *
 * Difficulty is an offset from your puzzle rating, not a fixed band. The
 * five presets cover what's useful in practice — −400 to warm up or drill
 * speed, your level, +400 to stretch calculation — and "Exact" pins a
 * rating for anyone who wants to work one band deliberately. Whatever is
 * picked, the line beside it shows the real window the run is drawn from.
 */

export type ThemeChoice = 'mix' | 'foryou' | string;
/** `rel:<offset>` or `fix:<rating>`, persisted as a string. */
export type Difficulty = `rel:${number}` | `fix:${number}`;

export const DIFFICULTY_OFFSETS: readonly number[] = [-400, -200, 0, 200, 400];

export function isThemeChoice(v: unknown): v is ThemeChoice {
  return typeof v === 'string' && v.length > 0 && v.length < 40;
}

export function isDifficulty(v: unknown): v is Difficulty {
  return typeof v === 'string' && /^(rel|fix):-?\d+$/.test(v);
}

/** Target rating for a difficulty, given the user's current rating. */
export function centerFor(d: Difficulty, rating: number): number {
  const n = Number(d.slice(4));
  const c = d.startsWith('fix:') ? n : rating + n;
  return Math.max(RATING_MIN, Math.min(RATING_MAX, Math.round(c)));
}

export function TrainBar({
  theme,
  onTheme,
  difficulty,
  onDifficulty,
  rating,
  rows,
  window: win,
  plan,
  planLoaded,
  hasAnalyzedGames,
}: {
  theme: ThemeChoice;
  onTheme: (t: ThemeChoice) => void;
  difficulty: Difficulty;
  onDifficulty: (d: Difficulty) => void;
  rating: PuzzleRating;
  rows: readonly PuzzleAttempt[];
  /** The window the current run was actually drawn from. */
  window: { lo: number; hi: number; widened: boolean } | null;
  plan: RecommendationPlan | null;
  planLoaded: boolean;
  hasAnalyzedGames: boolean;
}) {
  const { t } = useTranslation();
  const [pickerOpen, setPickerOpen] = useState(false);
  const center = centerFor(difficulty, rating.rating);

  const themeLabel =
    theme === 'mix'
      ? t('puzzles.train.mixed')
      : theme === 'foryou'
        ? t('puzzles.train.forYou')
        : formatThemeName(theme);

  return (
    <div className="space-y-2">
      <div className="card p-2 flex flex-wrap items-center gap-x-3 gap-y-2">
        <button
          type="button"
          className={`btn text-sm flex items-center gap-1.5 ${pickerOpen ? 'border-accent/50' : ''}`}
          onClick={() => setPickerOpen((o) => !o)}
          aria-expanded={pickerOpen}
        >
          <span className="text-text-muted text-xs">{t('puzzles.train.theme')}</span>
          <span className="font-medium">{themeLabel}</span>
          <span className="text-text-muted text-xs" aria-hidden>
            {pickerOpen ? '▴' : '▾'}
          </span>
        </button>

        <DifficultyControl
          difficulty={difficulty}
          onChange={onDifficulty}
          rating={rating.rating}
        />

        {win && (
          <span className="text-xs text-text-muted tabular-nums">
            {t('puzzles.train.window', { lo: win.lo, hi: win.hi })}
            {win.widened && (
              <span className="ml-1" title={t('puzzles.train.widenedTitle')}>
                {t('puzzles.train.widened')}
              </span>
            )}
          </span>
        )}
      </div>

      {pickerOpen && (
        <ThemePicker
          theme={theme}
          center={center}
          rows={rows}
          hasAnalyzedGames={hasAnalyzedGames}
          onPick={(th) => {
            onTheme(th);
            setPickerOpen(false);
          }}
        />
      )}

      {theme === 'foryou' && planLoaded && plan && plan.motifs.length > 0 && (
        <RecommendedSummary plan={plan} />
      )}
    </div>
  );
}

function DifficultyControl({
  difficulty,
  onChange,
  rating,
}: {
  difficulty: Difficulty;
  onChange: (d: Difficulty) => void;
  rating: number;
}) {
  const { t } = useTranslation();
  const fixed = difficulty.startsWith('fix:');
  const value = Number(difficulty.slice(4));

  return (
    <div className="flex items-center gap-1 flex-wrap" role="group" aria-label={t('puzzles.train.difficulty')}>
      <div className="inline-flex rounded-md border border-border overflow-hidden">
        {DIFFICULTY_OFFSETS.map((off) => {
          const active = !fixed && value === off;
          return (
            <button
              key={off}
              type="button"
              aria-pressed={active}
              onClick={() => onChange(`rel:${off}`)}
              title={t('puzzles.train.offsetTitle', {
                rating: Math.round(rating + off),
              })}
              className={`px-2 py-1 text-xs tabular-nums transition-colors ${
                active ? 'bg-accent/15 text-accent' : 'text-text-muted hover:text-text'
              }`}
            >
              {off === 0 ? t('puzzles.train.yourLevel') : off > 0 ? `+${off}` : `−${-off}`}
            </button>
          );
        })}
        <button
          type="button"
          aria-pressed={fixed}
          onClick={() =>
            onChange(`fix:${Math.round(centerFor(difficulty, rating) / 50) * 50}`)
          }
          className={`px-2 py-1 text-xs border-l border-border transition-colors ${
            fixed ? 'bg-accent/15 text-accent' : 'text-text-muted hover:text-text'
          }`}
        >
          {t('puzzles.train.exact')}
        </button>
      </div>
      {fixed && (
        <div className="inline-flex items-center gap-1">
          <button
            type="button"
            className="btn text-xs px-2"
            aria-label={t('puzzles.train.lower')}
            onClick={() => onChange(`fix:${Math.max(RATING_MIN, value - 50)}`)}
          >
            −
          </button>
          <input
            type="number"
            className="input w-20 text-xs py-1 tabular-nums"
            min={RATING_MIN}
            max={RATING_MAX}
            step={50}
            value={value}
            aria-label={t('puzzles.train.exactRating')}
            onChange={(e) => {
              const n = Math.round(Number(e.target.value));
              if (Number.isFinite(n) && n >= RATING_MIN && n <= RATING_MAX) {
                onChange(`fix:${n}`);
              }
            }}
          />
          <button
            type="button"
            className="btn text-xs px-2"
            aria-label={t('puzzles.train.higher')}
            onClick={() => onChange(`fix:${Math.min(RATING_MAX, value + 50)}`)}
          >
            +
          </button>
        </div>
      )}
    </div>
  );
}

/** Rough "how many puzzles of this theme exist near you" for the chips —
 *  ±150 is the window most themes get served from. */
const COUNT_HALF_WINDOW = 150;
/** Below this many near you, a chip is dimmed: selectable, but the run
 *  will be drawn from well outside your level. */
const SPARSE_COUNT = 30;

function compact(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n);
}

function ThemePicker({
  theme,
  center,
  rows,
  hasAnalyzedGames,
  onPick,
}: {
  theme: ThemeChoice;
  center: number;
  rows: readonly PuzzleAttempt[];
  hasAnalyzedGames: boolean;
  onPick: (t: ThemeChoice) => void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const stats = useMemo(() => {
    const m = new Map<string, ThemeStat>();
    for (const s of themeStats(rows, Date.now())) m.set(s.theme, s);
    return m;
  }, [rows]);
  // Your weakest themes relative to your own rating — the most useful thing
  // to pick, so it's offered first rather than buried in the groups.
  const weakest = useMemo(
    () =>
      [...stats.values()]
        .filter((s) => s.attempts >= MIN_THEME_SAMPLE && s.edge < -0.05)
        .sort((a, b) => a.edge - b.edge)
        .slice(0, 4),
    [stats],
  );

  const q = query.trim().toLowerCase();
  const matches = (th: string) =>
    !q || formatThemeName(th).toLowerCase().includes(q) || th.toLowerCase().includes(q);

  const chip = (th: string) => {
    const n = themeCountInWindow(th, center - COUNT_HALF_WINDOW, center + COUNT_HALF_WINDOW);
    const s = stats.get(th);
    const showRate = s && s.attempts >= MIN_THEME_SAMPLE;
    return (
      <button
        key={th}
        type="button"
        onClick={() => onPick(th)}
        aria-pressed={theme === th}
        title={t('puzzles.train.chipTitle', { count: n })}
        className={`text-xs px-2 py-1 rounded border transition-colors flex items-baseline gap-1.5 ${
          theme === th
            ? 'border-accent/60 bg-accent/10 text-accent'
            : 'border-border hover:border-accent/40'
        } ${n < SPARSE_COUNT && theme !== th ? 'opacity-50' : ''}`}
      >
        <span>{formatThemeName(th)}</span>
        <span className="text-[10px] text-text-muted tabular-nums">{compact(n)}</span>
        {showRate && (
          <span
            className={`text-[10px] tabular-nums ${s.edge < -0.05 ? 'text-blunder' : s.edge > 0.05 ? 'text-good' : 'text-text-muted'}`}
          >
            {Math.round((s.clean / s.attempts) * 100)}%
          </span>
        )}
      </button>
    );
  };

  return (
    <div className="card p-3 space-y-3">
      <input
        type="search"
        className="input text-sm"
        placeholder={t('puzzles.train.searchThemes')}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        autoFocus
      />

      {!q && (
        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={() => onPick('mix')}
            aria-pressed={theme === 'mix'}
            className={`text-xs px-2 py-1 rounded border ${theme === 'mix' ? 'border-accent/60 bg-accent/10 text-accent' : 'border-border hover:border-accent/40'}`}
          >
            {t('puzzles.train.mixed')}
          </button>
          <button
            type="button"
            onClick={() => onPick('foryou')}
            aria-pressed={theme === 'foryou'}
            title={hasAnalyzedGames ? t('puzzles.subtitleRecommended') : t('puzzles.recommendedNeedsGames')}
            className={`text-xs px-2 py-1 rounded border ${theme === 'foryou' ? 'border-accent/60 bg-accent/10 text-accent' : 'border-border hover:border-accent/40'} ${hasAnalyzedGames ? '' : 'opacity-50'}`}
          >
            {t('puzzles.train.forYou')}
          </button>
        </div>
      )}

      {!q && weakest.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-[11px] uppercase tracking-wide text-text-muted">
            {t('puzzles.train.weakest')}
          </div>
          <div className="flex flex-wrap gap-1.5">{weakest.map((s) => chip(s.theme))}</div>
        </div>
      )}

      {THEME_GROUP_ORDER.map((g) => {
        const themes = THEME_GROUPS[g].filter(matches);
        if (themes.length === 0) return null;
        return (
          <div key={g} className="space-y-1.5">
            <div className="text-[11px] uppercase tracking-wide text-text-muted">
              {t(`puzzles.themeGroups.${g}`)}
            </div>
            <div className="flex flex-wrap gap-1.5">{themes.map(chip)}</div>
          </div>
        );
      })}

      <p className="text-[11px] text-text-muted">{t('puzzles.train.pickerLegend')}</p>
    </div>
  );
}

/**
 * The "why these puzzles" line for "From your games".
 *
 * Names the matched motifs ONCE for the whole run. It deliberately stops
 * there: it never says which motif the puzzle on screen belongs to, because
 * that would be handing over the answer. You know the session is about
 * forks and back-rank; you don't know which one this position is.
 */
function RecommendedSummary({ plan }: { plan: RecommendationPlan }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-baseline gap-1.5 px-1">
      <span className="text-[11px] uppercase tracking-wide text-text-muted mr-1">
        {t('puzzles.matchedTo')}
      </span>
      {plan.motifs.map((m) => (
        <span
          key={m.motif}
          className="text-xs px-2 py-0.5 rounded bg-bg-raised flex items-baseline gap-1.5"
          title={t('puzzles.motifWeight', {
            count: m.mistakeCount,
            days: Math.max(1, Math.round((Date.now() - m.lastSeenAt) / 86_400_000)),
          })}
        >
          <span className="font-medium">{tMotifLabel(t, m.motif)}</span>
          <span className="text-text-muted tabular-nums">{Math.round(m.share * 100)}%</span>
        </span>
      ))}
    </div>
  );
}
