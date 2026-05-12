import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, type RepertoireLineStats } from '@/db/schema';
import {
  enumerateLines,
  getLineStatsMap,
  lineKey,
  type RepertoireLine,
} from './store';
import { identifyOpening } from '@/features/openings/library';
import {
  LineRunner,
  type LineRunnerControlState,
} from './LineRunner';

interface DecoratedLine {
  line: RepertoireLine;
  /** Stable family name for grouping in the picker. Falls back to
   *  "Unidentified" when nothing in the openings library matches the
   *  first move of the line. */
  family: string;
  /** Display label for the variation (best-effort). */
  variation: string;
  /** ECO code, blank if unknown. */
  eco: string;
}

function decorate(lines: RepertoireLine[]): DecoratedLine[] {
  return lines.map((line) => {
    const op = identifyOpening(line.uci);
    return {
      line,
      family: op?.family ?? 'Unidentified',
      variation: op?.variation || op?.name || line.name,
      eco: op?.eco ?? '',
    };
  });
}

interface FamilyGroup {
  family: string;
  lines: DecoratedLine[];
}

function groupByFamily(lines: DecoratedLine[]): FamilyGroup[] {
  const map = new Map<string, DecoratedLine[]>();
  for (const dl of lines) {
    const arr = map.get(dl.family);
    if (arr) arr.push(dl);
    else map.set(dl.family, [dl]);
  }
  // Stable order: alphabetical by family, "Unidentified" pushed to bottom.
  const groups = Array.from(map.entries()).map(([family, lines]) => ({
    family,
    lines,
  }));
  groups.sort((a, b) => {
    if (a.family === 'Unidentified' && b.family !== 'Unidentified') return 1;
    if (b.family === 'Unidentified' && a.family !== 'Unidentified') return -1;
    return a.family.localeCompare(b.family);
  });
  return groups;
}

interface FamilyAggregate {
  totalLines: number;
  attempts: number;
  completions: number;
  movesPlayed: number;
  correctMoves: number;
  wrongMoves: number;
}

function aggregateFamilyStats(
  group: FamilyGroup,
  statsByKey: Map<string, RepertoireLineStats>,
): FamilyAggregate {
  let attempts = 0;
  let completions = 0;
  let movesPlayed = 0;
  let correctMoves = 0;
  let wrongMoves = 0;
  for (const dl of group.lines) {
    const s = statsByKey.get(lineKey(dl.line.uci));
    if (!s) continue;
    attempts += s.attempts;
    completions += s.completions;
    movesPlayed += s.movesPlayed;
    correctMoves += s.correctMoves;
    wrongMoves += s.wrongMoves;
  }
  return {
    totalLines: group.lines.length,
    attempts,
    completions,
    movesPlayed,
    correctMoves,
    wrongMoves,
  };
}

