import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import { Link, Navigate, useParams, useSearchParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, getSettings, type Repertoire } from '@/db/schema';
import {
  enumerateLines,
  getLineStatsMap,
  lineKey,
  type RepertoireLine,
} from './store';
import type { RepertoireLineStats } from '@/db/schema';
import {
  addGuidedLinesToRepertoire,
  familyColor,
  getVariations,
  identifyOpening,
  setRepertoireLearningMode,
} from '@/features/openings/library';
import {
  buildPersonalOpeningStats,
  openingLineKey,
  rankOpeningLines,
  type RankedOpeningLine,
} from '@/features/openings/recommendations';
import { LineRunner, type LineRunnerControlState } from './LineRunner';
import { FreePlayRunner } from './FreePlayRunner';
import {
  FREE_PLAY_STRENGTHS,
  type FreePlayStrength,
} from '@/engine/freePlayEngine';
import {
  initSession,
  reduceSession,
  type PracticeMode,
  type PracticeSessionState,
  type SessionEvent,
} from './practiceMode';
import { tPracticeMode, tPracticeModeDescription } from '@/i18n/chess';
import { LineMoveTokens } from '@/components/LineMoveTokens';
import {
  areGuidedLinesMastered,
  guidedLineIndices,
  initialActiveLineKeys,
  nextRecommendedLines,
} from './curriculum';

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
 * Drill the lines of a repertoire. Three modes (Sequential / Random
 * / Repeat-until-perfect), all driven by the pure reducer in
 * `./practiceMode.ts`. Reached from the repertoire card's "Drill lines"
 * button at `/repertoire/:id/drill`. Legacy `/practice?rep=` links
 * redirect here via `PracticeRedirect`.
 */
export function PracticeRedirect() {
  const [params] = useSearchParams();
  const rep = params.get('rep');
  if (rep) {
    return <Navigate to={`/repertoire/${encodeURIComponent(rep)}/drill`} replace />;
  }
  return <Navigate to="/repertoire" replace />;
}

export function PracticePage() {
  const { t } = useTranslation();
  const { id: repId = '' } = useParams();
  const reps = useLiveQuery(
    () => db.repertoires.orderBy('updatedAt').reverse().toArray(),
    [],
  );

  if (!repId) {
    return <Navigate to="/repertoire" replace />;
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
  const games = useLiveQuery(() => db.games.toArray(), []);
  const rankedRecommendations = useMemo<RankedOpeningLine[]>(() => {
    if (!rep.family) return [];
    const personal = buildPersonalOpeningStats(
      games ?? [],
      familyColor(rep.family),
    );
    return rankOpeningLines(getVariations(rep.family), personal);
  }, [games, rep.family]);

  useEffect(() => {
    if (
      rep.learningMode != null ||
      !rep.family ||
      games === undefined ||
      rankedRecommendations.length === 0
    ) {
      return;
    }
    const activeLineKeys = initialActiveLineKeys(rankedRecommendations);
    void db.repertoires.update(rep.id, {
      learningMode: 'guided',
      activeLineKeys,
      updatedAt: Date.now(),
    });
  }, [games, rankedRecommendations, rep.family, rep.id, rep.learningMode]);
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
  const decorated = useMemo(() => decorate(lines ?? []), [lines]);

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
      decoratedLines={decorated}
      stats={stats}
      rankedRecommendations={rankedRecommendations}
      onStatsChanged={() => setStatsBucket((n) => n + 1)}
    />
  );
}

