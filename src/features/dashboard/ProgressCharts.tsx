import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import {
  accuracyTrend,
  ratingTrend,
  winRateByOpening,
  type GameForCharts,
} from './progress';
import { usePersistedState } from '@/lib/usePersistedState';
import { PrepGapsCard } from './PrepGapsCard';
import { resolveOpeningFamily } from '@/features/openings/library';
import { familiesFromGameMoves } from '@/features/openings/identifyFromGame';
import { db } from '@/db/schema';
import { useLiveQuery } from 'dexie-react-hooks';

const AXIS_COLOR = '#9aa3b2';
const GRID_COLOR = '#2a313d';
const TOOLTIP_STYLE = {
  background: '#161a22',
  border: '1px solid #2a313d',
  fontSize: 12,
} as const;

/** Options for the trend-graph time-window picker. `null` = no cutoff. */
type RangeKey = '7d' | '30d' | '90d' | '1y' | 'all';
const RANGE_OPTIONS: { key: RangeKey; label: string; days: number | null }[] = [
  { key: '7d', label: '7d', days: 7 },
  { key: '30d', label: '30d', days: 30 },
  { key: '90d', label: '90d', days: 90 },
  { key: '1y', label: '1y', days: 365 },
  { key: 'all', label: 'All', days: null },
];

/** Chop a list with a `t` epoch-ms field down to entries within the last
 *  `days` days. We compare against the latest entry rather than `Date.now()`
 *  so importing an older archive still shows that archive's own trend
 *  instead of an empty graph. */
function withinRange<T extends { t: number }>(rows: T[], days: number | null): T[] {
  if (days == null || rows.length === 0) return rows;
  const newest = rows[rows.length - 1].t;
  const cutoff = newest - days * 24 * 60 * 60 * 1000;
  return rows.filter((r) => r.t >= cutoff);
}

const TIME_CLASS_COLOR: Record<string, string> = {
  rapid: '#7aa2f7',
  blitz: '#e69138',
  bullet: '#e06c75',
  daily: '#7bc47f',
  classical: '#c678dd',
  other: '#9aa3b2',
};

