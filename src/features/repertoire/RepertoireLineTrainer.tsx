import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, type RepertoireLineStats } from '@/db/schema';
import { Board } from '@/components/Board';
import {
  enumerateLines,
  getLineStatsMap,
  lineKey,
  recordLineAttempt,
  recordLineCompletion,
  recordLineMove,
  type RepertoireLine,
} from './store';
import { identifyOpening } from '@/features/openings/library';

type Status = 'thinking' | 'wrong' | 'right' | 'done';

interface AttemptStats {
  total: number;
  wrong: number;
  hintsUsed: number;
}

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
      <Link to={`/repertoire/${repertoireId}`} className="btn text-xs">
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

const OPPONENT_AUTOPLAY_DELAY_MS = 600;

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
    <LineRunner
      key={`${repertoireId}-${decorated.family}-${lineKey(line.uci)}`}
      repertoireId={repertoireId}
      line={line}
      decorated={decorated}
      stats={stats}
      userColor={userColor}
      onBackToLines={onBackToLines}
      onNextLine={onNextLine}
      onShuffleLine={onShuffleLine}
      onStatsChanged={onStatsChanged}
    />
  );
}

function LineRunner({
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
  // ply = how many moves of `line.uci` have been applied so far. The board
  // shows `line.fens[ply]`. The user is to move when (ply % 2 === 0) ===
  // (userColor === 'white').
  const [ply, setPly] = useState(0);
  const [status, setStatus] = useState<Status>('thinking');
  const [hintShown, setHintShown] = useState(false);
  const [revealShown, setRevealShown] = useState(false);
  const [wrongUci, setWrongUci] = useState<string | null>(null);
  const [sessionStats, setSessionStats] = useState<AttemptStats>({
    total: 0,
    wrong: 0,
    hintsUsed: 0,
  });
  // We mark a single attempt-completion in the persisted stats only once,
  // even if the user clicks "restart" mid-line. `attemptLogged` makes sure
  // `recordLineAttempt` runs once per mount; `completionLogged` makes sure
  // `recordLineCompletion` runs once per actual reach-the-end.
  const attemptLogged = useRef(false);
  const completionLogged = useRef(false);
  const opponentTimer = useRef<number | null>(null);

  // Log the attempt as soon as the trainer mounts on this line.
  useEffect(() => {
    if (attemptLogged.current) return;
    attemptLogged.current = true;
    void recordLineAttempt(repertoireId, line).then(onStatsChanged);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const isUserTurn = useMemo(() => {
    if (ply >= line.uci.length) return false;
    const fen = line.fens[ply];
    const turn = fen.split(' ')[1] === 'w' ? 'white' : 'black';
    return turn === userColor;
  }, [ply, line, userColor]);

  // Auto-advance opponent moves with a small delay so the user can see
  // what just happened. Cleared if the user navigates away mid-line.
  useEffect(() => {
    if (status !== 'thinking') return;
    if (ply >= line.uci.length) {
      setStatus('done');
      if (!completionLogged.current) {
        completionLogged.current = true;
        const perfect =
          sessionStats.wrong === 0 && sessionStats.hintsUsed === 0;
        void recordLineCompletion(repertoireId, line, perfect).then(onStatsChanged);
      }
      return;
    }
    if (!isUserTurn) {
      opponentTimer.current = window.setTimeout(() => {
        setPly((p) => p + 1);
      }, OPPONENT_AUTOPLAY_DELAY_MS);
      return () => {
        if (opponentTimer.current) {
          clearTimeout(opponentTimer.current);
          opponentTimer.current = null;
        }
      };
    }
    // We intentionally exclude `sessionStats`/`onStatsChanged` so completion
    // logic only fires on real ply transitions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ply, isUserTurn, status, line, repertoireId]);

  const expectedUci = line.uci[ply];
  const expectedSan = line.san[ply];
  const expectedFromSquare = expectedUci ? expectedUci.slice(0, 2) : undefined;

  function tryMove(m: {
    from: string;
    to: string;
    promotion?: string;
  }): boolean {
    if (!isUserTurn || status !== 'thinking') return false;
    const played = m.from + m.to + (m.promotion ?? '');
    setSessionStats((s) => ({ ...s, total: s.total + 1 }));
    // Compare ignoring promotion piece — a wrong promotion piece is still
    // technically a valid attempt, so accept any 4-char match.
    if (played.slice(0, 4) === expectedUci.slice(0, 4)) {
      setStatus('right');
      setHintShown(false);
      setRevealShown(false);
      setWrongUci(null);
      void recordLineMove(repertoireId, line, 'correct').then(onStatsChanged);
      window.setTimeout(() => {
        setStatus('thinking');
        setPly((p) => p + 1);
      }, 350);
      return true;
    } else {
      setStatus('wrong');
      setWrongUci(played);
      setSessionStats((s) => ({ ...s, wrong: s.wrong + 1 }));
      void recordLineMove(repertoireId, line, 'wrong').then(onStatsChanged);
      // Tell the Board to snap the piece back to its starting square.
      // Without this, chessground keeps the visually-played piece on
      // its destination and "Try again" leaves it stuck there.
      return false;
    }
  }

  function retry() {
    setStatus('thinking');
    setWrongUci(null);
  }

  function showHint() {
    setHintShown(true);
    setStatus('thinking');
    setWrongUci(null);
    setSessionStats((s) => ({ ...s, hintsUsed: s.hintsUsed + 1 }));
  }

  function reveal() {
    setRevealShown(true);
  }

  function playRevealedMove() {
    if (!expectedUci) return;
    setStatus('right');
    window.setTimeout(() => {
      setStatus('thinking');
      setPly((p) => p + 1);
      setHintShown(false);
      setRevealShown(false);
      setWrongUci(null);
    }, 250);
  }

  function restartLine() {
    completionLogged.current = false;
    setPly(0);
    setStatus('thinking');
    setHintShown(false);
    setRevealShown(false);
    setWrongUci(null);
    setSessionStats({ total: 0, wrong: 0, hintsUsed: 0 });
  }

  const fen = line.fens[Math.min(ply, line.fens.length - 1)];
  const lastUci = ply > 0 ? line.uci[ply - 1] : undefined;

  const highlightSquares =
    hintShown && expectedFromSquare && status === 'thinking'
      ? [{ square: expectedFromSquare, color: 'hint' as const }]
      : status === 'wrong' && wrongUci
        ? [{ square: wrongUci.slice(0, 2), color: 'wrong' as const }]
        : [];

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_320px] gap-4 items-start">
      <div className="space-y-3">
        <Board
          fen={fen}
          orientation={userColor}
          lastMoveUci={lastUci}
          viewOnly={status !== 'thinking' || !isUserTurn}
          onMove={tryMove}
          highlightSquares={highlightSquares}
        />
        <RunnerStatusBar
          status={status}
          isUserTurn={isUserTurn}
          ply={ply}
          totalPly={line.uci.length}
          userColor={userColor}
          expectedSan={expectedSan}
          revealShown={revealShown}
          hintShown={hintShown}
          onRetry={retry}
          onHint={showHint}
          onReveal={reveal}
          onPlayReveal={playRevealedMove}
          onRestart={restartLine}
          onNext={onNextLine}
          onShuffle={onShuffleLine}
          onBackToLines={onBackToLines}
        />
      </div>

      <aside className="space-y-3">
        <RunnerStats
          line={line}
          ply={ply}
          decorated={decorated}
          sessionStats={sessionStats}
          persistedStats={stats}
        />
        <LineMoves line={line} ply={ply} userColor={userColor} />
      </aside>
    </div>
  );
}

function RunnerStatusBar({
  status,
  isUserTurn,
  ply,
  totalPly,
  userColor,
  expectedSan,
  revealShown,
  hintShown,
  onRetry,
  onHint,
  onReveal,
  onPlayReveal,
  onRestart,
  onNext,
  onShuffle,
  onBackToLines,
}: {
  status: Status;
  isUserTurn: boolean;
  ply: number;
  totalPly: number;
  userColor: 'white' | 'black';
  expectedSan: string | undefined;
  revealShown: boolean;
  hintShown: boolean;
  onRetry: () => void;
  onHint: () => void;
  onReveal: () => void;
  onPlayReveal: () => void;
  onRestart: () => void;
  onNext: () => void;
  onShuffle: () => void;
  onBackToLines: () => void;
}) {
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
          <span className="text-text-muted">
            {ply === 0
              ? `${userColor === 'white' ? 'White' : 'Black'} to move. Play your prep.`
              : `Your move (${Math.floor(ply / 2) + 1}${ply % 2 === 0 ? '.' : '…'})`}
            {hintShown && expectedSan && (
              <span className="ml-2 text-accent">
                · Hint: move the highlighted piece
              </span>
            )}
          </span>
        ) : status === 'wrong' ? (
          <span className="text-blunder">
            Not your prep here.
            {revealShown && expectedSan && (
              <>
                {' '}
                The line goes <span className="font-mono text-good">{expectedSan}</span>.
              </>
            )}
          </span>
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
        {status === 'wrong' ? (
          <>
            <button type="button" className="btn-primary text-xs" onClick={onRetry}>
              Try again
            </button>
            {!hintShown && (
              <button type="button" className="btn text-xs" onClick={onHint}>
                Hint
              </button>
            )}
            {!revealShown ? (
              <button type="button" className="btn text-xs" onClick={onReveal}>
                Show answer
              </button>
            ) : (
              <button type="button" className="btn text-xs" onClick={onPlayReveal}>
                Play it for me
              </button>
            )}
          </>
        ) : status === 'thinking' && isUserTurn && !hintShown ? (
          <button type="button" className="btn text-xs" onClick={onHint}>
            Hint
          </button>
        ) : null}
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

function RunnerStats({
  line,
  ply,
  decorated,
  sessionStats,
  persistedStats,
}: {
  line: RepertoireLine;
  ply: number;
  decorated: DecoratedLine;
  sessionStats: AttemptStats;
  persistedStats: RepertoireLineStats | null;
}) {
  const sessAcc =
    sessionStats.total === 0
      ? null
      : 1 - sessionStats.wrong / sessionStats.total;
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
      </div>
      <div className="border-t border-border pt-2 space-y-1">
        <div className="text-xs uppercase tracking-wide text-text-muted">
          This run
        </div>
        <div className="flex justify-between">
          <span className="text-text-muted">Length</span>
          <span className="font-mono">{line.uci.length} ply</span>
        </div>
        <div className="flex justify-between">
          <span className="text-text-muted">Progress</span>
          <span className="font-mono">{ply} / {line.uci.length}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-text-muted">Wrong tries</span>
          <span
            className={`font-mono ${sessionStats.wrong > 0 ? 'text-blunder' : ''}`}
          >
            {sessionStats.wrong}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-text-muted">Hints used</span>
          <span className="font-mono">{sessionStats.hintsUsed}</span>
        </div>
        {sessAcc !== null && (
          <div className="flex justify-between">
            <span className="text-text-muted">Accuracy</span>
            <span
              className={`font-mono ${sessAcc >= 0.9 ? 'text-good' : sessAcc < 0.6 ? 'text-blunder' : ''}`}
            >
              {(sessAcc * 100).toFixed(0)}%
            </span>
          </div>
        )}
      </div>
      <div className="border-t border-border pt-2 space-y-1">
        <div className="text-xs uppercase tracking-wide text-text-muted">
          All-time on this line
        </div>
        <div className="flex justify-between">
          <span className="text-text-muted">Attempts</span>
          <span className="font-mono">
            {persistedStats?.attempts ?? 0}
          </span>
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
