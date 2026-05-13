import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, type Repertoire } from '@/db/schema';
import {
  enumerateLines,
  getLineStatsMap,
  lineKey,
  type RepertoireLine,
} from './store';
import type { RepertoireLineStats } from '@/db/schema';
import { identifyOpening } from '@/features/openings/library';
import { LineRunner, type LineRunnerControlState } from './LineRunner';
import {
  initSession,
  reduceSession,
  type PracticeMode,
  type PracticeSessionState,
  type SessionEvent,
} from './practiceMode';
import { tPracticeMode, tPracticeModeDescription } from '@/i18n/chess';

interface DecoratedLine {
  line: RepertoireLine;
  family: string;
  variation: string;
  eco: string;
  searchHaystack: string;
}

function decorate(lines: RepertoireLine[]): DecoratedLine[] {
  return lines.map((line) => {
    const m = identifyOpening(line.uci);
    const family = m?.family ?? 'Unidentified';
    const variation = m?.variation ?? '';
    const eco = m?.eco ?? '';
    // Lowercased haystack joining everything we want the search box to
    // hit: opening family, variation, ECO, and the line's joined SAN.
    // Cheap because lines per family are typically <50 — full-text
    // indexing would be overkill.
    const searchHaystack = [family, variation, eco, line.san.join(' ')]
      .join(' ')
      .toLowerCase();
    return { line, family, variation, eco, searchHaystack };
  });
}

interface FamilyAggregate {
  family: string;
  indices: number[];
  totalLines: number;
  attempts: number;
  completions: number;
  perfectCompletions: number;
  movesPlayed: number;
  correctMoves: number;
  wrongMoves: number;
}

/**
 * Roll persisted per-line stats up to family-level. Ported from the
 * legacy `/repertoire/:id/lines` page (`RepertoireLineTrainer`'s
 * `aggregateFamilyStats`) so the family-aggregate view doesn't go
 * away with that page. Pure over `(decoratedLines, statsMap)`.
 */
function aggregateByFamily(
  decoratedLines: DecoratedLine[],
  stats: Map<string, RepertoireLineStats> | null | undefined,
): FamilyAggregate[] {
  const byFamily = new Map<string, FamilyAggregate>();
  decoratedLines.forEach((d, idx) => {
    let agg = byFamily.get(d.family);
    if (!agg) {
      agg = {
        family: d.family,
        indices: [],
        totalLines: 0,
        attempts: 0,
        completions: 0,
        perfectCompletions: 0,
        movesPlayed: 0,
        correctMoves: 0,
        wrongMoves: 0,
      };
      byFamily.set(d.family, agg);
    }
    agg.indices.push(idx);
    agg.totalLines += 1;
    const s = stats?.get(lineKey(d.line.uci));
    if (s) {
      agg.attempts += s.attempts;
      agg.completions += s.completions;
      agg.perfectCompletions += s.perfectCompletions;
      agg.movesPlayed += s.movesPlayed;
      agg.correctMoves += s.correctMoves;
      agg.wrongMoves += s.wrongMoves;
    }
  });
  // Stable order: alphabetical by family, "Unidentified" pushed last.
  // Same convention as the legacy page so users coming from there
  // don't experience a re-shuffle.
  return Array.from(byFamily.values()).sort((a, b) => {
    if (a.family === 'Unidentified' && b.family !== 'Unidentified') return 1;
    if (b.family === 'Unidentified' && a.family !== 'Unidentified') return -1;
    return a.family.localeCompare(b.family);
  });
}

function familyAccuracyPct(agg: FamilyAggregate): number | null {
  if (agg.movesPlayed === 0) return null;
  return agg.correctMoves / agg.movesPlayed;
}

