import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
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
import { EvalBar, mateForWhite } from '@/components/EvalBar';
import { buildSolutionSteps } from '@/components/SolutionPlayer';
import { SolutionControls } from '@/components/SolutionControls';
import { useLiveEval } from '@/features/review/LiveEval';
import { regeneratePuzzles } from './generate';
import { applyPuzzleMove } from './solve';
import { PUZZLE_REPLY_DELAY_MS, sampleDelay } from '@/lib/humanTiming';
import { gradeSrs, isDue, newSrsState, summarizeIntervals, type Grade } from '@/srs/sm2';
import { MOTIF_ORDER } from '@/engine/motifs';
import { tMotifLabel } from '@/i18n/chess';
import { TimeClassChips } from '@/components/TimeClassFilter';
import { gameMatchesSelection } from '@/lib/timeClass';

type Filter = 'due' | 'all' | 'unsolved';

export function PuzzlesPage() {
  const { t } = useTranslation();
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
      setGenerateMsg(n === 0 ? t('puzzles.noMistakesFound') : t('puzzles.generated', { count: n }));
      setGenerating(false);
    })();
  }, [puzzles, t]);

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
      n === 0 ? t('puzzles.noNew') : t('puzzles.added', { count: n }),
    );
    setGenerating(false);
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{t('puzzles.title')}</h1>
          <p className="text-xs text-text-muted">{t('puzzles.subtitle')}</p>
        </div>
        <div className="flex items-center gap-3">
          {generateMsg && <span className="text-xs text-text-muted">{generateMsg}</span>}
          <button type="button" className="btn text-xs" onClick={onGenerate} disabled={generating}>
            {generating ? t('puzzles.generating') : t('puzzles.regenerate')}
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
          <option value="due">{t('puzzles.filters.dueNow')}</option>
          <option value="unsolved">{t('puzzles.filters.neverSolved')}</option>
          <option value="all">{t('puzzles.filters.all')}</option>
        </select>
        <select
          className="input w-auto"
          value={motifFilter}
          onChange={(e) => setMotifFilter(e.target.value as Motif | 'all')}
        >
          <option value="all">{t('puzzles.filters.allMotifs')}</option>
          {availableMotifs.map((m) => (
            <option key={m} value={m}>
              {tMotifLabel(t, m)}
            </option>
          ))}
        </select>
        <div className="ml-auto text-text-muted self-center">
          {t('puzzles.count', { count: filtered.length })}
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
          {puzzles && puzzles.length > 0 ? t('puzzles.nothingDue') : t('puzzles.noneYet')}
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
  const { t } = useTranslation();
  const [fen, setFen] = useState(puzzle.fen);
  const [solvedIdx, setSolvedIdx] = useState(0);
  /** Status drives `viewOnly` on the board. We collapse the old
   *  "wrong → click try-again" two-step flow into a single state:
   *  a wrong attempt no longer locks the board into a `'wrong'` state
   *  with a Try-again button. Instead it bumps `attempts`, flips a
   *  short-lived `mistakeFlash` for the status-row copy, and leaves
   *  the user back in `'solving'` so they can immediately try again
   *  on the same board. The only path that still uses `'wrong'` is
   *  the "Reveal" route below — the user has explicitly given up, so
   *  the board goes view-only and the solution playback takes over.
   */
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
  /** Sticky for the puzzle's lifetime: once the user has made any
   *  wrong attempt, surface the "Hint" + "Reveal" buttons alongside the
   *  status row from then on, even after they go on to play correct
   *  moves. Lets the user fall back to a hint or reveal at any later
   *  point in the same line without having to deliberately make
   *  another mistake first. */
  const [mistakeMade, setMistakeMade] = useState(false);
  /** Solution-playback cursor for the "Reveal" simulation. Reused on
   *  the same main board (no second mini-board pops up next to it). */
  const [playbackIdx, setPlaybackIdx] = useState(0);
  /** Pending opponent-reply timer. We commit the user's move immediately
   *  for instant feedback, then schedule the auto-played reply on a
   *  human-feeling delay (`PUZZLE_REPLY_DELAY_MS`) so the position
   *  doesn't jump two plies in one frame. The timer is captured in a
   *  ref so unmount / restart / reveal can cancel it cleanly — without
   *  this, navigating to the next puzzle while a reply is queued would
   *  fire the reply onto the new puzzle's position and stomp `fen`. */
  const replyTimerRef = useRef<number | null>(null);
  /** Whether the user is currently locked out of moving while we wait
   *  for the queued opponent reply to land. Mirrors the timer's
   *  presence — exposed as state so the Board can flip into a
   *  read-only `viewOnly` mode for the ~700 ms gap. */
  const [awaitingReply, setAwaitingReply] = useState(false);

  // Build the playthrough steps once per puzzle. Cheap (chess.js
  // replay over ~10 moves) so the memo deps are just the puzzle id.
  const solutionSteps = useMemo(
    () => buildSolutionSteps(puzzle.fen, puzzle.solutionUci),
    [puzzle.fen, puzzle.solutionUci],
  );

  /** Cancel any in-flight opponent-reply timer. Idempotent. Called
   *  before navigating to a new puzzle, on restart, on reveal, and on
   *  unmount so a queued reply can't fire onto the next puzzle's
   *  position. */
  const cancelPendingReply = () => {
    if (replyTimerRef.current != null) {
      window.clearTimeout(replyTimerRef.current);
      replyTimerRef.current = null;
    }
    setAwaitingReply(false);
  };

  useEffect(() => {
    cancelPendingReply();
    setFen(puzzle.fen);
    setSolvedIdx(0);
    setStatus('solving');
    setAttempts(0);
    setShowSolution(false);
    setLastUci(undefined);
    setHintShown(false);
    setHintUsed(false);
    setMistakeMade(false);
    setPlaybackIdx(0);
  }, [puzzle.id]);

  // Cleanup on unmount: cancel any dangling reply timer.
  useEffect(() => {
    return () => {
      if (replyTimerRef.current != null) {
        window.clearTimeout(replyTimerRef.current);
        replyTimerRef.current = null;
      }
    };
  }, []);

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
    // Lock out further input while we're animating an opponent reply.
    // Without this, a fast user could drag a second move during the
    // ~700 ms gap and either double-stomp the position or have their
    // input swallowed when the reply finally lands.
    if (awaitingReply) return false;
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
      // Wrong attempt: bump the counter and unlock the always-on Hint
      // + Reveal buttons via `mistakeMade`, but DON'T switch into a
      // `'wrong'` state. The board's previous accepted FEN /
      // `solvedIdx` are untouched (chessground already snapped the
      // wrong piece back via the `Board onMove → false` revert), so
      // the user is effectively in "try again from your last correct
      // move" state on the next click — exactly what the old
      // Try-again button did, just without the click. Reveal is the
      // only path that still flips into the locked `'wrong'` state
      // (see `revealAndFail` below).
      setAttempts((n) => n + 1);
      setMistakeMade(true);
      return false;
    }
    // Two-phase commit when the line has an auto-played opponent reply
    // queued: render the user's move now (instant feedback, board is
    // visually responsive), then schedule the reply on a short
    // human-feeling delay so the puzzle plays like a real game rather
    // than two pieces moving on the same frame. When the user's move
    // *was* the final move (no reply queued), `userOnly` is undefined
    // and we fall straight through to the single-phase commit.
    if (result.userOnly) {
      setFen(result.userOnly.fen);
      setLastUci(result.userOnly.lastUci);
      setSolvedIdx(result.userOnly.nextSolvedIdx);
      setAwaitingReply(true);
      const delay = sampleDelay(PUZZLE_REPLY_DELAY_MS);
      // Capture the values we need so a stale closure can't fire onto
      // a different puzzle / position if the user navigates fast.
      const finalFen = result.fen;
      const finalUci = result.lastUci;
      const finalIdx = result.nextSolvedIdx;
      const finalSolved = result.solved;
      replyTimerRef.current = window.setTimeout(() => {
        replyTimerRef.current = null;
        setFen(finalFen);
        setLastUci(finalUci);
        setSolvedIdx(finalIdx);
        setAwaitingReply(false);
        if (finalSolved) setStatus('solved');
      }, delay);
      return true;
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
   * "Restart" — full reset back to the puzzle's starting position.
   * Surface this as a secondary action once the user has played at
   * least one correct move they'd be throwing away, so the primary
   * affordance stays "keep solving from here". Restart also clears
   * the wrong-attempt counter so the user gets a clean slate.
   */
  function restart() {
    cancelPendingReply();
    setFen(puzzle.fen);
    setSolvedIdx(0);
    setStatus('solving');
    setLastUci(undefined);
    setHintShown(false);
    setAttempts(0);
  }

  function showHint() {
    setHintShown(true);
    setHintUsed(true);
  }

  function revealAndFail() {
    cancelPendingReply();
    setShowSolution(true);
    setStatus('wrong');
    setHintShown(false);
    // Park the playback cursor at the START of the line so the user
    // sees the puzzle's opening position and can step through the
    // solution move-by-move via prev/next. Showing the final position
    // up-front skips past the moves the user actually wanted to learn.
    setPlaybackIdx(0);
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
              // Convert STM-perspective `scoreMate` from the engine
              // into White-perspective so the bar fill stays anchored
              // to the winning colour as the turn flips. See the
              // EvalBar prop docs for why.
              mate={mateForWhite(liveEval?.mate, boardFen)}
              orientation={solverColor}
            />
          }
          board={
            <Board
              sounds
              fen={boardFen}
              orientation={solverColor}
              lastMoveUci={boardLastUci}
              viewOnly={
                showSolution ||
                status === 'solved' ||
                status === 'wrong' ||
                awaitingReply
              }
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
            title={t('puzzles.solver.solutionPlaythrough')}
          />
        )}
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="text-sm min-h-[1.25rem]">
            {status === 'solving' && (
              <span className="text-text-muted">
                {/* When the user has at least one wrong attempt under
                    their belt, lead with the wrong-attempt callout so
                    the eye lands on it; otherwise show the neutral
                    prompt. The board is already back in the last
                    accepted state so the implicit "try again" is
                    immediate (no Try-again button needed). */}
                {attempts > 0 ? (
                  <>
                    <span className="text-blunder">
                      {t('puzzles.solver.notQuite')}
                      {solvedIdx > 0 ? t('puzzles.solver.fromHere') : '.'}
                    </span>
                    <span className="ml-2">
                      {t('puzzles.solver.wrongCount', { count: attempts })}
                    </span>
                  </>
                ) : (
                  <>{t('puzzles.solver.toMove', { color: solverColor === 'white' ? t('common.white') : t('common.black') })}</>
                )}
                {hintShown && (
                  <span className="ml-2 text-accent">{t('puzzles.solver.hint')}</span>
                )}
              </span>
            )}
            {status === 'wrong' && (
              <span className="text-blunder">{t('puzzles.solver.wrongFull')}</span>
            )}
            {status === 'solved' && (
              <span className="text-good">
                {t('puzzles.solver.solved')}
                {hintUsed && (
                  <span className="ml-2 text-text-muted text-xs">{t('puzzles.solver.withHint')}</span>
                )}
              </span>
            )}
          </div>
          <div className="flex gap-1">
            {/* Hint + Reveal are surfaced any time the user has made
                at least one wrong attempt, even after they've gone on
                to play correct moves on the same line — the user
                explicitly asked for "from that point on have the
                reveal button and the hint button always show".
                Pre-mistake we keep the action row clean (Hint only,
                no Reveal) so the puzzle starts as a low-pressure
                solve-or-step-on-it. */}
            {status === 'solving' && !hintShown && (
              <button type="button" className="btn text-xs" onClick={showHint}>
                {t('puzzles.solver.hint_btn')}
              </button>
            )}
            {status === 'solving' && mistakeMade && (
              <button type="button" className="btn text-xs" onClick={revealAndFail}>
                {t('puzzles.solver.reveal')}
              </button>
            )}
            {/* "Restart" is a secondary, less-prominent action so the
                primary affordance is "keep going from here" — only
                surface it once the user has actually played a move
                they'd be throwing away (i.e. solvedIdx > 0). */}
            {status === 'solving' && solvedIdx > 0 && (
              <button
                type="button"
                className="btn text-xs text-text-muted"
                onClick={restart}
                title={t('puzzles.solver.restartTitle')}
              >
                {t('puzzles.solver.restart')}
              </button>
            )}
          </div>
        </div>
      </div>

      <aside className="space-y-3">
        <div className="card p-3 space-y-2 text-sm">
          <div className="flex justify-between items-baseline">
            <div className="text-xs uppercase tracking-wide text-text-muted">{t('puzzles.solver.source')}</div>
            <div className="text-xs text-text-muted">{t('puzzles.solver.swing', { value: (puzzle.swingCp / 100).toFixed(1) })}</div>
          </div>
          <div>
            {t('puzzles.solver.vs')} <span className="font-medium">{puzzle.opponent}</span>
          </div>
          <div className="flex flex-wrap gap-1">
            {puzzle.motifs.map((m) => (
              <span
                key={m}
                className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-bg-raised text-text-muted"
              >
                {tMotifLabel(t, m)}
              </span>
            ))}
          </div>
          <div className="text-xs text-text-muted">
            {puzzle.srs
              ? t('puzzles.solver.dueEvery', { intervals: summarizeIntervals(puzzle.srs.intervalDays), ease: puzzle.srs.ease.toFixed(2), lapses: puzzle.srs.lapses })
              : t('puzzles.solver.neverReviewed')}
          </div>
        </div>

        {status === 'solved' && !showSolution && (
          <div className="card p-3 space-y-1 text-sm">
            <div className="text-xs uppercase tracking-wide text-text-muted">{t('puzzles.solver.solution')}</div>
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
              {t('puzzles.solver.replayStepByStep')}
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
            <div className="text-xs uppercase tracking-wide text-text-muted">{t('puzzles.solver.howWell')}</div>
            <div className={`grid gap-2 ${hintUsed ? 'grid-cols-3' : 'grid-cols-2'}`}>
              <GradeButton label={t('puzzles.solver.again')} grade="again" onGrade={grade} tone="bad" />
              <GradeButton label={t('puzzles.solver.hard')} grade="hard" onGrade={grade} />
              <GradeButton label={t('puzzles.solver.good')} grade="good" onGrade={grade} />
              {!hintUsed && (
                <GradeButton label={t('puzzles.solver.easy')} grade="easy" onGrade={grade} tone="good" />
              )}
            </div>
            {hintUsed && (
              <div className="text-[11px] text-text-muted">
                {t('puzzles.solver.easyHidden')}
              </div>
            )}
          </div>
        )}
        {status === 'wrong' && showSolution && (
          <div className="card p-3 space-y-2">
            <div className="text-xs uppercase tracking-wide text-text-muted">
              {t('puzzles.solver.lapseLogged')}
            </div>
            <div className="text-xs text-text-muted">
              {t('puzzles.solver.lapseDesc')}
            </div>
            <button
              type="button"
              className="btn border-blunder/40 text-blunder hover:bg-blunder/10 w-full"
              onClick={() => grade('again')}
            >
              {t('puzzles.solver.scheduleAgain')}
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