export function RepertoireLineTrainer() {
  const { id } = useParams<{ id: string }>();
  const repertoire = useLiveQuery(
    () => (id ? db.repertoires.get(id) : undefined),
    [id],
  );
  const [lines, setLines] = useState<RepertoireLine[] | null>(null);
  const [statsByKey, setStatsByKey] = useState<Map<string, RepertoireLineStats>>(
    new Map(),
  );
  const [statsTick, setStatsTick] = useState(0);
  const [pickedFamily, setPickedFamily] = useState<string | null>(null);
  const [pickedLineIdx, setPickedLineIdx] = useState<number | null>(null);

  useEffect(() => {
    if (!id) return;
    void enumerateLines(id).then((ls) => {
      setLines(ls);
      setPickedFamily(null);
      setPickedLineIdx(null);
    });
  }, [id]);

  useEffect(() => {
    if (!id) return;
    void getLineStatsMap(id).then(setStatsByKey);
  }, [id, statsTick]);

  const decorated = useMemo(
    () => (lines ? decorate(lines) : []),
    [lines],
  );
  const groups = useMemo(() => groupByFamily(decorated), [decorated]);

  if (!id) return <div>Missing id.</div>;
  if (!repertoire || lines === null) {
    return <div className="text-text-muted">Loading…</div>;
  }
  if (lines.length === 0) {
    return (
      <div className="space-y-4">
        <Header repertoireName={repertoire.name} repertoireId={id} />
        <div className="card p-8 text-center text-text-muted space-y-2">
          <div className="text-lg">No lines yet.</div>
          <div className="text-sm">
            Open the editor and add some moves first, or pull lines from the
            <Link to="/openings" className="text-accent ml-1">
              openings library
            </Link>
            .
          </div>
        </div>
      </div>
    );
  }

  const activeGroup =
    pickedFamily !== null
      ? groups.find((g) => g.family === pickedFamily) ?? null
      : null;
  const activeLine =
    activeGroup && pickedLineIdx !== null
      ? activeGroup.lines[pickedLineIdx]?.line ?? null
      : null;

  function pickFamily(family: string) {
    setPickedFamily(family);
    setPickedLineIdx(null);
  }

  function pickLine(idxInGroup: number) {
    setPickedLineIdx(idxInGroup);
  }

  function backToFamilies() {
    setPickedFamily(null);
    setPickedLineIdx(null);
  }

  function backToLines() {
    setPickedLineIdx(null);
  }

  function nextLineInFamily(shuffle: boolean) {
    if (!activeGroup || pickedLineIdx === null) return;
    if (shuffle) {
      setPickedLineIdx(Math.floor(Math.random() * activeGroup.lines.length));
    } else {
      setPickedLineIdx((pickedLineIdx + 1) % activeGroup.lines.length);
    }
  }

  return (
    <div className="space-y-4">
      <Header
        repertoireName={repertoire.name}
        repertoireId={id}
        progress={
          activeLine
            ? `${activeGroup!.family}${
                activeGroup!.lines[pickedLineIdx!]?.variation
                  ? ' · ' + activeGroup!.lines[pickedLineIdx!].variation
                  : ''
              }`
            : pickedFamily
              ? `${pickedFamily} · ${activeGroup?.lines.length ?? 0} lines`
              : `${groups.length} openings · ${decorated.length} lines`
        }
      />

      {activeLine && activeGroup ? (
        <ActiveTrainer
          repertoireId={id}
          line={activeLine}
          decorated={activeGroup.lines[pickedLineIdx!]}
          stats={statsByKey.get(lineKey(activeLine.uci)) ?? null}
          userColor={repertoire.color}
          onBackToLines={backToLines}
          onNextLine={() => nextLineInFamily(false)}
          onShuffleLine={() => nextLineInFamily(true)}
          onStatsChanged={() => setStatsTick((t) => t + 1)}
        />
      ) : pickedFamily && activeGroup ? (
        <LinePickerView
          group={activeGroup}
          statsByKey={statsByKey}
          onPick={pickLine}
          onBack={backToFamilies}
        />
      ) : (
        <FamilyPickerView
          groups={groups}
          statsByKey={statsByKey}
          onPick={pickFamily}
        />
      )}
    </div>
  );
}

function Header({
  repertoireName,
  repertoireId,
  progress,
}: {
  repertoireName: string;
  repertoireId: string;
  progress?: string;
}) {
  return (
    <div className="flex items-center gap-3 flex-wrap">
      <Link to="/repertoire" className="btn text-xs">
        ← Back
      </Link>
      <div className="flex-1 min-w-0">
        <h1 className="text-lg font-semibold truncate">
          {repertoireName} · Play through lines
        </h1>
        {progress && (
          <div className="text-xs text-text-muted truncate">{progress}</div>
        )}
      </div>
      <Link to={`/repertoire/${repertoireId}/train`} className="btn text-xs">
        Card mode
      </Link>
    </div>
  );
}