/**
 * Practice the lines of a repertoire. Three modes (Sequential / Random
 * / Repeat-until-perfect), all driven by the pure reducer in
 * `./practiceMode.ts`. The page is reachable from the repertoire list
 * card's primary "Practice" button (`/practice?rep=<id>`); navigating
 * to bare `/practice` shows a chooser.
 *
 * Layout:
 *   - Top: header with rep name + mode picker.
 *   - Left column: live LineRunner for the active line (key=lineKey to
 *     force a fresh runner per line). Below it, the runner's status bar
 *     and the "session crossed-off" counter (repeat mode only).
 *   - Right column: filtered+selectable line picker with search box
 *     and select-all/none toggles. Picker is hidden on small screens
 *     behind a "Pick lines" sheet (TODO: not yet wired; on phones we
 *     stack vertically).
 *
 * Why use a render-prop on the runner: the controls bar needs access
 * to the runner's *live* status (is the user mid-line? did they just
 * finish? did they get it right?), and lifting that state up into the
 * page would force the runner to expose a heavy state-observer. The
 * existing `renderControls` slot already gives us the live state so
 * the practice-mode controls can render below the board with the
 * exact same data the runner has.
 */
export function PracticePage() {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const repId = params.get('rep') ?? '';
  const reps = useLiveQuery(
    () => db.repertoires.orderBy('updatedAt').reverse().toArray(),
    [],
  );

  // No repertoire chosen: show a list to pick from. Skips the `?rep=`
  // path so the user always lands somewhere meaningful.
  if (!repId) {
    return <RepertoireChooser reps={reps} />;
  }

  const rep = reps?.find((r) => r.id === repId);
  if (reps !== undefined && !rep) {
    return (
      <div className="card p-6 text-center text-text-muted space-y-2">
        <div>{t('practice.notFound')}</div>
        <Link to="/repertoire" className="text-accent hover:underline">
          {t('practice.backToRepertoires')}
        </Link>
      </div>
    );
  }
  if (!rep) {
    return <div className="text-text-muted">{t('practice.loading')}</div>;
  }

  return <PracticeRunner rep={rep} />;
}