function ActivePractice({
  rep,
  decoratedLines,
  stats,
  rankedRecommendations,
  onStatsChanged,
}: {
  rep: Repertoire;
  decoratedLines: DecoratedLine[];
  stats: Awaited<ReturnType<typeof getLineStatsMap>> | null | undefined;
  rankedRecommendations: RankedOpeningLine[];
  onStatsChanged: () => void;
}) {
  const { t } = useTranslation();
  const decoratedRawLines = useMemo(
    () => decoratedLines.map((entry) => entry.line),
    [decoratedLines],
  );
  const fallbackActiveKeys = useMemo(
    () =>
      rankedRecommendations.length > 0
        ? initialActiveLineKeys(rankedRecommendations)
        : decoratedLines.slice(0, 5).map((entry) => openingLineKey(entry.line.uci)),
    [decoratedLines, rankedRecommendations],
  );
  const activeLineKeys =
    rep.activeLineKeys && rep.activeLineKeys.length > 0
      ? rep.activeLineKeys
      : fallbackActiveKeys;
  const guidedIndices = useMemo(
    () => guidedLineIndices(decoratedRawLines, activeLineKeys),
    [activeLineKeys, decoratedRawLines],
  );
  const initialGuided = rep.learningMode !== 'all';
  const [scope, setScope] = useState<'guided' | 'all'>(
    initialGuided ? 'guided' : 'all',
  );
  const [selected, setSelected] = useState<Set<number>>(
    () =>
      new Set(
        initialGuided
          ? guidedIndices
          : decoratedLines.map((_, index) => index),
      ),
  );
  const activeKeySignature = activeLineKeys.join('|');
  useEffect(() => {
    const nextScope = rep.learningMode === 'all' ? 'all' : 'guided';
    setScope(nextScope);
    setSelected(
      new Set(
        nextScope === 'guided'
          ? guidedIndices
          : decoratedLines.map((_, index) => index),
      ),
    );
    dispatch({
      type: 'changeMode',
      mode: nextScope === 'guided' ? 'repeat-until-perfect' : 'sequential',
    });
  }, [activeKeySignature, decoratedLines, guidedIndices, rep.id, rep.learningMode]);

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
        mode: initialGuided ? 'repeat-until-perfect' : 'sequential',
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

  async function changeScope(nextScope: 'guided' | 'all') {
    setScope(nextScope);
    if (nextScope === 'guided') {
      setSelected(new Set(guidedIndices));
      setMode('repeat-until-perfect');
    } else {
      setSelected(new Set(decoratedLines.map((_, index) => index)));
      setMode('sequential');
    }
    await setRepertoireLearningMode(rep.id, nextScope);
  }

  const usingRecommendedSet = scope !== 'all';

  const guidedMastered = areGuidedLinesMastered(
    decoratedRawLines,
    guidedIndices,
    stats ?? new Map(),
  );
  const nextLines = nextRecommendedLines(
    rankedRecommendations,
    activeLineKeys,
  );
  const [expanding, setExpanding] = useState(false);
  async function expandGuidedPlan(linesToAdd: RankedOpeningLine[]) {
    if (expanding || linesToAdd.length === 0) return;
    setExpanding(true);
    try {
      await addGuidedLinesToRepertoire(
        rep.id,
        linesToAdd.map((entry) => entry.line),
      );
    } finally {
      setExpanding(false);
    }
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

  // When `LineRunner` reports completion we *don't* auto-advance the
  // session anymore. The previous behaviour (800 ms timer → dispatch
  // 'finished') made the new "Play it out vs engine" CTA effectively
  // un-clickable: the button rendered for less than a second before
  // the runner remounted onto the next line. Now we stash the result
  // on a ref and let the user choose what to do — clicking "Play it
  // out", "Skip", "Restart line", or jumping to another line via the
  // picker each transition the session deliberately. "Skip" and the
  // picker's `jumpTo` flush the pending result via `flushPendingFinish`
  // so completion stats land before we move on; "Restart line" leaves
  // the pending result alone (the user is replaying the same line and
  // the next completion will overwrite it).
  const pendingFinishRef = useRef<{ perfect: boolean } | null>(null);

  const handleLineFinished = useCallback(
    ({ perfect }: { perfect: boolean }) => {
      pendingFinishRef.current = { perfect };
    },
    [],
  );

  /** Fire the held 'finished' dispatch (if any) so SessionState advances
   *  with the right perfect flag. Safe to call when nothing is pending. */
  const flushPendingFinish = useCallback(() => {
    if (pendingFinishRef.current) {
      const { perfect } = pendingFinishRef.current;
      pendingFinishRef.current = null;
      dispatch({ type: 'finished', perfect });
    }
  }, []);

  // ── Free-play (vs engine) state ─────────────────────────────────────
  // When the user finishes drilling a line and clicks "Play it out vs
  // engine", we snapshot the line's last FEN + the user's colour and
  // flip phase to 'freeplay'. The runner column swaps to <FreePlayRunner>
  // while the right-hand picker / family stats / session summary stay
  // visible. "Back to practice" flips phase back and re-fires the
  // pending finished dispatch so the practice session resumes.
  const [phase, setPhase] = useState<'practicing' | 'freeplay'>('practicing');
  const [freePlayStart, setFreePlayStart] = useState<{
    fen: string;
    userColor: 'white' | 'black';
    strength: FreePlayStrength;
  } | null>(null);
  const [defaultStrength, setDefaultStrength] = useState<FreePlayStrength>('max');

  // Pull the user's stored free-play default once on mount. We
  // deliberately don't subscribe to Settings via useLiveQuery — a
  // mid-session settings change should NOT yank the strength out from
  // under an in-flight free-play session.
  useEffect(() => {
    void getSettings().then((s) => {
      const stored = (FREE_PLAY_STRENGTHS as readonly string[]).includes(
        s.freePlayStrength ?? '',
      )
        ? (s.freePlayStrength as FreePlayStrength)
        : 'max';
      setDefaultStrength(stored);
    });
  }, []);

  const startFreePlay = useCallback(() => {
    if (!currentLine) return;
    const fens = currentLine.line.fens;
    const lastFen = fens[fens.length - 1];
    setFreePlayStart({
      fen: lastFen,
      userColor: rep.color,
      strength: defaultStrength,
    });
    setPhase('freeplay');
  }, [currentLine, rep.color, defaultStrength]);

  const exitFreePlay = useCallback(() => {
    setPhase('practicing');
    setFreePlayStart(null);
    // Resume the practice session right where it was. If the user got
    // here from a perfect / imperfect completion, fire the finished
    // dispatch now so the next line is queued; otherwise this is a
    // no-op (e.g. the runner was somehow re-entered without finishing,
    // shouldn't happen in practice but cheap to guard).
    flushPendingFinish();
  }, [flushPendingFinish]);
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
          {usingRecommendedSet && (
            <p className="text-xs text-accent">
              {t('practice.drillProgress', {
                active: guidedIndices.length,
                total: decoratedLines.length,
              })}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="btn text-xs"
            onClick={() =>
              void changeScope(usingRecommendedSet ? 'all' : 'guided')
            }
          >
            {usingRecommendedSet
              ? t('practice.includeAllLines')
              : t('practice.useRecommendedSet')}
          </button>
          <Link to="/repertoire" className="btn text-xs">
            {t('practice.allRepertoires')}
          </Link>
        </div>
      </header>

      <ModePicker mode={session.mode} onChange={setMode} />

      {usingRecommendedSet && guidedMastered && nextLines.length > 0 && (
        <div className="card p-4 border-good/40 bg-good/5 flex flex-col sm:flex-row gap-3 sm:items-center">
          <div className="flex-1">
            <div className="font-medium text-good">{t('practice.nextLinesReady')}</div>
            <p className="text-xs text-text-muted">
              {t('practice.nextLinesDescription', { count: nextLines.length })}
            </p>
          </div>
          <button
            type="button"
            className="btn-primary text-xs"
            data-next-line-keys={nextLines
              .map((entry) => openingLineKey(entry.line.uci))
              .join('|')}
            disabled={expanding}
            onClick={() => void expandGuidedPlan(nextLines)}
          >
            {expanding
              ? t('practice.addingNextLines')
              : t('practice.addNextLines', { count: nextLines.length })}
          </button>
        </div>
      )}

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
          ) : phase === 'freeplay' && freePlayStart ? (
            <FreePlayRunner
              startFen={freePlayStart.fen}
              userColor={freePlayStart.userColor}
              initialStrength={freePlayStart.strength}
              onExit={exitFreePlay}
            />
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
                    onSkip={() => {
                      // Skip after completion advances the session
                      // with the recorded perfect flag; skip mid-line
                      // is a normal skip event.
                      if (pendingFinishRef.current) {
                        flushPendingFinish();
                      } else {
                        dispatch({ type: 'skip' });
                      }
                    }}
                    onPlayItOut={startFreePlay}
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
            userColor={rep.color}
            currentIndex={session.currentIndex}
            perfectThisSession={session.perfectThisSession}
            stats={stats ?? null}
            query={query}
            onQuery={setQuery}
            onToggle={toggleLine}
            onSelectAll={selectAll}
            onSelectNone={selectNone}
            onSelectFiltered={selectFiltered}
            onJumpTo={(i) => {
              // Jumping mid-completion should still register the
              // completion before moving to the requested line.
              flushPendingFinish();
              dispatch({ type: 'jumpTo', index: i });
            }}
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
  onPlayItOut,
}: {
  control: LineRunnerControlState;
  decorated: DecoratedLine;
  userColor: 'white' | 'black';
  sessionPlays: number;
  onSkip: () => void;
  /** Inline CTA shown when the line is `done`. Drops the user into
   *  free-play vs Stockfish from this position. The plan deliberately
   *  uses an inline button (not a modal) so the transition is
   *  optional + obvious + non-blocking. */
  onPlayItOut: () => void;
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
      {/* Move ribbon: numbered, colour-coded by side, the
       *  current ply is ringed so the user always knows where in the
       *  line they are. Wraps onto multiple rows if the line is long
       *  (the picker / status row used to truncate at 8 SAN tokens
       *  with an ellipsis — long lines were unreadable). */}
      {decorated.line.san.length > 0 && (
        <LineMoveTokens
          sans={decorated.line.san}
          fens={decorated.line.fens}
          userColor={userColor}
          currentPly={ply}
          size="md"
        />
      )}
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
        {/* "Play it out vs engine" — shown only on line completion.
         *  Sits in the primary action slot (left of Restart / Skip)
         *  styled as `btn-primary` so the user notices it's the new
         *  next-step affordance, but it's still a sibling of the
         *  existing buttons so a user who just wants to keep drilling
         *  can ignore it without dismissing anything. */}
        {status === 'done' && (
          <button
            type="button"
            className="btn-primary text-xs"
            onClick={onPlayItOut}
          >
            {t('practice.playItOut')}
          </button>
        )}
        <div className="ml-auto flex flex-wrap gap-2">
          <button type="button" className="btn text-xs" onClick={onRestart}>
            {t('practice.restartLine')}
          </button>
          <button type="button" className="btn text-xs" onClick={onSkip}>
            {/* On a completed line, "Skip" really means "advance to the
             *  next line" — relabel so the affordance matches what the
             *  user is doing. Mid-line it stays "Skip" (the user is
             *  giving up on the current drill). */}
            {status === 'done' ? t('practice.nextLine') : t('practice.skip')}
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
  userColor,
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
  /** Which side the user is preparing — feeds into per-token colour
   *  coding so the picker can show "your" moves in accent and the
   *  opponent's in muted text. */
  userColor: 'white' | 'black';
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
                        <div className="flex items-baseline gap-2">
                          {d.eco && (
                            <span className="font-mono text-[11px] text-text-muted shrink-0">
                              {d.eco}
                            </span>
                          )}
                          <span className="text-sm truncate flex-1">
                            {d.variation || t('practice.linePicker.mainline')}
                          </span>
                          <span className="text-[10px] text-text-muted shrink-0 tabular-nums">
                            {t('practice.linePicker.plyTag', { count: d.line.uci.length })}
                          </span>
                          {isPerfectSession && (
                            <span className="text-good shrink-0" title={t('practice.linePicker.donePerfectThisSession')}>
                              ✓
                            </span>
                          )}
                        </div>
                        <div className="mt-0.5">
                          <LineMoveTokens
                            sans={d.line.san}
                            fens={d.line.fens}
                            userColor={userColor}
                            size="sm"
                          />
                        </div>
                        {persisted && persisted.attempts > 0 && (
                          <div className="text-[10px] text-text-muted mt-0.5">
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