function fmtDate(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Multi-select time-class filter. The user starts with every available
 *  class active (the chart shows everything). Clicking a chip toggles
 *  it out of the active set; clicking "All" restores the full set.
 *
 *  Convention: `null` = "active set is the full available set" (the
 *  default). A concrete `string[]` is an explicit subset. We don't
 *  collapse the default to `[]` because empty would be ambiguous with
 *  "user deselected everything" (which legitimately produces an empty
 *  chart). The "All" button always sets the state back to `null`.
 */
type ModeSelection = string[] | null;

/** Display order for time-class chips. We only render entries the user
 *  actually has data for, but we want a stable left-to-right order. */
const MODE_ORDER = ['rapid', 'blitz', 'bullet', 'daily', 'classical', 'other'];

/** Translate a time-class key (`'rapid'`, `'blitz'`, etc.) into a
 *  display label. Falls back to a Title-cased version of the raw key
 *  if the catalog doesn't have the mode — guards against a future
 *  Chess.com adding a new time class we haven't translated yet. */
function modeLabel(t: TFunction, mode: string): string {
  const key = `charts.modes.${mode}`;
  const translated = t(key);
  // If i18next can't find the key, it returns the key itself (with
  // returnNull: false). Detect that and fall back.
  if (translated === key) {
    return mode.charAt(0).toUpperCase() + mode.slice(1);
  }
  return translated;
}

/** True when this selection includes the given class. `null` means
 *  "all available", so we treat anything in the available list as in. */
function selectionIncludes(
  selection: ModeSelection,
  available: string[],
  cls: string,
): boolean {
  if (selection == null) return available.includes(cls);
  return selection.includes(cls);
}

/** True when the selection is "all available" — used to drive the
 *  "All" chip's active state and to short-circuit filtering downstream. */
function isAllSelected(selection: ModeSelection, available: string[]): boolean {
  if (selection == null) return true;
  if (selection.length !== available.length) return false;
  for (const a of available) if (!selection.includes(a)) return false;
  return true;
}

/** Toggle a class in/out of the selection given the available set. We
 *  materialise `null` (the default-all state) into a concrete array on
 *  first toggle so subsequent clicks have something to remove from. */
function toggleMode(
  selection: ModeSelection,
  available: string[],
  cls: string,
): ModeSelection {
  const current =
    selection == null ? [...available] : selection.filter((m) => available.includes(m));
  if (current.includes(cls)) {
    return current.filter((m) => m !== cls);
  }
  return [...current, cls];
}

/** Persisted-state shape guards. Persisted values are user-controlled
 *  (anyone can edit `localStorage` from DevTools), and we do silent
 *  shape changes over time as we add new range options or remove time
 *  classes — so every persisted-state read is gated behind a runtime
 *  check that drops the persisted value if it doesn't match the
 *  current type. Cheaper than versioning every micro-change. */
const isRangeKey = (v: unknown): v is RangeKey =>
  v === '7d' || v === '30d' || v === '90d' || v === '1y' || v === 'all';

const isModeSelection = (v: unknown): v is ModeSelection =>
  v === null || (Array.isArray(v) && v.every((x) => typeof x === 'string'));

export function ProgressCharts({ games }: { games: ReadonlyArray<GameForCharts> }) {
  const { t } = useTranslation();
  // Independent time-window selectors per chart so the user can zoom one
  // without losing context in the other (e.g. last-7-days rating spike
  // vs. all-time accuracy trend). Persisted to `localStorage` so the
  // selection survives reloads — these are UI preferences, not chess
  // data, so they don't go through the Settings (Dexie) layer that
  // syncs across devices once Phase 2 ships.
  const [ratingRange, setRatingRange] = usePersistedState<RangeKey>(
    'dashboard:rating-range',
    'all',
    { isValid: isRangeKey },
  );
  const [ratingMode, setRatingMode] = usePersistedState<ModeSelection>(
    'dashboard:rating-mode',
    null,
    { isValid: isModeSelection },
  );
  const [accuracyRange, setAccuracyRange] = usePersistedState<RangeKey>(
    'dashboard:accuracy-range',
    'all',
    { isValid: isRangeKey },
  );
  const [accuracyMode, setAccuracyMode] = usePersistedState<ModeSelection>(
    'dashboard:accuracy-mode',
    null,
    { isValid: isModeSelection },
  );
  // The win-rate-by-opening card uses the same chip-bar contract as the
  // rating + accuracy charts. Independent state so a user filtering one
  // doesn't leak into the others.
  const [openingMode, setOpeningMode] = usePersistedState<ModeSelection>(
    'dashboard:opening-mode',
    null,
    { isValid: isModeSelection },
  );

  const ratingsAll = useMemo(() => ratingTrend(games), [games]);
  // We deliberately compute the unfiltered series first to feed the
  // mode picker (which needs to know what classes are available); the
  // filtered version is computed below once we know the effective mode.
  const accuracyAllNoFilter = useMemo(() => accuracyTrend(games, 'all'), [games]);

  // Time classes that actually appear in the rating data, sorted by our
  // canonical order with any unknown classes appended at the end.
  const availableModes = useMemo(() => {
    const present = new Set(ratingsAll.map((r) => r.timeClass));
    const ordered = MODE_ORDER.filter((m) => present.has(m));
    for (const m of present) {
      if (!ordered.includes(m)) ordered.push(m);
    }
    return ordered;
  }, [ratingsAll]);

  // Time classes that actually have *accuracy* data (analyzed games).
  // Different from `availableModes` because rating data exists for every
  // imported game whereas accuracy only exists once analysis finishes.
  const availableAccuracyModes = useMemo(() => {
    const present = new Set(accuracyAllNoFilter.map((r) => r.timeClass));
    const ordered = MODE_ORDER.filter((m) => present.has(m));
    for (const m of present) {
      if (!ordered.includes(m)) ordered.push(m);
    }
    return ordered;
  }, [accuracyAllNoFilter]);

  // Time classes that contribute to the opening table. Same shape as
  // `availableModes` but derived directly from the games array — we
  // need to consider every imported game (the opening card doesn't
  // require analysis to display W/D/L), and we only count classes
  // attached to games that have at least an opening name.
  const availableOpeningModes = useMemo(() => {
    const present = new Set<string>();
    for (const g of games) {
      if (!g.opening) continue;
      present.add(g.timeClass ?? 'other');
    }
    const ordered = MODE_ORDER.filter((m) => present.has(m));
    for (const m of present) {
      if (!ordered.includes(m)) ordered.push(m);
    }
    return ordered;
  }, [games]);

  // Drop any explicitly-selected modes the user no longer has data for
  // (e.g. they renamed an account; chips for the old data hung around).
  // `null` means "all available" — always valid.
  const effectiveRatingMode: ModeSelection =
    ratingMode == null
      ? null
      : ratingMode.filter((m) => availableModes.includes(m));
  const effectiveAccuracyMode: ModeSelection =
    accuracyMode == null
      ? null
      : accuracyMode.filter((m) => availableAccuracyModes.includes(m));
  const effectiveOpeningMode: ModeSelection =
    openingMode == null
      ? null
      : openingMode.filter((m) => availableOpeningModes.includes(m));

  const ratingAllSelected = isAllSelected(effectiveRatingMode, availableModes);
  const accuracyAllSelected = isAllSelected(
    effectiveAccuracyMode,
    availableAccuracyModes,
  );
  const openingAllSelected = isAllSelected(
    effectiveOpeningMode,
    availableOpeningModes,
  );

  const openings = useMemo(() => {
    if (openingAllSelected) return winRateByOpening(games, 10);
    return winRateByOpening(
      games,
      10,
      effectiveOpeningMode ?? availableOpeningModes,
    );
  }, [games, openingAllSelected, effectiveOpeningMode, availableOpeningModes]);

  const ratings = useMemo(() => {
    const inRange = withinRange(
      ratingsAll,
      RANGE_OPTIONS.find((r) => r.key === ratingRange)?.days ?? null,
    );
    if (ratingAllSelected) return inRange;
    const allowed = new Set(effectiveRatingMode ?? availableModes);
    return inRange.filter((r) => allowed.has(r.timeClass));
  }, [ratingsAll, ratingRange, ratingAllSelected, effectiveRatingMode, availableModes]);

  // The accuracy series is recomputed (not just filtered) when the mode
  // selection changes, so the rolling mean follows only the picked
  // classes' points instead of being polluted by other classes' games.
  const accuracyAllForMode = useMemo(() => {
    if (accuracyAllSelected) return accuracyAllNoFilter;
    return accuracyTrend(games, effectiveAccuracyMode ?? availableAccuracyModes);
  }, [
    games,
    accuracyAllSelected,
    effectiveAccuracyMode,
    availableAccuracyModes,
    accuracyAllNoFilter,
  ]);
  const accuracy = useMemo(
    () =>
      withinRange(
        accuracyAllForMode,
        RANGE_OPTIONS.find((r) => r.key === accuracyRange)?.days ?? null,
      ),
    [accuracyAllForMode, accuracyRange],
  );

  // Pivot rating points so each time class is its own series (recharts
  // expects one key per line). We drop rows that don't have a value for
  // this timeClass — recharts handles gaps with `connectNulls`.
  const ratingByClass = useMemo(() => {
    const classes = Array.from(new Set(ratings.map((r) => r.timeClass)));
    const rows = ratings.map((r) => {
      const row: Record<string, number | string> = { t: r.t, date: fmtDate(r.t) };
      row[r.timeClass] = r.rating;
      return row;
    });
    return { classes, rows };
  }, [ratings]);

  if (games.length === 0) return null;

  return (
    <section className="space-y-3">
      <h2 className="font-medium">{t('charts.sectionTitle')}</h2>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <div className="card p-3">
          <div className="flex flex-wrap items-center justify-between mb-1 gap-2">
            <div className="text-xs uppercase tracking-wide text-text-muted">
              {t('charts.ratingTitle')}
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              {availableModes.length > 1 && (
                <ModePicker
                  selection={effectiveRatingMode}
                  modes={availableModes}
                  allActive={ratingAllSelected}
                  onToggle={(m) =>
                    setRatingMode(toggleMode(effectiveRatingMode, availableModes, m))
                  }
                  onAll={() => setRatingMode(ratingAllSelected ? [] : null)}
                />
              )}
              <RangePicker value={ratingRange} onChange={setRatingRange} />
            </div>
          </div>
          {ratingByClass.rows.length === 0 ? (
            <EmptyChart
              text={
                !ratingAllSelected
                  ? t('charts.empty.ratingNoMode')
                  : t('charts.empty.ratingNoRange')
              }
            />
          ) : (
            <div className="w-full h-56">
              <ResponsiveContainer>
                <LineChart
                  data={ratingByClass.rows}
                  margin={{ left: 0, right: 8, top: 8, bottom: 0 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke={GRID_COLOR} />
                  <XAxis
                    dataKey="t"
                    type="number"
                    domain={['dataMin', 'dataMax']}
                    tickFormatter={(t) => fmtDate(Number(t))}
                    stroke={AXIS_COLOR}
                    fontSize={10}
                  />
                  <YAxis
                    stroke={AXIS_COLOR}
                    width={38}
                    fontSize={10}
                    domain={['dataMin-50', 'dataMax+50']}
                  />
                  <Tooltip
                    contentStyle={TOOLTIP_STYLE}
                    labelFormatter={(t) => fmtDate(Number(t))}
                  />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  {ratingByClass.classes.map((cls) => (
                    <Line
                      key={cls}
                      type="monotone"
                      dataKey={cls}
                      stroke={TIME_CLASS_COLOR[cls] ?? AXIS_COLOR}
                      dot={false}
                      strokeWidth={2}
                      connectNulls
                    />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>

        <div className="card p-3">
          <div className="flex flex-wrap items-center justify-between mb-1 gap-2">
            <div className="text-xs uppercase tracking-wide text-text-muted">
              {t('charts.accuracyTitle')}
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              {availableAccuracyModes.length > 1 && (
                <ModePicker
                  selection={effectiveAccuracyMode}
                  modes={availableAccuracyModes}
                  allActive={accuracyAllSelected}
                  onToggle={(m) =>
                    setAccuracyMode(
                      toggleMode(effectiveAccuracyMode, availableAccuracyModes, m),
                    )
                  }
                  onAll={() => setAccuracyMode(accuracyAllSelected ? [] : null)}
                />
              )}
              <RangePicker value={accuracyRange} onChange={setAccuracyRange} />
            </div>
          </div>
          {accuracy.length === 0 ? (
            <EmptyChart
              text={
                accuracyAllNoFilter.length === 0
                  ? t('charts.empty.accuracyWaiting')
                  : !accuracyAllSelected
                    ? t('charts.empty.accuracyNoMode')
                    : t('charts.empty.accuracyNoRange')
              }
            />
          ) : (
            <div className="w-full h-56">
              <ResponsiveContainer>
                <LineChart
                  data={accuracy}
                  margin={{ left: 0, right: 8, top: 8, bottom: 0 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke={GRID_COLOR} />
                  <XAxis
                    dataKey="t"
                    type="number"
                    domain={['dataMin', 'dataMax']}
                    tickFormatter={(t) => fmtDate(Number(t))}
                    stroke={AXIS_COLOR}
                    fontSize={10}
                  />
                  <YAxis
                    stroke={AXIS_COLOR}
                    width={38}
                    fontSize={10}
                    domain={[30, 100]}
                    tickFormatter={(v) => `${v}%`}
                  />
                  <Tooltip
                    contentStyle={TOOLTIP_STYLE}
                    labelFormatter={(t) => fmtDate(Number(t))}
                    formatter={(val: number, name: string) => [
                      `${val?.toFixed?.(1) ?? val}%`,
                      name === 'rolling'
                        ? t('charts.tooltipRollingAvg')
                        : t('charts.tooltipPerGame'),
                    ]}
                  />
                  <Line
                    type="monotone"
                    dataKey="accuracy"
                    stroke="#7aa2f7"
                    strokeOpacity={0.35}
                    dot={{ r: 2 }}
                    connectNulls
                  />
                  <Line
                    type="monotone"
                    dataKey="rolling"
                    stroke="#26c2a3"
                    strokeWidth={2}
                    dot={false}
                    connectNulls
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
      </div>

      <div className="card p-3">
        <div className="flex flex-wrap items-center justify-between mb-2 gap-2">
          <div className="text-xs uppercase tracking-wide text-text-muted">
            {t('charts.openingsTitle')}
          </div>
          {availableOpeningModes.length > 1 && (
            <ModePicker
              selection={effectiveOpeningMode}
              modes={availableOpeningModes}
              allActive={openingAllSelected}
              onToggle={(m) =>
                setOpeningMode(
                  toggleMode(effectiveOpeningMode, availableOpeningModes, m),
                )
              }
              onAll={() => setOpeningMode(openingAllSelected ? [] : null)}
            />
          )}
        </div>
        {openings.length === 0 ? (
          <EmptyChart
            text={
              !openingAllSelected
                ? t('charts.empty.openingsNoMode')
                : t('charts.empty.openingsEmpty')
            }
          />
        ) : (
          <OpeningWinRateList openings={openings} />
        )}
      </div>

      {/* Which of those openings you should actually go and study. Renders
          nothing when there is no gap to report, so it can't push the
          section around on a thin library. Unfiltered by the opening
          mode-picker on purpose: a prep gap is a property of your
          repertoire, not of a time class. */}
      <PrepGapsCard games={games} />
    </section>
  );
}

/** Replacement for the old recharts horizontal bar chart. We render our
 *  own list because recharts' YAxis category labels truncate awkwardly
 *  and there's no clean way to wrap or expand them — opening family
 *  names like "Queen's Pawn Game: Symmetrical Variation" got cut to
 *  "Queen's Pawn Ga…" before. Here each row gets the full row width for
 *  the name, a coloured bar, the percentage, and W/D/L breakdown. */
function OpeningWinRateList({
  openings,
}: {
  openings: ReturnType<typeof winRateByOpening>;
}) {
  const { t } = useTranslation();
  // Family-bound repertoires the user already owns. When a chart row
  // matches one, the link goes to `/repertoire` (flash-highlighting that
  // card) instead of the library — the user's own prep is the more
  // useful destination than the generic line list. Keyed by the
  // library's *canonical* family name so lookups can go through
  // `resolveOpeningFamily`.
  const repIdByFamily = useLiveQuery(async () => {
    const reps = await db.repertoires.toArray();
    const map = new Map<string, string>();
    for (const r of reps) {
      if (r.kind !== 'family' || !r.family) continue;
      const canonical = resolveOpeningFamily(r.family);
      if (canonical && !map.has(canonical)) map.set(canonical, r.id);
    }
    return map;
  }, []);

  // Rows whose name the library doesn't recognise get a second chance from
  // their moves. The two datasets disagree on names as well as punctuation —
  // Chess.com's "King's Fianchetto Opening" is the bundled data's "Hungarian
  // Opening", sharing no prefix — and such a row used to render with no link at
  // all, which reads as "this opening isn't in the library" when it is.
  //
  // Only the failures get here, so this reads at most a handful of PGNs, and it
  // fixes every naming divergence rather than the ones an alias table happened
  // to list.
  const unresolved = useMemo(
    () =>
      openings
        .filter((o) => !resolveOpeningFamily(o.family) && o.sampleGameId)
        .map((o) => ({ family: o.family, sampleGameId: o.sampleGameId! })),
    [openings],
  );
  const byMovesKey = unresolved.map((u) => u.family).join('|');
  const familyByMoves = useLiveQuery(
    () => familiesFromGameMoves(unresolved),
    [byMovesKey],
  );

  return (
    <ul className="space-y-2">
      {openings.map((o) => {
        const pct = Math.round(o.winRate * 100);
        const color =
          o.winRate >= 0.55
            ? '#7bc47f'
            : o.winRate >= 0.45
              ? '#f0c36d'
              : '#e06c75';
        // Chart rows carry the game-derived spelling ("Caro Kann
        // Defense"); the library and repertoires use the canonical one
        // ("Caro-Kann Defense"). Always link with the canonical name.
        const canonical =
          resolveOpeningFamily(o.family) ?? familyByMoves?.get(o.family) ?? null;
        const repId = canonical ? repIdByFamily?.get(canonical) : undefined;
        const target = repId
          ? `/repertoire?highlight=${encodeURIComponent(repId)}`
          : canonical
            ? `/openings?family=${encodeURIComponent(canonical)}`
            : null;
        const linkLabel = repId
          ? t('charts.openInRepertoire')
          : t('charts.openInLibrary');
        const linkTitle = repId
          ? t('charts.openInRepertoireTitle', { family: canonical })
          : t('charts.openInLibraryTitle', { family: canonical });
        return (
          <li
            key={o.family}
            className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 items-center"
            title={t('charts.openingTooltip', {
              family: o.family,
              wins: o.wins,
              draws: o.draws,
              losses: o.losses,
              games: o.games,
            })}
          >
            <div className="min-w-0 flex items-center gap-2">
              <span className="text-sm truncate">{o.family}</span>
              {target && (
                <Link
                  to={target}
                  className="shrink-0 inline-flex items-center gap-1 rounded-md border border-border/80 bg-bg-raised/60 px-1.5 py-0.5 text-[11px] text-accent hover:border-accent/50 hover:bg-accent/10 transition-colors"
                  title={linkTitle}
                  aria-label={linkTitle}
                >
                  {linkLabel}
                  <span aria-hidden className="opacity-70">
                    →
                  </span>
                </Link>
              )}
            </div>
            <span className="text-xs text-text-muted font-mono whitespace-nowrap">
              {t('charts.openingRow', {
                wins: o.wins,
                draws: o.draws,
                losses: o.losses,
                games: o.games,
              })}
            </span>
            <div className="col-span-2 flex items-center gap-2">
              <div className="flex-1 h-2 rounded-full bg-bg-raised overflow-hidden">
                <div
                  className="h-full rounded-full transition-all"
                  style={{
                    width: `${Math.max(2, pct)}%`,
                    background: color,
                  }}
                />
              </div>
              <span
                className="text-xs font-mono tabular-nums w-12 text-right"
                style={{ color }}
              >
                {pct}%
              </span>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** Pill-style segmented control for picking a time window. Uses the
 *  same compact button styles as the color filter elsewhere so the
 *  dashboard feels consistent. */
function RangePicker({
  value,
  onChange,
}: {
  value: RangeKey;
  onChange: (next: RangeKey) => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      className="flex gap-0.5 text-[11px] rounded-md border border-border bg-bg-raised/40 p-0.5"
      role="tablist"
      aria-label={t('charts.ariaTimeRange')}
    >
      {RANGE_OPTIONS.map((o) => {
        const active = o.key === value;
        return (
          <button
            key={o.key}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(o.key)}
            className={`px-2 py-0.5 rounded transition-colors ${
              active
                ? 'bg-accent/20 text-accent'
                : 'text-text-muted hover:text-text'
            }`}
          >
            {t(`charts.ranges.${o.key}`)}
          </button>
        );
      })}
    </div>
  );
}

/** Multi-select chip bar for picking which Chess.com time classes to
 *  include in the chart. Visual contract:
 *
 *   - Every available chip starts active (the "all-blue at start" the
 *     user asked for). Clicking a chip toggles it off; clicking again
 *     toggles it back on.
 *   - The leading "All" chip is active when every available class is
 *     active. Clicking it from a partial state restores the full set.
 *   - The selection lives in the parent (`null` = full set). Empty
 *     subsets are allowed and produce an empty chart, matching what
 *     the user just asked for. */
function ModePicker({
  selection,
  modes,
  allActive,
  onToggle,
  onAll,
}: {
  selection: ModeSelection;
  modes: string[];
  allActive: boolean;
  onToggle: (mode: string) => void;
  onAll: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      className="flex gap-0.5 text-[11px] rounded-md border border-border bg-bg-raised/40 p-0.5"
      role="group"
      aria-label={t('charts.ariaTimeClass')}
    >
      <button
        key="all"
        type="button"
        aria-pressed={allActive}
        onClick={onAll}
        className={`flex items-center gap-1 px-2 py-0.5 rounded transition-colors ${
          allActive ? 'bg-accent/20 text-accent' : 'text-text-muted hover:text-text'
        }`}
      >
        {t('charts.modes.all')}
      </button>
      {modes.map((m) => {
        const active = selectionIncludes(selection, modes, m);
        const dotColor = TIME_CLASS_COLOR[m] ?? AXIS_COLOR;
        return (
          <button
            key={m}
            type="button"
            aria-pressed={active}
            onClick={() => onToggle(m)}
            className={`flex items-center gap-1 px-2 py-0.5 rounded transition-colors ${
              active
                ? 'bg-accent/20 text-accent'
                : 'text-text-muted hover:text-text'
            }`}
          >
            <span
              aria-hidden
              className="inline-block w-1.5 h-1.5 rounded-full"
              style={{
                background: active ? dotColor : 'transparent',
                outline: `1px solid ${dotColor}`,
                outlineOffset: '-1px',
              }}
            />
            {modeLabel(t, m)}
          </button>
        );
      })}
    </div>
  );
}

function EmptyChart({ text }: { text: string }) {
  return (
    <div className="h-40 flex items-center justify-center text-text-muted text-sm">
      {text}
    </div>
  );
}