function RepertoireChooser({
  reps,
}: {
  reps: Repertoire[] | undefined;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-3">
      <h1 className="text-2xl font-semibold tracking-tight">{t('practice.title')}</h1>
      <p className="text-sm text-text-muted">{t('practice.subtitle')}</p>
      {!reps ? (
        <div className="card p-6 text-center text-text-muted">{t('practice.loading')}</div>
      ) : reps.length === 0 ? (
        <div className="card p-6 text-center text-text-muted space-y-2">
          <div>{t('practice.noRepertoires')}</div>
          <Link to="/openings" className="text-accent hover:underline">
            {t('practice.browseOpenings')}
          </Link>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {reps.map((r) => (
            <Link
              key={r.id}
              to={`/practice?rep=${encodeURIComponent(r.id)}`}
              className="card p-4 hover:border-accent transition-colors"
            >
              <div className="flex items-baseline justify-between gap-2">
                <div className="font-medium truncate">{r.name}</div>
                <span
                  className={`text-xs px-2 py-0.5 rounded shrink-0 ${r.color === 'white' ? 'bg-bg-raised text-text' : 'bg-text/90 text-bg'}`}
                >
                  {r.color === 'white' ? t('common.white') : t('common.black')}
                </span>
              </div>
              <div className="text-xs text-text-muted mt-1">
                {t('practice.updated', { date: new Date(r.updatedAt).toLocaleDateString() })}
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

function PracticeRunner({
  rep,
}: {
  rep: Repertoire;
}) {
  const { t } = useTranslation();
  // We deliberately use plain useEffect + useState rather than
  // useLiveQuery for `lines`. enumerateLines is a one-shot async, the
  // user isn't editing the tree on this page, and a Dexie subscription
  // would re-fire the (potentially expensive) line enumeration every
  // time *any* repertoire row changes — wasteful for a page that's
  // really an in-memory drill loop.
  const [lines, setLines] = useState<RepertoireLine[] | null>(null);
  const [statsBucket, setStatsBucket] = useState<number>(0);
  // Re-fetch lines when the repertoire id changes *or* when an
  // outside hand (e.g. import) bumps the rep's updatedAt.
  useEffect(() => {
    let cancelled = false;
    setLines(null);
    void enumerateLines(rep.id).then((res) => {
      if (!cancelled) setLines(res);
    });
    return () => {
      cancelled = true;
    };
  }, [rep.id, rep.updatedAt]);

  // Persisted stats per-line key so the picker can show "✓ done X
  // perfect times" annotations. Cheap to fetch eagerly on mount.
  const stats = useLiveQuery(async () => {
    if (!lines) return null;
    return getLineStatsMap(rep.id);
  }, [rep.id, lines, statsBucket]);

  if (!lines) {
    return (
      <div className="card p-6 text-center text-text-muted">
        {t('practice.loadingLines')}
      </div>
    );
  }

  if (lines.length === 0) {
    return (
      <div className="card p-6 text-center text-text-muted space-y-2">
        <div>{t('practice.noLines')}</div>
        <p className="text-xs">
          {t('practice.openLibrary1')}
          <Link to="/openings" className="text-accent hover:underline">
            {t('practice.openLibrary2')}
          </Link>
          {t('practice.openLibrary3')}
        </p>
      </div>
    );
  }

  return (
    <ActivePractice
      rep={rep}
      decoratedLines={decorate(lines)}
      stats={stats}
      onStatsChanged={() => setStatsBucket((n) => n + 1)}
    />
  );
}

function ActivePractice({
  rep,
  decoratedLines,
  stats,
  onStatsChanged,
}: {
  rep: Repertoire;
  decoratedLines: DecoratedLine[];
  stats: Awaited<ReturnType<typeof getLineStatsMap>> | null | undefined;
  onStatsChanged: () => void;
}) {
  const { t } = useTranslation();
  // Selection state. Default = "everything selected" — that's the
  // friendliest default per the user's "select one, many, or all"
  // requirement: zero clicks gets you "all".
  const [selected, setSelected] = useState<Set<number>>(
    () => new Set(decoratedLines.map((_, i) => i)),
  );
  // When the rep changes, reset the selection to all-selected. The
  // PracticePage's outer key-based remount also handles this, but
  // belt-and-suspenders: if the parent ever re-uses this component
  // for a different rep, we start fresh.
  // (Practical note: PracticePage doesn't reuse, but keeping this
  // resilient costs nothing.)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => setSelected(new Set(decoratedLines.map((_, i) => i))), [rep.id]);

  // Search query for the line picker. Lowercased once for matching.
  const [query, setQuery] = useState('');
  const queryLower = query.trim().toLowerCase();
  const filteredIndices = useMemo(() => {
    if (queryLower.length === 0) {
      return decoratedLines.map((_, i) => i);
    }
    return decoratedLines
      .map((d, i) => ({ d, i }))
      .filter(({ d }) => d.searchHaystack.includes(queryLower))
      .map(({ i }) => i);
  }, [decoratedLines, queryLower]);

  // Practice session reducer. We re-init when the selection or mode
  // changes via dispatch, NOT by reseeding (that would lose
  // sessionPlays / perfectThisSession). The selection wired into the
  // reducer is `selected`, sorted; the reducer dedupes anyway.
  const [session, dispatch] = useReducer(
    (s: PracticeSessionState, e: SessionEvent) => reduceSession(s, e),
    null,
    () =>
      initSession({
        mode: 'sequential',
        selectedIndices: Array.from(selected),
      }),
  );

  // Sync the reducer's `selectedIndices` with the local `selected` set.
  // Whenever the user toggles chips, we ship a `changeSelection` event
  // so the reducer's pickNext logic respects the new set.
  const lastSelectedRef = useRef<string>('');
  useEffect(() => {
    const key = Array.from(selected).sort((a, b) => a - b).join(',');
    if (key === lastSelectedRef.current) return;
    lastSelectedRef.current = key;
    dispatch({
      type: 'changeSelection',
      selectedIndices: Array.from(selected),
    });
  }, [selected]);

  function setMode(mode: PracticeMode) {
    dispatch({ type: 'changeMode', mode });
  }

  function toggleLine(i: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  }

  function selectAll() {
    setSelected(new Set(decoratedLines.map((_, i) => i)));
  }
  function selectNone() {
    setSelected(new Set());
  }
  function selectFiltered() {
    setSelected(new Set(filteredIndices));
  }

  const currentLine =
    session.currentIndex != null
      ? decoratedLines[session.currentIndex]
      : null;
  const sessionDoneInRepeat =
    session.mode === 'repeat-until-perfect' &&
    session.currentIndex == null &&
    session.selectedIndices.length > 0;

  const handleLineFinished = useCallback(
    ({ perfect }: { perfect: boolean }) => {
      // The runner reports completion via this hook; we feed the
      // reducer so the next line is queued per the active mode.
      // We schedule a small delay so the user can see the "line
      // complete" status before the runner remounts on the next line.
      window.setTimeout(() => {
        dispatch({ type: 'finished', perfect });
      }, 800);
    },
    [],
  );
  return (
    <div className="space-y-4">
      <header className="flex items-baseline justify-between flex-wrap gap-2">
        <div className="space-y-0.5">
          <div className="text-xs uppercase tracking-wide text-text-muted">
            {t('practice.header')}
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">{rep.name}</h1>
          <p className="text-xs text-text-muted">
            {t('practice.linesSelected', {
              count: decoratedLines.length,
              total: decoratedLines.length,
              selected: selected.size,
              color: rep.color === 'white' ? t('common.white') : t('common.black'),
            })}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link to="/repertoire" className="btn text-xs">
            {t('practice.allRepertoires')}
          </Link>
        </div>
      </header>

      <ModePicker mode={session.mode} onChange={setMode} />

      {/* Always render the runner+picker grid so the picker stays
          visible even when the user has temporarily de-selected every
          line (e.g. clicked "Select none"). The runner column swaps
          its content based on session state, but the right-hand
          picker is permanent so the user can re-select without having
          to navigate away and back. */}
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_360px] gap-4 items-start">
        <div className="space-y-3">
          {selected.size === 0 ? (
            <div className="card p-6 text-center text-text-muted space-y-2">
              <div>{t('practice.noLinesSelected')}</div>
              <p className="text-xs">{t('practice.noLinesSelectedHelp')}</p>
            </div>
          ) : sessionDoneInRepeat ? (
            <div className="card p-6 text-center space-y-3">
              <div className="text-good font-medium">{t('practice.everyPerfect')}</div>
              <p className="text-xs text-text-muted">{t('practice.keepGoing')}</p>
              <div className="flex justify-center gap-2">
                <button
                  type="button"
                  className="btn-primary text-xs"
                  onClick={() => setMode('repeat-until-perfect')}
                >
                  {t('practice.restart')}
                </button>
                <button
                  type="button"
                  className="btn text-xs"
                  onClick={() => setMode('sequential')}
                >
                  {t('practice.switchSequential')}
                </button>
              </div>
            </div>
          ) : (
            currentLine && (
              <LineRunner
                key={`${rep.id}-${lineKey(currentLine.line.uci)}`}
                repertoireId={rep.id}
                line={currentLine.line}
                userColor={rep.color}
                onLineFinished={handleLineFinished}
                onStatsChanged={onStatsChanged}
                renderControls={(c) => (
                  <PracticeStatusBar
                    control={c}
                    decorated={currentLine}
                    userColor={rep.color}
                    sessionPlays={session.sessionPlays}
                    onSkip={() => dispatch({ type: 'skip' })}
                  />
                )}
              />
            )
          )}
        </div>

        <aside className="space-y-3">
          <SessionSummary
            session={session}
            totalLines={decoratedLines.length}
          />
          <FamilyStats
            decoratedLines={decoratedLines}
            stats={stats ?? null}
            selected={selected}
            onSelectFamily={(indices) => setSelected(new Set(indices))}
          />
          <LinePicker
            decoratedLines={decoratedLines}
            filteredIndices={filteredIndices}
            selected={selected}
            currentIndex={session.currentIndex}
            perfectThisSession={session.perfectThisSession}
            stats={stats ?? null}
            query={query}
            onQuery={setQuery}
            onToggle={toggleLine}
            onSelectAll={selectAll}
            onSelectNone={selectNone}
            onSelectFiltered={selectFiltered}
            onJumpTo={(i) => dispatch({ type: 'jumpTo', index: i })}
          />
        </aside>
      </div>
    </div>
  );
}

function ModePicker({
  mode,
  onChange,
}: {
  mode: PracticeMode;
  onChange: (m: PracticeMode) => void;
}) {
  const { t } = useTranslation();
  const modes: PracticeMode[] = [
    'sequential',
    'random',
    'repeat-until-perfect',
  ];
  return (
    <div className="card p-3 space-y-2">
      <div className="text-xs uppercase tracking-wide text-text-muted">{t('practice.mode')}</div>
      <div className="flex flex-wrap gap-2">
        {modes.map((m) => {
          const active = mode === m;
          return (
            <button
              key={m}
              type="button"
              className={`text-xs px-3 py-1.5 rounded-md border transition-colors ${
                active
                  ? 'bg-accent text-white border-accent'
                  : 'border-border hover:border-accent'
              }`}
              onClick={() => onChange(m)}
              aria-pressed={active}
            >
              {tPracticeMode(t, m)}
            </button>
          );
        })}
      </div>
      <p className="text-xs text-text-muted leading-relaxed">
        {tPracticeModeDescription(t, mode)}
      </p>
    </div>
  );
}

function PracticeStatusBar({
  control,
  decorated,
  userColor,
  sessionPlays,
  onSkip,
}: {
  control: LineRunnerControlState;
  decorated: DecoratedLine;
  userColor: 'white' | 'black';
  sessionPlays: number;
  onSkip: () => void;
}) {
  const { t } = useTranslation();
  const {
    status,
    isUserTurn,
    ply,
    totalPly,
    expectedSan,
    hintShown,
    revealShown,
    mistakeMade,
    wrongFlash,
    sessionStats,
    onHint,
    onReveal,
    onPlayReveal,
    onRestart,
  } = control;
  // After the first wrong attempt on this line, surface Hint +
  // Show-answer permanently for the rest of the line. Pre-mistake we
  // keep the action row lean (Hint only, like the puzzles flow).
  const showHintButton = isUserTurn && status === 'thinking' && !hintShown;
  const showRevealButton =
    isUserTurn && status === 'thinking' && mistakeMade && !revealShown;
  const showPlayItButton = revealShown && isUserTurn && status === 'thinking';
  return (
    <div className="card p-3 space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <div className="text-xs uppercase tracking-wide text-text-muted">
          {decorated.family}
          {decorated.variation && (
            <span className="ml-2 text-text">{decorated.variation}</span>
          )}
        </div>
        <div className="text-xs text-text-muted">
          {t('practice.statusbar.ply', { ply, total: totalPly, wrong: sessionStats.wrong, play: sessionPlays + 1 })}
        </div>
      </div>
      <div className="text-sm min-h-[1.5rem]">
        {status === 'done' ? (
          <span className="text-good">{t('practice.lineComplete')}</span>
        ) : !isUserTurn ? (
          <span className="text-text-muted">
            {t('practice.opponentMoves', { color: userColor === 'white' ? t('common.black') : t('common.white') })}
          </span>
        ) : status === 'thinking' ? (
          <>
            {wrongFlash ? (
              <span className="text-blunder">{t('practice.notYourPrep')}</span>
            ) : (
              <span className="text-text-muted">
                {ply === 0
                  ? t('practice.playYourPrep', { color: userColor === 'white' ? t('common.white') : t('common.black') })
                  : t('practice.yourMove', { move: `${Math.floor(ply / 2) + 1}${ply % 2 === 0 ? '.' : '…'}` })}
              </span>
            )}
            {revealShown && expectedSan && (
              <span className="ml-2 text-text-muted">
                {t('practice.lineGoes')}<span className="font-mono text-good">{expectedSan}</span>{t('practice.lineGoesPeriod')}
              </span>
            )}
            {hintShown && !revealShown && expectedSan && (
              <span className="ml-2 text-accent">
                · {t('repertoire.trainer.hint').replace(/^· /, '')}
              </span>
            )}
          </>
        ) : (
          <span className="text-good">
            {expectedSan && (
              <>
                <span className="font-mono">{expectedSan}</span> — {t('common.correct')}.
              </>
            )}
          </span>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        {showHintButton && (
          <button type="button" className="btn text-xs" onClick={onHint}>
            {t('practice.hint')}
          </button>
        )}
        {showRevealButton && (
          <button type="button" className="btn text-xs" onClick={onReveal}>
            {t('practice.showAnswer')}
          </button>
        )}
        {showPlayItButton && (
          <button type="button" className="btn text-xs" onClick={onPlayReveal}>
            {t('practice.playItForMe')}
          </button>
        )}
        <div className="ml-auto flex flex-wrap gap-2">
          <button type="button" className="btn text-xs" onClick={onRestart}>
            {t('practice.restartLine')}
          </button>
          <button type="button" className="btn text-xs" onClick={onSkip}>
            {t('practice.skip')}
          </button>
        </div>
      </div>
    </div>
  );
}

function SessionSummary({
  session,
  totalLines,
}: {
  session: PracticeSessionState;
  totalLines: number;
}) {
  const { t } = useTranslation();
  if (session.mode === 'repeat-until-perfect') {
    const perfect = session.perfectThisSession.length;
    const target = session.selectedIndices.length;
    const remaining = Math.max(0, target - perfect);
    const pct = target === 0 ? 0 : Math.round((perfect / target) * 100);
    return (
      <div className="card p-3 space-y-1.5">
        <div className="text-xs uppercase tracking-wide text-text-muted">
          {t('practice.session.repeatTitle')}
        </div>
        <div className="text-sm">
          {t('practice.session.crossedOff', { perfect, target })}
          {remaining > 0 && (
            <>
              {' \u00b7 '}
              <span className="text-text-muted">{t('practice.session.toGo', { count: remaining })}</span>
            </>
          )}
        </div>
        <div className="h-2 rounded-full bg-bg-raised overflow-hidden">
          <div
            className="h-full bg-good transition-[width]"
            style={{ width: `${pct}%` }}
          />
        </div>
        <div className="text-xs text-text-muted">
          {t('practice.session.playsThisSession', { count: session.sessionPlays })}
        </div>
      </div>
    );
  }
  return (
    <div className="card p-3 space-y-1">
      <div className="text-xs uppercase tracking-wide text-text-muted">
        {t('practice.session.thisSession')}
      </div>
      <div className="text-sm">
        {t('practice.session.linesPlayed', { count: session.sessionPlays })}
      </div>
      <div className="text-xs text-text-muted">
        {t('practice.session.modeFooter', { selected: session.selectedIndices.length, total: totalLines, mode: tPracticeMode(t, session.mode) })}
      </div>
    </div>
  );
}

/**
 * Family-aggregate stats panel. Ported from the legacy
 * `/repertoire/:id/lines` page (`FamilyPickerView`) when that page was
 * removed in favour of the unified Practice flow. Collapsed by default
 * so it doesn't clutter the picker; clicking a family row narrows the
 * selection to just that family's lines so the user can drill into a
 * specific opening from here.
 */
function FamilyStats({
  decoratedLines,
  stats,
  selected,
  onSelectFamily,
}: {
  decoratedLines: DecoratedLine[];
  stats: Map<string, RepertoireLineStats> | null;
  selected: Set<number>;
  onSelectFamily: (indices: number[]) => void;
}) {
  const { t } = useTranslation();
  const aggregates = useMemo(
    () => aggregateByFamily(decoratedLines, stats),
    [decoratedLines, stats],
  );
  // Collapsed by default. The picker below is the primary surface;
  // family-level stats are a secondary "where am I weakest?" view.
  const [open, setOpen] = useState(false);
  // Only render the panel if there's meaningful aggregate data —
  // either >1 family, or any persisted attempts on the single family.
  // A brand-new repertoire with one family and zero plays would just
  // show "0 / 0 / 0%" which is noise.
  const hasAnyAttempts = aggregates.some((a) => a.attempts > 0);
  if (aggregates.length <= 1 && !hasAnyAttempts) return null;
  return (
    <div className="card p-3 space-y-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between gap-2 text-left"
        aria-expanded={open}
      >
        <span className="text-xs uppercase tracking-wide text-text-muted">
          {t('practice.familyStats.title')}
        </span>
        <span className="text-xs text-text-muted">
          {t('practice.familyStats.families', { count: aggregates.length })}
          {' \u00b7 '}
          {open ? t('practice.familyStats.hide') : t('practice.familyStats.show')}
        </span>
      </button>
      {open && (
        <ul className="space-y-1.5">
          {aggregates.map((agg) => {
            const acc = familyAccuracyPct(agg);
            const allSelected = agg.indices.every((i) => selected.has(i));
            return (
              <li key={agg.family} className="space-y-0.5">
                <div className="flex items-baseline justify-between gap-2">
                  <div className="text-sm font-medium truncate">
                    {agg.family}
                  </div>
                  <button
                    type="button"
                    className="text-[11px] text-accent hover:underline shrink-0"
                    onClick={() => onSelectFamily(agg.indices)}
                    title={
                      allSelected
                        ? t('practice.familyStats.alreadyOnly')
                        : t('practice.familyStats.drillOnlyTitle', { family: agg.family })
                    }
                    disabled={allSelected && selected.size === agg.indices.length}
                  >
                    {t('practice.familyStats.drillOnly')}
                  </button>
                </div>
                <div className="flex flex-wrap gap-x-3 gap-y-0 text-[11px] text-text-muted">
                  <span>
                    {t('practice.familyStats.lines', { count: agg.totalLines })}
                  </span>
                  {agg.attempts > 0 ? (
                    <>
                      <span>
                        {t('practice.familyStats.attempts', { count: agg.attempts })}
                      </span>
                      <span>
                        {t('practice.familyStats.done', { count: agg.completions })}
                        {agg.perfectCompletions > 0 && (
                          <span className="text-good">
                            {' '}{t('practice.familyStats.perfect', { count: agg.perfectCompletions })}
                          </span>
                        )}
                      </span>
                      {acc !== null && (
                        <span
                          className={
                            acc >= 0.9
                              ? 'text-good'
                              : acc < 0.6
                                ? 'text-blunder'
                                : ''
                          }
                        >
                          {t('practice.familyStats.acc', { pct: (acc * 100).toFixed(0) })}
                        </span>
                      )}
                    </>
                  ) : (
                    <span className="italic">{t('practice.familyStats.notDrilled')}</span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function LinePicker({
  decoratedLines,
  filteredIndices,
  selected,
  currentIndex,
  perfectThisSession,
  stats,
  query,
  onQuery,
  onToggle,
  onSelectAll,
  onSelectNone,
  onSelectFiltered,
  onJumpTo,
}: {
  decoratedLines: DecoratedLine[];
  filteredIndices: number[];
  selected: Set<number>;
  currentIndex: number | null;
  perfectThisSession: number[];
  stats: Awaited<ReturnType<typeof getLineStatsMap>> | null;
  query: string;
  onQuery: (q: string) => void;
  onToggle: (i: number) => void;
  onSelectAll: () => void;
  onSelectNone: () => void;
  onSelectFiltered: () => void;
  onJumpTo: (i: number) => void;
}) {
  const { t } = useTranslation();
  // Group filtered indices by family for the picker layout. Group
  // order follows the family's first appearance in the underlying
  // line list (which is already family-sorted by enumerateLines), so
  // the section order is stable across renders.
  const groups = useMemo(() => {
    const map = new Map<string, number[]>();
    for (const i of filteredIndices) {
      const fam = decoratedLines[i].family;
      const arr = map.get(fam) ?? [];
      arr.push(i);
      map.set(fam, arr);
    }
    return Array.from(map.entries());
  }, [decoratedLines, filteredIndices]);

  return (
    <div className="card p-3 space-y-2">
      <div className="flex items-baseline justify-between">
        <div className="text-xs uppercase tracking-wide text-text-muted">
          {t('practice.linePicker.lines')}
        </div>
        <div className="text-[11px] text-text-muted">
          {t('practice.linePicker.selectedCount', { selected: selected.size, total: decoratedLines.length })}
        </div>
      </div>
      <input
        type="search"
        className="input text-sm"
        placeholder={t('practice.linePicker.searchPlaceholder')}
        value={query}
        onChange={(e) => onQuery(e.target.value)}
      />
      <div className="flex flex-wrap gap-2 text-xs">
        <button type="button" className="btn text-xs" onClick={onSelectAll}>
          {t('practice.linePicker.selectAll')}
        </button>
        <button type="button" className="btn text-xs" onClick={onSelectNone}>
          {t('practice.linePicker.selectNone')}
        </button>
        {query.trim().length > 0 && (
          <button type="button" className="btn text-xs" onClick={onSelectFiltered}>
            {t('practice.linePicker.selectFiltered', { count: filteredIndices.length })}
          </button>
        )}
      </div>
      <div className="max-h-[60vh] overflow-y-auto -mx-1 pr-1 divide-y divide-border">
        {groups.length === 0 ? (
          <div className="py-6 text-center text-xs text-text-muted">
            {t('practice.linePicker.noMatches', { query })}
          </div>
        ) : (
          groups.map(([family, indices]) => (
            <div key={family} className="py-2 first:pt-0 last:pb-0">
              <div className="text-[11px] uppercase tracking-wide text-text-muted px-1 py-0.5">
                {family}
              </div>
              <ul className="space-y-1">
                {indices.map((i) => {
                  const d = decoratedLines[i];
                  const id = `line-${i}`;
                  const isSelected = selected.has(i);
                  const isCurrent = i === currentIndex;
                  const isPerfectSession = perfectThisSession.includes(i);
                  const persisted = stats ? stats.get(lineKey(d.line.uci)) : null;
                  return (
                    <li
                      key={id}
                      className={`flex items-start gap-2 px-1 py-1 rounded ${
                        isCurrent ? 'bg-accent/15' : ''
                      }`}
                    >
                      <input
                        id={id}
                        type="checkbox"
                        className="mt-1 cursor-pointer"
                        checked={isSelected}
                        onChange={() => onToggle(i)}
                      />
                      <label htmlFor={id} className="flex-1 min-w-0 cursor-pointer">
                        <div className="text-sm truncate">
                          {d.eco && (
                            <span className="font-mono text-[11px] text-text-muted mr-2">
                              {d.eco}
                            </span>
                          )}
                          {d.variation || t('practice.linePicker.mainline')}
                          {isPerfectSession && (
                            <span className="ml-1 text-good" title={t('practice.linePicker.donePerfectThisSession')}>
                              ✓
                            </span>
                          )}
                        </div>
                        <div className="text-[11px] text-text-muted truncate font-mono">
                          {d.line.san.slice(0, 8).join(' ')}
                          {d.line.san.length > 8 && '…'}
                        </div>
                        {persisted && persisted.attempts > 0 && (
                          <div className="text-[10px] text-text-muted">
                            {t('practice.linePicker.doneCount', { count: persisted.completions })}
                            {persisted.perfectCompletions > 0 && (
                              <span className="text-good">
                                {' \u00b7 '}
                                {t('practice.linePicker.donePerfect', { count: persisted.perfectCompletions })}
                              </span>
                            )}
                          </div>
                        )}
                      </label>
                      <button
                        type="button"
                        className="text-[11px] text-accent hover:underline shrink-0"
                        onClick={() => onJumpTo(i)}
                        title={t('practice.linePicker.playTitle')}
                      >
                        {t('practice.linePicker.play')}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
