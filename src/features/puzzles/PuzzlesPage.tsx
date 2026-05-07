import { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  db,
  getSettings,
  normalizeTimeClassSelection,
  updateSettings,
  type Motif,
  type Puzzle,
  type TimeClassSelection,
} from '@/db/schema';
import { Board } from '@/components/Board';
import { BoardFrame } from '@/components/BoardFrame';
import { EvalBar } from '@/components/EvalBar';
import { buildSolutionSteps } from '@/components/SolutionPlayer';
import { SolutionControls } from '@/components/SolutionControls';
import { useLiveEval } from '@/features/review/LiveEval';
import { regeneratePuzzles } from './generate';
import { applyPuzzleMove } from './solve';
import { gradeSrs, isDue, newSrsState, summarizeIntervals, type Grade } from '@/srs/sm2';
import { MOTIF_LABEL, MOTIF_ORDER } from '@/engine/motifs';
import { TimeClassChips } from '@/components/TimeClassFilter';
import { gameMatchesSelection } from '@/lib/timeClass';

type Filter = 'due' | 'all' | 'unsolved';

export function PuzzlesPage() {
  const puzzles = useLiveQuery(() => db.puzzles.toArray(), []);
  const [filter, setFilter] = useState<Filter>('due');
  const [motifFilter, setMotifFilter] = useState<Motif | 'all'>('all');
  const [timeClassFilter, setTimeClassFilter] = useState<TimeClassSelection>(['rapid']);
  const [generating, setGenerating] = useState(false);
  const [generateMsg, setGenerateMsg] = useState<string | null>(null);

  useEffect(() => {
    void getSettings().then((s) => {
      setTimeClassFilter(normalizeTimeClassSelection(s.timeClassFilter));
    });
  }, []);

  useEffect(() => {
    // Generate puzzles on first visit if none exist, so the page
    // isn't empty for users who analyzed games before this feature.
    void (async () => {
      if (!puzzles || puzzles.length > 0) return;
      const s = await getSettings();
      setGenerating(true);
      const n = await regeneratePuzzles(s.puzzleMinSwingCp ?? 200);
      setGenerateMsg(n === 0 ? 'No puzzle-worthy mistakes found yet.' : `Generated ${n} puzzles.`);
      setGenerating(false);
    })();
  }, [puzzles]);

  const filtered = useMemo(() => {
    if (!puzzles) return [];
    let list = puzzles.filter((p) => gameMatchesSelection(p, timeClassFilter));
    if (filter === 'due') list = list.filter((p) => isDue(p.srs));
    else if (filter === 'unsolved') list = list.filter((p) => !p.srs || p.srs.reps === 0);
    if (motifFilter !== 'all') list = list.filter((p) => p.motifs.includes(motifFilter));
    return [...list].sort((a, b) => (a.srs?.dueAt ?? 0) - (b.srs?.dueAt ?? 0));
  }, [puzzles, filter, motifFilter, timeClassFilter]);

  const availableMotifs = useMemo(() => {
    if (!puzzles) return [];
    // Only count motifs on puzzles that survive the time-class filter,
    // otherwise the dropdown lists motifs that produce zero results.
    const scoped = puzzles.filter((p) => gameMatchesSelection(p, timeClassFilter));
    const set = new Set<Motif>();
    for (const p of scoped) for (const m of p.motifs) set.add(m);
    return MOTIF_ORDER.filter((m) => set.has(m));
  }, [puzzles, timeClassFilter]);

  const [currentIdx, setCurrentIdx] = useState(0);
  useEffect(() => {
    setCurrentIdx(0);
  }, [filter, motifFilter, timeClassFilter]);

  function onTimeClassChange(next: TimeClassSelection) {
    setTimeClassFilter(next);
    void updateSettings({ timeClassFilter: next });
  }

  const current = filtered[currentIdx];

  async function onGenerate() {
    setGenerating(true);
    setGenerateMsg(null);
    const s = await getSettings();
    const n = await regeneratePuzzles(s.puzzleMinSwingCp ?? 200);
    setGenerateMsg(
      n === 0 ? 'No new puzzles; all candidates already exist.' : `Added ${n} new puzzles.`,
    );
    setGenerating(false);
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Puzzles</h1>
          <p className="text-xs text-text-muted">
            Generated from your own blunders, mistakes, and misses.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {generateMsg && <span className="text-xs text-text-muted">{generateMsg}</span>}
          <button type="button" className="btn text-xs" onClick={onGenerate} disabled={generating}>
            {generating ? 'Generating…' : 'Regenerate'}
          </button>
        </div>
      </div>

      <div className="card p-2 flex flex-wrap gap-2 items-center text-sm">
        <TimeClassChips
          selection={timeClassFilter}
          onChange={onTimeClassChange}
          available={puzzles ?? []}
        />
        <select
          className="input w-auto"
          value={filter}
          onChange={(e) => setFilter(e.target.value as Filter)}
        >
          <option value="due">Due now</option>
          <option value="unsolved">Never solved</option>
          <option value="all">All</option>
        </select>
        <select
          className="input w-auto"
          value={motifFilter}
          onChange={(e) => setMotifFilter(e.target.value as Motif | 'all')}
        >
          <option value="all">All motifs</option>
          {availableMotifs.map((m) => (
            <option key={m} value={m}>
              {MOTIF_LABEL[m]}
            </option>
          ))}
        </select>
        <div className="ml-auto text-text-muted self-center">
          {filtered.length} puzzle{filtered.length === 1 ? '' : 's'}
        </div>
      </div>

      {current ? (
        <PuzzleSolver
          puzzle={current}
          onGraded={() => {
            if (currentIdx + 1 < filtered.length) setCurrentIdx(currentIdx + 1);
          }}
          hasNext={currentIdx + 1 < filtered.length}
        />
      ) : (
        <div className="card p-8 text-center text-text-muted">
          {puzzles && puzzles.length > 0
            ? 'Nothing due. Check back later or switch to "All".'
            : 'No puzzles yet. Import and analyze some games first.'}
        </div>
      )}
    </div>
  );
}

