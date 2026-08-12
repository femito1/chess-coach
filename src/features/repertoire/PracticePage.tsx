import { useCallback, useEffect, useMemo, useReducer, useRef, useState, startTransition } from 'react';
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
import { isMeasuredLine } from '@/data/openings.generated';
import {
  addGuidedLinesToRepertoire,
  familyColor,
  familyDescription,
  getVariations,
  identifyOpening,
  setRepertoireLearningMode,
  type OpeningLine,
} from '@/features/openings/library';
import {
  buildPersonalOpeningStats,
  openingLineKey,
  rankOpeningLines,
  type PersonalLineRecord,
  type PersonalOpeningStats,
  type RankedOpeningLine,
} from '@/features/openings/recommendations';
import { buildPickerModel, type PickerEntry, type PickerFamily } from './pickerModel';
import type { Tier } from '@/features/openings/difficulty';
import { LearnPanel } from './LearnPanel';
import { LineRunner, type LineRunnerControlState } from './LineRunner';
import { FreePlayRunner } from './FreePlayRunner';
import {
  FREE_PLAY_STRENGTHS,
  cancelFreePlayIdleTeardown,
  scheduleFreePlayIdleTeardown,
  warmFreePlayEngine,
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
import { buildSolutionSteps } from '@/components/SolutionPlayer';
import { Chess } from 'chess.js';
import {
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

/**
 * The frequency number we're willing to show a user for a single move.
 *
 * `globalShare` is only a true branch share when the snapshot actually
 * queried that line's own parent position. Two ways it isn't:
 *   - Beyond `MEASURED_PARENT_DEPTH` the value is the nearest measured
 *     ancestor scaled by a 0.82-per-ply decay. That number shrinks purely
 *     with depth, so quoting it as "only 5% play this" would report a
 *     property of the line's length as if it were a property of players'
 *     choices. (The committed snapshot is depth-capped today, so this is
 *     the common case, not a corner one.)
 *   - `globalGames === 0` means the branch was never measured at all, NOT
 *     "nobody plays this".
 *
 * Either way we return null and the Learn panel says nothing about that
 * move. Silence beats a confident wrong number.
 */
function trustworthyShare(line: OpeningLine | undefined): number | null {
  if (!line) return null;
  if (!isMeasuredLine(line)) return null;
  if (!(line.globalGames > 0)) return null;
  if (!(line.globalShare > 0)) return null;
  return line.globalShare;
}

/**
 * Build a drillable `DecoratedLine` from a picker entry's own moves, by
 * replaying them from the start position. Used for a *focused* drill —
 * drilling exactly the line the user was shown, rather than whichever
 * repertoire leaf happens to extend it. `buildSolutionSteps` stops at the
 * first illegal move, so a malformed line yields a shorter (still
 * coherent) line rather than throwing.
 */
function decorateEntry(entry: PickerEntry): DecoratedLine {
  const steps = buildSolutionSteps(new Chess().fen(), [...entry.uci]);
  const played = steps.slice(1);
  const line: RepertoireLine = {
    uci: played.map((s) => s.uci),
    san: played.map((s) => s.san),
    fens: steps.map((s) => s.fen),
    name:
      played
        .slice(0, 6)
        .map((s) => s.san)
        .join(' ') + (played.length > 6 ? '…' : ''),
  };
  return {
    line,
    family: entry.family,
    variation: entry.variation,
    eco: entry.eco,
    searchHaystack: '',
  };
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
  // Personal opening stats (prefix counts + per-prefix W/D/L) are the
  // single most expensive computation on this page — one chess.js reparse
  // of every game (~1.3 s at 2 500 games; see ARCHITECTURE.md). Compute
  // once here and thread it down; both the recommendation ranking and the
  // difficulty tiers read from it, so it must never be built twice.
  const personal = useMemo(
    () =>
      rep.family
        ? buildPersonalOpeningStats(games ?? [], familyColor(rep.family))
        : buildPersonalOpeningStats(games ?? [], rep.color),
    [games, rep.family, rep.color],
  );
  const rankedRecommendations = useMemo<RankedOpeningLine[]>(() => {
    if (!rep.family) return [];
    return rankOpeningLines(getVariations(rep.family), personal);
  }, [personal, rep.family]);

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
  //
  // Blank the list ONLY when switching repertoires. On an in-place update
  // — which is what adding a line from the picker does, since
  // `addGuidedLinesToRepertoire` bumps `updatedAt` — keep the current
  // list mounted and swap it when the new one arrives. Setting it to null
  // here would trip the `if (!lines)` guard below, unmounting
  // `ActivePractice` and destroying the whole drill session: the pending
  // "drill this line" handoff, the current line, `sessionPlays`, and
  // `perfectThisSession`. That made "Drill this line" on a not-yet-added
  // line silently impossible — it imported the line, then threw the user
  // back to a freshly-seeded session.
  const shownRepIdRef = useRef<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (shownRepIdRef.current !== rep.id) {
      shownRepIdRef.current = rep.id;
      setLines(null);
    }
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
      personal={personal}
      onStatsChanged={() => setStatsBucket((n) => n + 1)}
    />
  );
}

function ActivePractice({
  rep,
  decoratedLines,
  stats,
  rankedRecommendations,
  personal,
  onStatsChanged,
}: {
  rep: Repertoire;
  decoratedLines: DecoratedLine[];
  stats: Awaited<ReturnType<typeof getLineStatsMap>> | null | undefined;
  rankedRecommendations: RankedOpeningLine[];
  personal: PersonalOpeningStats;
  onStatsChanged: () => void;
}) {
  const { t } = useTranslation();
  const decoratedRawLines = useMemo(
    () => decoratedLines.map((entry) => entry.line),
    [decoratedLines],
  );

  // The unified picker model: every library line for the families this
  // repertoire touches, merged with what's already in the repertoire and
  // tiered Easy/Medium/Hard. Built from the shared `personal` stats so it
  // costs no extra PGN parse. `libraryByFamily` is memoized on the set of
  // families present, not on the lines, so it only rebuilds when the
  // repertoire spans a new family.
  const familyKeys = useMemo(() => {
    const set = new Set<string>();
    if (rep.family) set.add(rep.family);
    for (const d of decoratedLines) {
      if (d.family && d.family !== 'Unidentified') set.add(d.family);
    }
    return [...set];
  }, [rep.family, decoratedLines]);
  const libraryByFamily = useMemo(() => {
    const map = new Map<string, OpeningLine[]>();
    for (const family of familyKeys) map.set(family, getVariations(family));
    return map;
  }, [familyKeys]);
  const libraryLineByKey = useMemo(() => {
    const map = new Map<string, OpeningLine>();
    for (const lines of libraryByFamily.values()) {
      for (const line of lines) map.set(openingLineKey(line.uci), line);
    }
    return map;
  }, [libraryByFamily]);
  const pickerFamilies = useMemo(
    () =>
      buildPickerModel({
        repertoireLeaves: decoratedLines.map((d) => ({
          uci: d.line.uci,
          family: d.family,
        })),
        libraryByFamily,
        personal,
      }),
    [decoratedLines, libraryByFamily, personal],
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
  // Re-seed scope + selection when the repertoire's plan changes. Skipped
  // while a "drill this line" handoff is in flight: adding a line bumps
  // `activeLineKeys`, which fires this effect, which would otherwise
  // immediately overwrite the selection the handoff just made and leave
  // the user on a different line than the one they asked to drill.
  const drillHandoffPendingRef = useRef(false);
  useEffect(() => {
    if (drillHandoffPendingRef.current) return;
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

  // Search query for the line picker. Filtering now happens in
  // `visibleFamilies` over the unified picker model.
  const [query, setQuery] = useState('');

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

  // Growth is no longer gated on mastering the current set — the unified
  // picker lets you add any line at any time, and forcing perfection first
  // was exactly the "repeated failure with no acquisition step" trap. The
  // recommended-next card is now just a convenience shortcut.
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

  // ── Discovery: tier filter + "add these library lines" selection ─────
  const [tierFilter, setTierFilter] = useState<Tier | 'all'>('all');
  // Library lines the user has ticked to add (keyed by openingLineKey).
  // Kept SEPARATE from the drill `selected` set: one is "what to import",
  // the other "what to drill this session". Conflating them is exactly
  // what made adding lines confusing before.
  const [toAdd, setToAdd] = useState<Set<string>>(new Set());
  const [addingLibrary, setAddingLibrary] = useState(false);
  const [addProgress, setAddProgress] = useState<{ done: number; total: number } | null>(null);

  const toggleToAdd = useCallback((key: string) => {
    setToAdd((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  /** Add the ticked library lines to the repertoire in one action. Uses
   *  the shared guided-add path so SRS cards + activeLineKeys are written
   *  consistently, and is idempotent (adding an already-present line is a
   *  no-op at the node level). */
  const addLibraryLines = useCallback(
    async (keys: string[]): Promise<void> => {
      const lines = keys
        .map((key) => libraryLineByKey.get(key))
        .filter((l): l is OpeningLine => Boolean(l));
      if (addingLibrary || lines.length === 0) return;
      setAddingLibrary(true);
      setAddProgress({ done: 0, total: lines.length });
      try {
        // Sequential so shared prefixes collapse into the same nodes and
        // progress is meaningful (mirrors addFamilyToRepertoire).
        for (let i = 0; i < lines.length; i++) {
          await addGuidedLinesToRepertoire(rep.id, [lines[i]]);
          setAddProgress({ done: i + 1, total: lines.length });
        }
        setToAdd((prev) => {
          const next = new Set(prev);
          for (const key of keys) next.delete(key);
          return next;
        });
      } finally {
        setAddingLibrary(false);
        setAddProgress(null);
      }
    },
    [addingLibrary, libraryLineByKey, rep.id],
  );

  // ── Learn: step through a line before being tested on it ─────────────
  // Held by KEY, not by value: importing a line rebuilds the picker model,
  // and a snapshotted entry would keep reporting the stale
  // `inRepertoire` / `repertoireIndex` it had when the panel opened (so
  // the button would still say "Add to repertoire" after a successful
  // add, and a later drill would re-import).
  const [learnKey, setLearnKey] = useState<string | null>(null);
  const learnEntry = useMemo(() => {
    if (learnKey == null) return null;
    for (const fam of pickerFamilies) {
      const found = fam.entries.find((e) => e.key === learnKey);
      if (found) return found;
    }
    return null;
  }, [learnKey, pickerFamilies]);
  const openLearn = useCallback((entry: PickerEntry) => setLearnKey(entry.key), []);
  const closeLearn = useCallback(() => setLearnKey(null), []);

  /** "Add to set": include a line in the session without jumping to it.
   *  In-repertoire → tick its drill index; library-only → import it. */
  const addToSet = useCallback(
    (entry: PickerEntry) => {
      if (entry.repertoireIndex != null) {
        const index = entry.repertoireIndex;
        setSelected((prev) => (prev.has(index) ? prev : new Set(prev).add(index)));
      } else {
        void addLibraryLines([entry.key]);
      }
    },
    [addLibraryLines],
  );

  function toggleLine(i: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
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
  // A single line the user asked to drill on its own — see `drillEntry`
  // below for why this exists rather than always jumping into the session.
  // Declared here so `startFreePlay` can prefer it over `currentLine`.
  const [focusLine, setFocusLine] = useState<DecoratedLine | null>(null);
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
    // In focused mode the runner is showing `focusLine`, not the session's
    // current line — play out the position the user actually just drilled.
    const source = focusLine ?? currentLine;
    if (!source) return;
    const fens = source.line.fens;
    const lastFen = fens[fens.length - 1];
    startTransition(() => {
      setFreePlayStart({
        fen: lastFen,
        userColor: rep.color,
        strength: defaultStrength,
      });
      setPhase('freeplay');
    });
  }, [focusLine, currentLine, rep.color, defaultStrength]);

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

  // ── Drill a specific line (from the picker's Play or Learn's "Drill
  //    this line") ──────────────────────────────────────────────────
  //
  // Two routes, and which one we take matters for whether the user is
  // tested on what they were actually shown:
  //
  //   * The entry IS a repertoire leaf (`leafIsExact`) → drill it through
  //     the normal session, so session progress / summary / repeat modes
  //     all behave as before.
  //   * Otherwise → drill it as a *focused line*, standalone. This covers
  //     a line not yet in the repertoire, and — just as importantly — a
  //     shallow library variation whose only match is a much deeper leaf
  //     that extends it (the norm for bulk-imported trees). Jumping to
  //     that leaf would test 6–10 moves past the end of what Learn
  //     taught, which is exactly the "tested on a line you've never seen"
  //     failure this feature exists to remove. `LineRunner` is driven
  //     purely by the line's own uci/san/fens, so a focused line needs no
  //     repertoire nodes and renders immediately.
  //
  // (`focusLine` itself is declared above, next to the free-play state, so
  // `startFreePlay` can prefer it over the session's current line.)
  const selectAndJump = useCallback((index: number) => {
    setSelected((prev) => (prev.has(index) ? prev : new Set(prev).add(index)));
    setPendingJumpIndex(index);
  }, []);
  const [pendingJumpIndex, setPendingJumpIndex] = useState<number | null>(null);

  const drillEntry = useCallback(
    (entry: PickerEntry) => {
      setLearnKey(null);
      if (entry.repertoireIndex != null && entry.leafIsExact) {
        drillHandoffPendingRef.current = true;
        selectAndJump(entry.repertoireIndex);
        return;
      }
      // Focused drill of exactly this line. Import in the background when
      // it isn't in the repertoire yet so SRS cards and the picker's
      // "added" state catch up, but don't make the drill wait on it.
      setFocusLine(decorateEntry(entry));
      if (!entry.inRepertoire) void addLibraryLines([entry.key]);
    },
    [addLibraryLines, selectAndJump],
  );

  const exitFocusLine = useCallback(() => setFocusLine(null), []);

  // Fire the deferred jump once the reducer has the index in its
  // selection (the `selected` → changeSelection sync runs in its own
  // effect, so this waits a render for it to land).
  useEffect(() => {
    if (pendingJumpIndex == null) return;
    if (!session.selectedIndices.includes(pendingJumpIndex)) return;
    flushPendingFinish();
    dispatch({ type: 'jumpTo', index: pendingJumpIndex });
    setPendingJumpIndex(null);
    drillHandoffPendingRef.current = false;
  }, [pendingJumpIndex, session.selectedIndices, flushPendingFinish]);

  // Filter the unified list by search query and tier for display.
  const visibleFamilies = useMemo(() => {
    const q = query.trim().toLowerCase();
    return pickerFamilies
      .map((fam) => ({
        family: fam.family,
        entries: fam.entries.filter((e) => {
          if (tierFilter !== 'all' && e.tier !== tierFilter) return false;
          if (q.length === 0) return true;
          return (
            e.family.toLowerCase().includes(q) ||
            e.variation.toLowerCase().includes(q) ||
            e.eco.toLowerCase().includes(q)
          );
        }),
      }))
      .filter((fam) => fam.entries.length > 0);
  }, [pickerFamilies, query, tierFilter]);

  const addableSelectedKeys = useMemo(
    () => [...toAdd],
    [toAdd],
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

      {usingRecommendedSet && nextLines.length > 0 && (
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
          {learnEntry ? (
            <LearnPanel
              key={learnEntry.key}
              uci={learnEntry.uci}
              variation={learnEntry.variation}
              family={learnEntry.family}
              eco={learnEntry.eco}
              tier={learnEntry.tier}
              plies={learnEntry.plies}
              record={learnEntry.record}
              inRepertoire={learnEntry.inRepertoire}
              familyBlurb={familyDescription(learnEntry.family)}
              moveShares={learnEntry.uci.map((_, i) =>
                trustworthyShare(libraryLineByKey.get(
                  openingLineKey(learnEntry.uci.slice(0, i + 1)),
                )),
              )}
              userColor={rep.color}
              adding={addingLibrary}
              onDrill={() => drillEntry(learnEntry)}
              onAddToSet={() => addToSet(learnEntry)}
              onClose={closeLearn}
            />
          ) : focusLine ? (
            /* Focused drill: exactly the line the user chose/learned,
               independent of the session queue. */
            <div className="space-y-2">
              <div className="flex items-baseline justify-between gap-2 px-1">
                <div className="text-xs text-text-muted">
                  {t('practice.focus.drillingOneLine', {
                    name: focusLine.variation || focusLine.family,
                  })}
                </div>
                <button type="button" className="btn text-xs" onClick={exitFocusLine}>
                  {t('practice.focus.backToSet')}
                </button>
              </div>
              <LineRunner
                key={`focus-${rep.id}-${lineKey(focusLine.line.uci)}`}
                repertoireId={rep.id}
                line={focusLine.line}
                userColor={rep.color}
                onStatsChanged={onStatsChanged}
                renderControls={(c) => (
                  <PracticeStatusBar
                    control={c}
                    decorated={focusLine}
                    userColor={rep.color}
                    sessionPlays={0}
                    onSkip={exitFocusLine}
                    onPlayItOut={startFreePlay}
                  />
                )}
              />
            </div>
          ) : selected.size === 0 ? (
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
            families={visibleFamilies}
            totalEntries={pickerFamilies.reduce((n, f) => n + f.entries.length, 0)}
            drillSelected={selected}
            toAdd={toAdd}
            currentIndex={session.currentIndex}
            perfectThisSession={session.perfectThisSession}
            decoratedLines={decoratedLines}
            stats={stats ?? null}
            query={query}
            onQuery={setQuery}
            tierFilter={tierFilter}
            onTierFilter={setTierFilter}
            adding={addingLibrary}
            addProgress={addProgress}
            addableSelectedKeys={addableSelectedKeys}
            onToggleDrill={toggleLine}
            onToggleAdd={toggleToAdd}
            onAddSelected={() => void addLibraryLines(addableSelectedKeys)}
            onLearn={openLearn}
            onDrillEntry={drillEntry}
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

  // Warm the free-play opponent worker while the CTA is visible so the
  // click transition doesn't hitch on WASM cold-boot. Do NOT warm the
  // review/live-eval singleton here — that worker is refcounted by
  // `useLiveEval`, and warming it with no consumer leaks ~30 MB until
  // something else happens to mount a live-eval. FreePlayRunner boots
  // live-eval itself after paint. Cancel any pending teardown on (re)
  // mount so StrictMode's fake unmount doesn't kill the just-warmed
  // worker while the CTA is still showing; re-arm on unmount so a Skip /
  // Next that never enters free-play still frees the heap.
  useEffect(() => {
    if (status !== 'done') return;
    cancelFreePlayIdleTeardown();
    void warmFreePlayEngine().catch(() => undefined);
    return () => {
      scheduleFreePlayIdleTeardown(1500);
    };
  }, [status]);

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

/** Tailwind classes for a tier badge. Reuses the move-classification
 *  palette (green / amber / red) so difficulty reads at a glance without
 *  a new colour token. */
const TIER_BADGE: Record<Tier, string> = {
  easy: 'bg-good/15 text-good',
  medium: 'bg-inaccuracy/15 text-inaccuracy',
  hard: 'bg-blunder/15 text-blunder',
};

/** How many rows to render per family before a "show more" — matches the
 *  `PAGE_SIZE` cap the games table uses, so a 380-line family (Sicilian)
 *  doesn't mount hundreds of rows at once. */
const PICKER_GROUP_PAGE = 100;

function TierChip({ tier }: { tier: Tier }) {
  const { t } = useTranslation();
  return (
    <span
      className={`text-[10px] font-medium px-1.5 py-0.5 rounded shrink-0 ${TIER_BADGE[tier]}`}
    >
      {t(`practice.linePicker.tier.${tier}` as const)}
    </span>
  );
}

/** Compact "your record here" chip. `inherited` marks a record borrowed
 *  from a broader variation the user has actually played. */
function RecordChip({ record }: { record: PersonalLineRecord }) {
  const { t } = useTranslation();
  return (
    <span
      className="text-[10px] text-text-muted shrink-0"
      title={
        record.inherited
          ? t('practice.linePicker.recordInheritedHint')
          : t('practice.linePicker.recordHint')
      }
    >
      {record.inherited ? '≈ ' : ''}
      {t('practice.linePicker.record', {
        wins: record.wins,
        draws: record.draws,
        losses: record.losses,
      })}
    </span>
  );
}

function LinePicker({
  families,
  totalEntries,
  drillSelected,
  toAdd,
  currentIndex,
  perfectThisSession,
  decoratedLines,
  stats,
  query,
  onQuery,
  tierFilter,
  onTierFilter,
  adding,
  addProgress,
  addableSelectedKeys,
  onToggleDrill,
  onToggleAdd,
  onAddSelected,
  onLearn,
  onDrillEntry,
}: {
  families: PickerFamily[];
  totalEntries: number;
  drillSelected: Set<number>;
  toAdd: Set<string>;
  currentIndex: number | null;
  perfectThisSession: number[];
  decoratedLines: DecoratedLine[];
  stats: Awaited<ReturnType<typeof getLineStatsMap>> | null;
  query: string;
  onQuery: (q: string) => void;
  tierFilter: Tier | 'all';
  onTierFilter: (t: Tier | 'all') => void;
  adding: boolean;
  addProgress: { done: number; total: number } | null;
  addableSelectedKeys: string[];
  onToggleDrill: (repertoireIndex: number) => void;
  onToggleAdd: (key: string) => void;
  onAddSelected: () => void;
  onLearn: (entry: PickerEntry) => void;
  onDrillEntry: (entry: PickerEntry) => void;
}) {
  const { t } = useTranslation();
  const inRepertoireCount = decoratedLines.length;
  // Per-family "show more" cursors, keyed by family name.
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  const tierOptions: Array<Tier | 'all'> = ['all', 'easy', 'medium', 'hard'];

  return (
    <div className="card p-3 space-y-2">
      <div className="flex items-baseline justify-between">
        <div className="text-xs uppercase tracking-wide text-text-muted">
          {t('practice.linePicker.lines')}
        </div>
        <div className="text-[11px] text-text-muted">
          {t('practice.linePicker.repertoireCount', {
            inRepertoire: inRepertoireCount,
            available: totalEntries,
          })}
        </div>
      </div>
      <input
        type="search"
        className="input text-sm"
        placeholder={t('practice.linePicker.searchPlaceholder')}
        value={query}
        onChange={(e) => onQuery(e.target.value)}
      />
      <div className="flex flex-wrap gap-1 text-xs">
        {tierOptions.map((opt) => (
          <button
            key={opt}
            type="button"
            className={`text-[11px] px-2 py-0.5 rounded border ${
              tierFilter === opt
                ? 'border-accent text-accent'
                : 'border-border text-text-muted hover:text-text'
            }`}
            onClick={() => onTierFilter(opt)}
          >
            {opt === 'all'
              ? t('practice.linePicker.tierAll')
              : t(`practice.linePicker.tier.${opt}` as const)}
          </button>
        ))}
      </div>
      {addableSelectedKeys.length > 0 && (
        <button
          type="button"
          className="btn-primary text-xs w-full"
          disabled={adding}
          onClick={onAddSelected}
        >
          {adding && addProgress
            ? t('practice.linePicker.addingProgress', {
                done: addProgress.done,
                total: addProgress.total,
              })
            : t('practice.linePicker.addSelected', {
                count: addableSelectedKeys.length,
              })}
        </button>
      )}
      <div className="max-h-[60vh] overflow-y-auto -mx-1 pr-1 divide-y divide-border">
        {families.length === 0 ? (
          <div className="py-6 text-center text-xs text-text-muted">
            {t('practice.linePicker.noMatches', { query })}
          </div>
        ) : (
          families.map(({ family, entries }) => {
            const expanded = expandedGroups.has(family);
            const shown = expanded ? entries : entries.slice(0, PICKER_GROUP_PAGE);
            const hidden = entries.length - shown.length;
            return (
              <div key={family} className="py-2 first:pt-0 last:pb-0">
                <div className="text-[11px] uppercase tracking-wide text-text-muted px-1 py-0.5">
                  {family}
                </div>
                <ul className="space-y-1">
                  {shown.map((entry) => (
                    <PickerRow
                      key={entry.key}
                      entry={entry}
                      isDrillSelected={
                        entry.repertoireIndex != null &&
                        drillSelected.has(entry.repertoireIndex)
                      }
                      isToAdd={toAdd.has(entry.key)}
                      isCurrent={
                        entry.repertoireIndex != null &&
                        entry.repertoireIndex === currentIndex
                      }
                      isPerfectSession={
                        entry.repertoireIndex != null &&
                        perfectThisSession.includes(entry.repertoireIndex)
                      }
                      srs={
                        stats && entry.repertoireIndex != null
                          ? stats.get(entry.key) ?? null
                          : null
                      }
                      onToggleDrill={onToggleDrill}
                      onToggleAdd={onToggleAdd}
                      onLearn={onLearn}
                      onDrillEntry={onDrillEntry}
                    />
                  ))}
                </ul>
                {hidden > 0 && (
                  <button
                    type="button"
                    className="text-[11px] text-accent hover:underline mt-1 px-1"
                    onClick={() =>
                      setExpandedGroups((prev) => new Set(prev).add(family))
                    }
                  >
                    {t('practice.linePicker.showMore', { count: hidden })}
                  </button>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

function PickerRow({
  entry,
  isDrillSelected,
  isToAdd,
  isCurrent,
  isPerfectSession,
  srs,
  onToggleDrill,
  onToggleAdd,
  onLearn,
  onDrillEntry,
}: {
  entry: PickerEntry;
  isDrillSelected: boolean;
  isToAdd: boolean;
  isCurrent: boolean;
  isPerfectSession: boolean;
  srs: RepertoireLineStats | null;
  onToggleDrill: (repertoireIndex: number) => void;
  onToggleAdd: (key: string) => void;
  onLearn: (entry: PickerEntry) => void;
  onDrillEntry: (entry: PickerEntry) => void;
}) {
  const { t } = useTranslation();
  const id = `pick-${entry.key.replace(/\s+/g, '_')}`;
  return (
    <li
      className={`flex items-start gap-2 px-1 py-1 rounded ${
        isCurrent ? 'bg-accent/15' : ''
      }`}
    >
      {entry.inRepertoire && entry.repertoireIndex != null ? (
        <input
          id={id}
          type="checkbox"
          className="mt-1 cursor-pointer"
          checked={isDrillSelected}
          title={t('practice.linePicker.drillToggleHint')}
          onChange={() => onToggleDrill(entry.repertoireIndex!)}
        />
      ) : (
        <input
          id={id}
          type="checkbox"
          className="mt-1 cursor-pointer accent-good"
          checked={isToAdd}
          title={t('practice.linePicker.addToggleHint')}
          onChange={() => onToggleAdd(entry.key)}
        />
      )}
      <label htmlFor={id} className="flex-1 min-w-0 cursor-pointer">
        <div className="flex items-baseline gap-2 flex-wrap">
          {entry.eco && (
            <span className="font-mono text-[11px] text-text-muted shrink-0">
              {entry.eco}
            </span>
          )}
          <span className="text-sm truncate">
            {entry.variation || t('practice.linePicker.mainline')}
          </span>
          <TierChip tier={entry.tier} />
          <span className="text-[10px] text-text-muted shrink-0 tabular-nums">
            {t('practice.linePicker.plyTag', { count: entry.plies })}
          </span>
          {entry.forcedness === 'rare' && (
            <span className="text-[10px] text-miss shrink-0">
              {t('practice.linePicker.rare')}
            </span>
          )}
          {entry.forcedness === 'forced' && (
            <span className="text-[10px] text-text-muted shrink-0">
              {t('practice.linePicker.forced')}
            </span>
          )}
          {entry.record && <RecordChip record={entry.record} />}
          {isPerfectSession && (
            <span
              className="text-good shrink-0"
              title={t('practice.linePicker.donePerfectThisSession')}
            >
              {'✓'}
            </span>
          )}
          {!entry.inRepertoire && (
            <span className="text-[10px] text-accent/80 shrink-0">
              {t('practice.linePicker.notAdded')}
            </span>
          )}
        </div>
        {srs && srs.attempts > 0 && (
          <div className="text-[10px] text-text-muted mt-0.5">
            {t('practice.linePicker.doneCount', { count: srs.completions })}
            {srs.perfectCompletions > 0 && (
              <span className="text-good">
                {' · '}
                {t('practice.linePicker.donePerfect', {
                  count: srs.perfectCompletions,
                })}
              </span>
            )}
          </div>
        )}
      </label>
      <div className="flex flex-col items-end gap-0.5 shrink-0">
        <button
          type="button"
          className="text-[11px] text-accent hover:underline"
          onClick={() => onLearn(entry)}
          title={t('practice.linePicker.learnHint')}
        >
          {t('practice.linePicker.learn')}
        </button>
        <button
          type="button"
          className="text-[11px] text-text-muted hover:text-text"
          onClick={() => onDrillEntry(entry)}
          title={t('practice.linePicker.playTitle')}
        >
          {entry.inRepertoire
            ? t('practice.linePicker.play')
            : t('practice.linePicker.addAndDrill')}
        </button>
      </div>
    </li>
  );
}