function FamilyPickerView({
  groups,
  statsByKey,
  onPick,
}: {
  groups: FamilyGroup[];
  statsByKey: Map<string, RepertoireLineStats>;
  onPick: (family: string) => void;
}) {
  if (groups.length === 0) return null;
  return (
    <div className="card p-4 space-y-3">
      <div className="text-sm text-text-muted">
        Pick an opening to drill. Stats include every time you played
        through one of its lines, across all sessions.
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        {groups.map((g) => {
          const agg = aggregateFamilyStats(g, statsByKey);
          const accuracy = accuracyPct(agg.correctMoves, agg.movesPlayed);
          return (
            <button
              key={g.family}
              type="button"
              onClick={() => onPick(g.family)}
              className="card p-3 text-left hover:border-accent/60 transition-colors space-y-1"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium truncate">{g.family}</span>
                <span className="text-xs text-text-muted shrink-0">
                  {g.lines.length} line{g.lines.length === 1 ? '' : 's'}
                </span>
              </div>
              <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-text-muted">
                <span>
                  Attempts:{' '}
                  <span className="font-mono text-text">{agg.attempts}</span>
                </span>
                <span>
                  Completed:{' '}
                  <span className="font-mono text-text">{agg.completions}</span>
                </span>
                {accuracy !== null ? (
                  <span>
                    Accuracy:{' '}
                    <span
                      className={`font-mono ${accuracy >= 0.9 ? 'text-good' : accuracy < 0.6 ? 'text-blunder' : 'text-text'}`}
                    >
                      {(accuracy * 100).toFixed(0)}%
                    </span>
                  </span>
                ) : (
                  <span className="italic">Not yet drilled</span>
                )}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function LinePickerView({
  group,
  statsByKey,
  onPick,
  onBack,
}: {
  group: FamilyGroup;
  statsByKey: Map<string, RepertoireLineStats>;
  onPick: (idx: number) => void;
  onBack: () => void;
}) {
  return (
    <div className="card p-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={onBack}
          className="btn text-xs"
        >
          ← All openings
        </button>
        <div className="text-xs text-text-muted">
          {group.lines.length} line{group.lines.length === 1 ? '' : 's'} in {group.family}
        </div>
      </div>
      <ul className="divide-y divide-border">
        {group.lines.map((dl, idx) => {
          const s = statsByKey.get(lineKey(dl.line.uci));
          const accuracy = accuracyPct(s?.correctMoves ?? 0, s?.movesPlayed ?? 0);
          return (
            <li key={idx}>
              <button
                type="button"
                onClick={() => onPick(idx)}
                className="w-full text-left py-2 px-1 hover:bg-bg-raised/40 rounded flex flex-col gap-1"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="font-medium truncate">
                      {dl.eco && (
                        <span className="text-text-muted font-mono text-xs mr-2">
                          {dl.eco}
                        </span>
                      )}
                      {dl.variation || `Line ${idx + 1}`}
                    </div>
                    <div className="text-xs text-text-muted font-mono truncate">
                      {dl.line.san.slice(0, 10).join(' ')}
                      {dl.line.san.length > 10 && '…'}
                    </div>
                  </div>
                  <span className="text-xs text-text-muted shrink-0">
                    {dl.line.uci.length} ply
                  </span>
                </div>
                {s && s.attempts > 0 && (
                  <div className="flex flex-wrap gap-x-3 text-xs text-text-muted">
                    <span>
                      ×<span className="font-mono text-text">{s.attempts}</span> attempts
                    </span>
                    <span>
                      <span className="font-mono text-good">{s.correctMoves}</span> right
                    </span>
                    <span>
                      <span className={`font-mono ${s.wrongMoves > 0 ? 'text-blunder' : ''}`}>
                        {s.wrongMoves}
                      </span>{' '}
                      wrong
                    </span>
                    {accuracy !== null && (
                      <span>
                        Accuracy:{' '}
                        <span
                          className={`font-mono ${accuracy >= 0.9 ? 'text-good' : accuracy < 0.6 ? 'text-blunder' : 'text-text'}`}
                        >
                          {(accuracy * 100).toFixed(0)}%
                        </span>
                      </span>
                    )}
                    {s.perfectCompletions > 0 && (
                      <span>
                        <span className="font-mono text-good">{s.perfectCompletions}</span> perfect
                      </span>
                    )}
                  </div>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function accuracyPct(correct: number, total: number): number | null {
  if (total === 0) return null;
  return correct / total;
}

function ActiveTrainer({
  repertoireId,
  line,
  decorated,
  stats,
  userColor,
  onBackToLines,
  onNextLine,
  onShuffleLine,
  onStatsChanged,
}: {
  repertoireId: string;
  line: RepertoireLine;
  decorated: DecoratedLine;
  stats: RepertoireLineStats | null;
  userColor: 'white' | 'black';
  onBackToLines: () => void;
  onNextLine: () => void;
  onShuffleLine: () => void;
  onStatsChanged: () => void;
}) {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_320px] gap-4 items-start">
      <LineRunner
        key={`${repertoireId}-${decorated.family}-${lineKey(line.uci)}`}
        repertoireId={repertoireId}
        line={line}
        userColor={userColor}
        onStatsChanged={onStatsChanged}
        renderControls={(c) => (
          <RunnerStatusBar
            control={c}
            userColor={userColor}
            onNext={onNextLine}
            onShuffle={onShuffleLine}
            onBackToLines={onBackToLines}
          />
        )}
      />
      <ActiveTrainerAside
        line={line}
        decorated={decorated}
        persistedStats={stats}
        userColor={userColor}
      />
    </div>
  );
}

/**
 * Right-aside on the legacy `/repertoire/:id/lines` page. We can't see
 * the runner's live `ply` / `sessionStats` from here without lifting
 * state up; the legacy page deliberately keeps the aside static (it's
 * the all-time / persisted view). The new practice page surfaces the
 * live "this run" panel directly below the board instead.
 */
function ActiveTrainerAside({
  line,
  decorated,
  persistedStats,
  userColor,
}: {
  line: RepertoireLine;
  decorated: DecoratedLine;
  persistedStats: RepertoireLineStats | null;
  userColor: 'white' | 'black';
}) {
  return (
    <aside className="space-y-3">
      <PersistedStatsPanel
        decorated={decorated}
        persistedStats={persistedStats}
        lineLength={line.uci.length}
      />
      <LineMoves line={line} ply={0} userColor={userColor} />
    </aside>
  );
}


function RunnerStatusBar({
  control,
  userColor,
  onNext,
  onShuffle,
  onBackToLines,
}: {
  control: LineRunnerControlState;
  userColor: 'white' | 'black';
  onNext: () => void;
  onShuffle: () => void;
  onBackToLines: () => void;
}) {
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
    onHint,
    onReveal,
    onPlayReveal,
    onRestart,
  } = control;
  // Same auto-retry + sticky-affordances flow as the practice page:
  // after the first wrong attempt on a line, both Hint and Show-answer
  // stay visible; pre-mistake the row only carries the always-on
  // Hint button.
  const showHintButton = isUserTurn && status === 'thinking' && !hintShown;
  const showRevealButton =
    isUserTurn && status === 'thinking' && mistakeMade && !revealShown;
  const showPlayItButton = revealShown && isUserTurn && status === 'thinking';
  return (
    <div className="card p-3 space-y-2">
      <div className="text-sm min-h-[1.5rem]">
        {status === 'done' ? (
          <span className="text-good">
            Line complete. Nicely done — pick the next one.
          </span>
        ) : !isUserTurn ? (
          <span className="text-text-muted">
            Opponent moves… ({userColor === 'white' ? 'Black' : 'White'} to move)
          </span>
        ) : status === 'thinking' ? (
          <>
            {wrongFlash ? (
              <span className="text-blunder">
                Not your prep here — try again.
              </span>
            ) : (
              <span className="text-text-muted">
                {ply === 0
                  ? `${userColor === 'white' ? 'White' : 'Black'} to move. Play your prep.`
                  : `Your move (${Math.floor(ply / 2) + 1}${ply % 2 === 0 ? '.' : '…'})`}
              </span>
            )}
            {revealShown && expectedSan && (
              <span className="ml-2 text-text-muted">
                · The line goes{' '}
                <span className="font-mono text-good">{expectedSan}</span>.
              </span>
            )}
            {hintShown && !revealShown && expectedSan && (
              <span className="ml-2 text-accent">
                · Hint: move the highlighted piece
              </span>
            )}
          </>
        ) : (
          <span className="text-good">
            {expectedSan && (
              <>
                <span className="font-mono">{expectedSan}</span> — correct.
              </>
            )}
          </span>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        {showHintButton && (
          <button type="button" className="btn text-xs" onClick={onHint}>
            Hint
          </button>
        )}
        {showRevealButton && (
          <button type="button" className="btn text-xs" onClick={onReveal}>
            Show answer
          </button>
        )}
        {showPlayItButton && (
          <button type="button" className="btn text-xs" onClick={onPlayReveal}>
            Play it for me
          </button>
        )}
        <div className="ml-auto flex flex-wrap gap-2">
          <button type="button" className="btn text-xs" onClick={onBackToLines}>
            Pick another line
          </button>
          <button type="button" className="btn text-xs" onClick={onRestart}>
            Restart line
          </button>
          {status === 'done' ? (
            <>
              <button type="button" className="btn text-xs" onClick={onShuffle}>
                Random in opening
              </button>
              <button type="button" className="btn-primary text-xs" onClick={onNext}>
                Next line
              </button>
            </>
          ) : (
            <button type="button" className="btn text-xs" onClick={onNext}>
              Skip line
            </button>
          )}
        </div>
      </div>
      <div className="text-xs text-text-muted">
        {ply} / {totalPly} ply played
      </div>
    </div>
  );
}

/**
 * Persisted (all-time) stats for one repertoire line. Lifted out of
 * the original `RunnerStats` component so the legacy `/lines` page
 * doesn't have to lift state out of the LineRunner — the live "this
 * run" panel that used to live here now belongs to the new practice
 * page (which can read it directly from LineRunner's render-prop).
 */
function PersistedStatsPanel({
  decorated,
  persistedStats,
  lineLength,
}: {
  decorated: DecoratedLine;
  persistedStats: RepertoireLineStats | null;
  lineLength: number;
}) {
  const allAcc =
    persistedStats && persistedStats.movesPlayed > 0
      ? persistedStats.correctMoves / persistedStats.movesPlayed
      : null;
  return (
    <div className="card p-3 text-sm space-y-2">
      <div className="space-y-0.5">
        <div className="text-xs uppercase tracking-wide text-text-muted">
          {decorated.family}
        </div>
        <div className="font-medium truncate">
          {decorated.eco && (
            <span className="font-mono text-xs text-text-muted mr-2">
              {decorated.eco}
            </span>
          )}
          {decorated.variation || 'Line'}
        </div>
        <div className="text-xs text-text-muted">{lineLength} ply</div>
      </div>
      <div className="border-t border-border pt-2 space-y-1">
        <div className="text-xs uppercase tracking-wide text-text-muted">
          All-time on this line
        </div>
        <div className="flex justify-between">
          <span className="text-text-muted">Attempts</span>
          <span className="font-mono">{persistedStats?.attempts ?? 0}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-text-muted">Completions</span>
          <span className="font-mono">
            {persistedStats?.completions ?? 0}
            {persistedStats && persistedStats.perfectCompletions > 0 && (
              <span className="text-good ml-1">
                ({persistedStats.perfectCompletions} perfect)
              </span>
            )}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-text-muted">Right / wrong moves</span>
          <span className="font-mono">
            <span className="text-good">{persistedStats?.correctMoves ?? 0}</span>
            <span className="text-text-muted"> / </span>
            <span className={persistedStats && persistedStats.wrongMoves > 0 ? 'text-blunder' : ''}>
              {persistedStats?.wrongMoves ?? 0}
            </span>
          </span>
        </div>
        {allAcc !== null && (
          <div className="flex justify-between">
            <span className="text-text-muted">Accuracy</span>
            <span
              className={`font-mono ${allAcc >= 0.9 ? 'text-good' : allAcc < 0.6 ? 'text-blunder' : ''}`}
            >
              {(allAcc * 100).toFixed(0)}%
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

function LineMoves({
  line,
  ply,
  userColor,
}: {
  line: RepertoireLine;
  ply: number;
  userColor: 'white' | 'black';
}) {
  return (
    <div className="card p-3 space-y-1">
      <div className="text-xs uppercase tracking-wide text-text-muted">
        Moves
      </div>
      <div className="flex flex-wrap gap-x-2 gap-y-0.5 font-mono text-sm">
        {line.san.map((san, i) => {
          const moveNumber = Math.floor(i / 2) + 1;
          const isWhite = i % 2 === 0;
          const isMine =
            (isWhite && userColor === 'white') ||
            (!isWhite && userColor === 'black');
          const played = i < ply;
          return (
            <span key={i}>
              {isWhite && (
                <span className="text-text-muted mr-0.5">{moveNumber}.</span>
              )}
              <span
                className={`${
                  i === ply
                    ? 'text-accent font-bold underline underline-offset-2'
                    : played
                      ? isMine
                        ? 'text-good'
                        : 'text-text'
                      : 'text-text-muted'
                }`}
              >
                {/* Hide the user's upcoming moves so the move list isn't a
                    cheat sheet. The opponent's upcoming moves stay visible
                    because Black's reply isn't really "spoiler" info. */}
                {played || !isMine ? san : '?'}
              </span>
            </span>
          );
        })}
      </div>
    </div>
  );
}