function PuzzleSolver({
  puzzle,
  onGraded,
  hasNext,
}: {
  puzzle: Puzzle;
  onGraded: () => void;
  hasNext: boolean;
}) {
  const [fen, setFen] = useState(puzzle.fen);
  const [solvedIdx, setSolvedIdx] = useState(0);
  const [status, setStatus] = useState<'solving' | 'wrong' | 'solved'>('solving');
  const [attempts, setAttempts] = useState(0);
  const [showSolution, setShowSolution] = useState(false);
  const [lastUci, setLastUci] = useState<string | undefined>(undefined);
  /** Hint-state. `hintShown` controls whether the from-square ring is
   *  visible right now; it auto-clears when the user moves. `hintUsed`
   *  is sticky for the puzzle's lifetime and gates the "Easy" SRS grade
   *  so a hint-assisted solve can't inflate the schedule. */
  const [hintShown, setHintShown] = useState(false);
  const [hintUsed, setHintUsed] = useState(false);
  /** Solution-playback cursor for the "Reveal" simulation. Reused on
   *  the same main board (no second mini-board pops up next to it). */
  const [playbackIdx, setPlaybackIdx] = useState(0);

  // Build the playthrough steps once per puzzle. Cheap (chess.js
  // replay over ~10 moves) so the memo deps are just the puzzle id.
  const solutionSteps = useMemo(
    () => buildSolutionSteps(puzzle.fen, puzzle.solutionUci),
    [puzzle.fen, puzzle.solutionUci],
  );

  useEffect(() => {
    setFen(puzzle.fen);
    setSolvedIdx(0);
    setStatus('solving');
    setAttempts(0);
    setShowSolution(false);
    setLastUci(undefined);
    setHintShown(false);
    setHintUsed(false);
    setPlaybackIdx(0);
  }, [puzzle.id]);

  const solverColor = puzzle.fen.split(' ')[1] === 'w' ? 'white' : 'black';

  // Whichever FEN the board is currently rendering — either the live
  // solving FEN or the playback step's FEN when "Reveal" is on. We
  // declare it here so the live-eval hook below picks up the right
  // value; the same `boardFen` is also fed into the `<Board>` JSX.
  const boardFen = showSolution
    ? solutionSteps[playbackIdx]?.fen ?? fen
    : fen;
  const boardLastUci = showSolution
    ? solutionSteps[playbackIdx]?.uci || undefined
    : lastUci;

  // Live engine eval drives the puzzle's eval bar. Depth 12 is enough
  // for a quick visual cue without burning a queue slot — the puzzle
  // page is solver-paced. Tracks `boardFen` so the bar follows the
  // solution playback instead of freezing on the pre-reveal position.
  const liveEval = useLiveEval(boardFen, 12);

  function onMove(m: { from: string; to: string; promotion?: string }): boolean {
    if (status !== 'solving') return false;
    // Either way, the user has now committed to a move — hide any
    // currently-displayed hint ring. (`hintUsed` stays sticky.)
    setHintShown(false);
    const result = applyPuzzleMove({
      fen,
      solutionUci: puzzle.solutionUci,
      solvedIdx,
      move: m,
    });
    if (result.kind === 'rejected') {
      if (result.reason === 'no-expected') return false;
      // Treat both 'wrong-move' and 'illegal' as a wrong attempt so the
      // user gets the wrong-state UI (Retry / Hint / Reveal) and an
      // attempt counter bump.
      setAttempts((n) => n + 1);
      setStatus('wrong');
      return false;
    }
    setFen(result.fen);
    setLastUci(result.lastUci);
    setSolvedIdx(result.nextSolvedIdx);
    if (result.solved) setStatus('solved');
    return true;
  }

  async function grade(grade: Grade) {
    const newState = gradeSrs(puzzle.srs ?? newSrsState(), grade);
    await db.puzzles.update(puzzle.id, { srs: newState });
    if (hasNext) onGraded();
  }

  /**
   * "Try again" after a wrong attempt. Crucially, this does NOT reset
   * `fen` / `solvedIdx` / `lastUci` — those still hold the LAST
   * ACCEPTED state of the line (a wrong attempt is rejected by
   * `applyPuzzleMove` before any of them advance), so resuming from
   * here means the user picks up exactly where their first mistake
   * was without having to replay every correctly-played move that
   * came before it.
   *
   * Previously this function snapped back to `puzzle.fen` + `solvedIdx
   * = 0`, which was the source of the "ugh, now I have to redo the
   * whole line just because I messed up move 3" complaint.
   */
  function retry() {
    setStatus('solving');
    setHintShown(false);
  }

  /**
   * "Restart" — full reset back to the puzzle's starting position.
   * Distinct from `retry()` because some users prefer to redo the
   * whole line when a wrong move pops up (e.g. they want a fresh look
   * at the position rather than picking up where they slipped).
   * Kept around as a secondary action in the wrong / solving states.
   */
  function restart() {
    setFen(puzzle.fen);
    setSolvedIdx(0);
    setStatus('solving');
    setLastUci(undefined);
    setHintShown(false);
  }

  function showHint() {
    setHintShown(true);
    setHintUsed(true);
    // The 'wrong' state stops the user from interacting with the board.
    // Returning to 'solving' (without resetting fen / solvedIdx, since
    // a wrong attempt never advances them) lets them act on the hint.
    if (status === 'wrong') setStatus('solving');
  }

  function revealAndFail() {
    setShowSolution(true);
    setStatus('wrong');
    setHintShown(false);
    // Park the playback cursor at the END of the line so the board
    // shows the final position of the solution by default — that's
    // what most "Reveal" interactions are after ("just show me what
    // the engine wanted"). User can scrub back with prev/next.
    setPlaybackIdx(Math.max(0, solutionSteps.length - 1));
  }

  // Highlight the from-square of the next expected move when the user
  // asks for a hint. Cleared the moment a move is attempted (see onMove).
  const nextExpected = puzzle.solutionUci[solvedIdx];
  const hintSquares =
    hintShown && status === 'solving' && nextExpected
      ? [{ square: nextExpected.slice(0, 2), color: 'hint' as const }]
      : [];

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_320px] gap-4 items-start">
      <div className="space-y-2">
        {/* Primary board sized via the canonical `<BoardFrame>` so it
            matches Review / Cards / Lines / Openings exactly. The
            `viewportClampPx` keeps the solver chrome (status row +
            action buttons) on-screen on short windows — that's
            puzzle-specific, the other surfaces don't need it. */}
        <BoardFrame
          viewportClampPx={220}
          evalBar={
            <EvalBar
              cpWhite={liveEval?.cpWhite ?? null}
              mate={liveEval?.mate}
              orientation={solverColor}
            />
          }
          board={
            <Board
              fen={boardFen}
              orientation={solverColor}
              lastMoveUci={boardLastUci}
              viewOnly={showSolution || status === 'solved' || status === 'wrong'}
              onMove={(m) => onMove(m)}
              highlightSquares={showSolution ? [] : hintSquares}
            />
          }
        />
        {showSolution && (
          <SolutionControls
            steps={solutionSteps}
            idx={playbackIdx}
            onIdxChange={setPlaybackIdx}
            onClose={() => setShowSolution(false)}
            title="Solution playthrough"
          />
        )}
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="text-sm min-h-[1.25rem]">
            {status === 'solving' && (
              <span className="text-text-muted">
                {solverColor === 'white' ? 'White' : 'Black'} to move. Find the best line.
                {hintShown && (
                  <span className="ml-2 text-accent">· Hint: move the highlighted piece</span>
                )}
                {attempts > 0 && <span className="text-blunder"> · {attempts} wrong so far</span>}
              </span>
            )}
            {status === 'wrong' && (
              <span className="text-blunder">
                Not quite.{' '}
                {showSolution
                  ? 'Full solution shown on the right.'
                  : solvedIdx > 0
                    ? "Try again from here \u2014 your earlier moves are kept."
                    : 'Try again, hint, or reveal.'}
              </span>
            )}
            {status === 'solved' && (
              <span className="text-good">
                Solved!
                {hintUsed && (
                  <span className="ml-2 text-text-muted text-xs">(with a hint)</span>
                )}
              </span>
            )}
          </div>
          <div className="flex gap-1">
            {status === 'wrong' && !showSolution && (
              <button
                type="button"
                className="btn-primary text-xs"
                onClick={retry}
                title={
                  solvedIdx > 0
                    ? 'Try again from your last correct move'
                    : 'Try again from the puzzle start'
                }
              >
                Try again
              </button>
            )}
            {(status === 'solving' || (status === 'wrong' && !showSolution)) && !hintShown && (
              <button type="button" className="btn text-xs" onClick={showHint}>
                Hint
              </button>
            )}
            {status === 'wrong' && !showSolution && (
              <button type="button" className="btn text-xs" onClick={revealAndFail}>
                Reveal
              </button>
            )}
            {/* "Restart" is a secondary, less-prominent action so the
                primary affordance is "keep going from here" — only
                surface it once the user has actually played a move
                they'd be throwing away (i.e. solvedIdx > 0). */}
            {(status === 'wrong' || status === 'solving') &&
              !showSolution &&
              solvedIdx > 0 && (
                <button
                  type="button"
                  className="btn text-xs text-text-muted"
                  onClick={restart}
                  title="Restart the puzzle from the beginning"
                >
                  Restart
                </button>
              )}
          </div>
        </div>
      </div>

      <aside className="space-y-3">
        <div className="card p-3 space-y-2 text-sm">
          <div className="flex justify-between items-baseline">
            <div className="text-xs uppercase tracking-wide text-text-muted">Source</div>
            <div className="text-xs text-text-muted">swing {(puzzle.swingCp / 100).toFixed(1)}</div>
          </div>
          <div>
            vs <span className="font-medium">{puzzle.opponent}</span>
          </div>
          <div className="flex flex-wrap gap-1">
            {puzzle.motifs.map((m) => (
              <span
                key={m}
                className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-bg-raised text-text-muted"
              >
                {MOTIF_LABEL[m]}
              </span>
            ))}
          </div>
          <div className="text-xs text-text-muted">
            {puzzle.srs
              ? `Due every ${summarizeIntervals(puzzle.srs.intervalDays)}, ease ${puzzle.srs.ease.toFixed(2)}, ${puzzle.srs.lapses} lapses`
              : 'Never reviewed.'}
          </div>
        </div>

        {status === 'solved' && !showSolution && (
          <div className="card p-3 space-y-1 text-sm">
            <div className="text-xs uppercase tracking-wide text-text-muted">Solution</div>
            <div className="font-mono text-text">
              {puzzle.solutionSan.map((s, i) => (
                <span
                  key={i}
                  className={i % 2 === 0 ? 'text-good' : 'text-text-muted'}
                >
                  {s}
                  {i < puzzle.solutionSan.length - 1 ? ' ' : ''}
                </span>
              ))}
            </div>
            <button
              type="button"
              className="btn text-xs w-full"
              onClick={() => {
                setShowSolution(true);
                setPlaybackIdx(0);
              }}
            >
              Replay step-by-step
            </button>
          </div>
        )}

        {/* SRS grading is only meaningful when the user finished the
            puzzle's solution. Showing it after a wrong move would just
            tempt the user to grade themselves "Easy" on a missed puzzle.
            "Reveal" still routes through the wrong-state path, so on
            reveal we surface a single "Mark again" button below for
            scheduling, without offering Hard/Good/Easy. */}
        {status === 'solved' && (
          <div className="card p-3 space-y-2">
            <div className="text-xs uppercase tracking-wide text-text-muted">How well did you know it?</div>
            <div className={`grid gap-2 ${hintUsed ? 'grid-cols-3' : 'grid-cols-2'}`}>
              <GradeButton label="Again" grade="again" onGrade={grade} tone="bad" />
              <GradeButton label="Hard" grade="hard" onGrade={grade} />
              <GradeButton label="Good" grade="good" onGrade={grade} />
              {!hintUsed && (
                <GradeButton label="Easy" grade="easy" onGrade={grade} tone="good" />
              )}
            </div>
            {hintUsed && (
              <div className="text-[11px] text-text-muted">
                &ldquo;Easy&rdquo; is hidden because you used a hint.
              </div>
            )}
          </div>
        )}
        {status === 'wrong' && showSolution && (
          <div className="card p-3 space-y-2">
            <div className="text-xs uppercase tracking-wide text-text-muted">
              Lapse logged
            </div>
            <div className="text-xs text-text-muted">
              You revealed the answer, so this puzzle gets re-queued for
              another go soon.
            </div>
            <button
              type="button"
              className="btn border-blunder/40 text-blunder hover:bg-blunder/10 w-full"
              onClick={() => grade('again')}
            >
              Schedule again
            </button>
          </div>
        )}
      </aside>
    </div>
  );
}

function GradeButton({
  label,
  grade,
  onGrade,
  tone,
}: {
  label: string;
  grade: Grade;
  onGrade: (g: Grade) => void;
  tone?: 'good' | 'bad';
}) {
  const cls =
    tone === 'good'
      ? 'border-good/40 text-good hover:bg-good/10'
      : tone === 'bad'
        ? 'border-blunder/40 text-blunder hover:bg-blunder/10'
        : '';
  return (
    <button type="button" onClick={() => onGrade(grade)} className={`btn ${cls}`}>
      {label}
    </button>
  );
}
