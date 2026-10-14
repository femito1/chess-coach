import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Board } from '@/components/Board';
import { BoardFrame } from '@/components/BoardFrame';
import { EvalBar, mateForWhite } from '@/components/EvalBar';
import { buildSolutionSteps } from '@/components/SolutionPlayer';
import { SolutionControls } from '@/components/SolutionControls';
import { useLiveEval } from '@/features/review/LiveEval';
import { PUZZLE_REPLY_DELAY_MS, sampleDelay } from '@/lib/humanTiming';
import { applyPuzzleMove } from './solve';
import type { PuzzleOutcome } from '@/db/schema';
import type { LibraryPuzzle } from './corpus';
import { formatThemeName } from './themeLabels';

/**
 * Solver for one puzzle from the bundled Lichess corpus.
 *
 * Board mechanics are carried over from the previous
 * generated-from-your-games solver, which had been tuned over several
 * rounds and works well: two-phase commit on the opponent's reply so the
 * position never jumps two plies in a frame, a hint ring that clears on the
 * next attempt, and reveal-with-step-through playback. `applyPuzzleMove`
 * needed no changes at all — it's generic over `(fen, solution, solvedIdx)`.
 *
 * What's different from the old solver:
 *
 *  - **No self-grading.** The old page asked "how well did you know it?"
 *    and fed an SM-2 schedule. With a 191k-puzzle corpus, spaced repetition
 *    of individual puzzles is the wrong model — there's always fresh
 *    material, and grading every puzzle is friction on the main loop. The
 *    outcome is now inferred (solved cleanly / with a hint / revealed) and
 *    recorded automatically, and the primary action is just "next".
 *
 *  - **Themes are hidden until solved.** See `Rail` below — this is the
 *    load-bearing UX rule of the whole page.
 */

export interface SolveOutcome {
  puzzle: LibraryPuzzle;
  /** `clean` = no wrong move, no hint, no reveal. */
  outcome: PuzzleOutcome;
  /** Correct / wrong solver moves over the whole attempt, restarts included. */
  good: number;
  bad: number;
  msTaken: number;
}

/** What the rail shows about the run in progress. */
export interface SessionInfo {
  /** Outcomes so far this session, oldest first. */
  results: PuzzleOutcome[];
  /** Position label when the run has a fixed length ("3 / 8" in Review). */
  position?: string;
}

/**
 * Vertical space (px) the page chrome needs, so `BoardFrame` can clamp the
 * board to what's actually left of the viewport.
 *
 * The board is sized off `100vh - clamp`, so this has to cover everything
 * above and below it or the board runs off the bottom of the screen and takes
 * the status row with it. Re-measured at 1440x900 for the 2026-10 layout
 * (view tabs + Train bar in place of the old tab bar): board top at 261 px,
 * status row ending at ~875 — inside the fold with 280.
 *
 * The old solver passed 220, which was right for a page with no tab bar; with
 * one, the board overflowed by ~70 px and pushed the whole action row under
 * the fold.
 */
export const BOARD_CLAMP_PX = 280;

/** Extra reserve when the one-line "From your games" summary sits between the
 *  Train bar and the board. */
export const BOARD_CLAMP_WITH_SUMMARY_PX = 310;

export function LibraryPuzzleSolver({
  puzzle,
  session,
  ratingChange,
  unratedNote,
  sessionNote,
  boardClampPx = BOARD_CLAMP_PX,
  onDone,
  onNext,
  hasNext,
  nextLabel,
}: {
  puzzle: LibraryPuzzle;
  session: SessionInfo;
  /** The user's puzzle rating before → after this puzzle, once recorded.
   *  Absent while solving, and for attempts that don't count (retries). */
  ratingChange?: { from: number; to: number };
  /** Shown after finishing when the attempt didn't count toward the rating
   *  — a retry from Review or the history grid. */
  unratedNote?: string;
  /** Session-level context line, e.g. what Recommended matched on. Shown
   *  once under the board — never per-puzzle theme info. */
  sessionNote?: string;
  /** Vertical space to reserve for page chrome. See `BOARD_CLAMP_PX`. */
  boardClampPx?: number;
  onDone: (outcome: SolveOutcome) => void;
  onNext: () => void;
  hasNext: boolean;
  /** Overrides the "Next puzzle" label, e.g. "Finish review". */
  nextLabel?: string;
}) {
  const { t } = useTranslation();
  const [fen, setFen] = useState(puzzle.fen);
  const [solvedIdx, setSolvedIdx] = useState(0);
  const [status, setStatus] = useState<'solving' | 'revealed' | 'solved'>('solving');
  const [attempts, setAttempts] = useState(0);
  const [showSolution, setShowSolution] = useState(false);
  const [lastUci, setLastUci] = useState<string | undefined>(undefined);
  const [hintShown, setHintShown] = useState(false);
  const [hintUsed, setHintUsed] = useState(false);
  const [mistakeMade, setMistakeMade] = useState(false);
  const [playbackIdx, setPlaybackIdx] = useState(0);
  const replyTimerRef = useRef<number | null>(null);
  const [awaitingReply, setAwaitingReply] = useState(false);
  const startedAtRef = useRef<number>(Date.now());
  /** Move tallies for the whole attempt. Refs, not state, because the
   *  reply timer reads them from a stale closure — and deliberately NOT
   *  reset by `restart()`: restarting after a wrong move must not launder
   *  the attempt into a clean solve. (It used to: `clean` was computed
   *  from the per-try counter `restart()` zeroes.) */
  const goodRef = useRef(0);
  const badRef = useRef(0);
  /** Guards against double-reporting the same puzzle — the two-phase
   *  reply timer means `solved` can be reached from a callback, and a
   *  reveal after a solve must not re-report. */
  const reportedRef = useRef(false);

  const solutionSteps = useMemo(
    () => buildSolutionSteps(puzzle.fen, puzzle.solution),
    [puzzle.fen, puzzle.solution],
  );

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
    startedAtRef.current = Date.now();
    goodRef.current = 0;
    badRef.current = 0;
    reportedRef.current = false;
  }, [puzzle.id]);

  useEffect(() => {
    return () => {
      if (replyTimerRef.current != null) {
        window.clearTimeout(replyTimerRef.current);
        replyTimerRef.current = null;
      }
    };
  }, []);

  const solverColor = puzzle.fen.split(' ')[1] === 'w' ? 'white' : 'black';

  const boardFen = showSolution ? (solutionSteps[playbackIdx]?.fen ?? fen) : fen;
  const boardLastUci = showSolution
    ? solutionSteps[playbackIdx]?.uci || undefined
    : lastUci;

  const finished = status === 'solved' || status === 'revealed';

  // No engine until the puzzle is over. Its read of the position being
  // solved is the answer in another form — "M2" on the bar says "mate in 2"
  // as plainly as the hidden `mateIn2` theme would (see `Rail`), and even a
  // bar slammed to one side says "there is a mate". The bar stays in place,
  // neutral, so the board doesn't resize when it comes alive.
  const liveEval = useLiveEval(finished ? boardFen : '', 12);

  /** Report the outcome exactly once per puzzle. `usedHint` is passed
   *  explicitly because callers may fire from inside a `setTimeout`
   *  closure where the state value is stale; the move tallies are refs. */
  function report(opts: { usedHint: boolean; revealed: boolean }) {
    if (reportedRef.current) return;
    reportedRef.current = true;
    const outcome: PuzzleOutcome = opts.revealed
      ? 'revealed'
      : opts.usedHint
        ? 'hint'
        : badRef.current > 0
          ? 'mistake'
          : 'clean';
    onDone({
      puzzle,
      outcome,
      good: goodRef.current,
      bad: badRef.current,
      msTaken: Date.now() - startedAtRef.current,
    });
  }

  function onMove(m: { from: string; to: string; promotion?: string }): boolean {
    if (status !== 'solving') return false;
    if (awaitingReply) return false;
    setHintShown(false);
    const result = applyPuzzleMove({
      fen,
      solutionUci: puzzle.solution,
      solvedIdx,
      move: m,
    });
    if (result.kind === 'rejected') {
      if (result.reason === 'no-expected') return false;
      badRef.current++;
      setAttempts((n) => n + 1);
      setMistakeMade(true);
      return false;
    }

    goodRef.current++;
    if (result.userOnly) {
      setFen(result.userOnly.fen);
      setLastUci(result.userOnly.lastUci);
      setSolvedIdx(result.userOnly.nextSolvedIdx);
      setAwaitingReply(true);
      const delay = sampleDelay(PUZZLE_REPLY_DELAY_MS);
      const finalFen = result.fen;
      const finalUci = result.lastUci;
      const finalIdx = result.nextSolvedIdx;
      const finalSolved = result.solved;
      // Snapshot now — by the time the timer fires, reading `hintUsed`
      // would close over a stale value.
      const hintAtCommit = hintUsed;
      replyTimerRef.current = window.setTimeout(() => {
        replyTimerRef.current = null;
        setFen(finalFen);
        setLastUci(finalUci);
        setSolvedIdx(finalIdx);
        setAwaitingReply(false);
        // A hint is for the move it was asked on; the reply moves on.
        setHintShown(false);
        if (finalSolved) {
          setStatus('solved');
          report({ usedHint: hintAtCommit, revealed: false });
        }
      }, delay);
      return true;
    }

    setFen(result.fen);
    setLastUci(result.lastUci);
    setSolvedIdx(result.nextSolvedIdx);
    if (result.solved) {
      setStatus('solved');
      report({ usedHint: hintUsed, revealed: false });
    }
    return true;
  }

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
    // While the reply is pending, `solvedIdx` already points at the
    // opponent's move: a hint now would ring *their* piece, and still mark
    // the attempt as hinted.
    if (awaitingReply) return;
    setHintShown(true);
    setHintUsed(true);
  }

  function revealAndFail() {
    cancelPendingReply();
    setShowSolution(true);
    setStatus('revealed');
    setHintShown(false);
    setPlaybackIdx(0);
    report({ usedHint: hintUsed, revealed: true });
  }

  const nextExpected = puzzle.solution[solvedIdx];
  const hintSquares =
    hintShown && status === 'solving' && !awaitingReply && nextExpected
      ? [{ square: nextExpected.slice(0, 2), color: 'hint' as const }]
      : [];

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_320px] gap-4 items-start">
      <div className="space-y-2">
        <BoardFrame
          viewportClampPx={boardClampPx}
          evalBar={
            <EvalBar
              cpWhite={liveEval?.cpWhite ?? null}
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
              viewOnly={showSolution || finished || awaitingReply}
              onMove={(m) => onMove(m)}
              // Some lines hinge on an underpromotion; an auto-queen would
              // make them unsolvable (see `applyPuzzleMove`).
              choosePromotion
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
                  <>
                    {t('puzzles.solver.toMove', {
                      color:
                        solverColor === 'white' ? t('common.white') : t('common.black'),
                    })}
                  </>
                )}
                {hintShown && (
                  <span className="ml-2 text-accent">{t('puzzles.solver.hint')}</span>
                )}
              </span>
            )}
            {status === 'revealed' && (
              <span className="text-blunder">{t('puzzles.solver.wrongFull')}</span>
            )}
            {status === 'solved' && (
              <span className="text-good">
                {t('puzzles.solver.solved')}
                {hintUsed && (
                  <span className="ml-2 text-text-muted text-xs">
                    {t('puzzles.solver.withHint')}
                  </span>
                )}
              </span>
            )}
          </div>
          <div className="flex gap-1">
            {status === 'solving' && !hintShown && (
              <button
                type="button"
                className="btn text-xs"
                onClick={showHint}
                // Disabled rather than hidden, so the row doesn't jump on
                // every move.
                disabled={awaitingReply}
              >
                {t('puzzles.solver.hint_btn')}
              </button>
            )}
            {status === 'solving' && mistakeMade && (
              <button type="button" className="btn text-xs" onClick={revealAndFail}>
                {t('puzzles.solver.reveal')}
              </button>
            )}
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

        {/* Session-level context (e.g. "matched to your fork mistakes"),
            deliberately placed under the board and NOT in the rail beside
            the position — it describes the run, not this puzzle. */}
        {sessionNote && (
          <p className="text-xs text-text-muted">{sessionNote}</p>
        )}
      </div>

      <Rail
        puzzle={puzzle}
        session={session}
        ratingChange={ratingChange}
        unratedNote={unratedNote}
        status={status}
        missed={status === 'revealed' || hintUsed || mistakeMade}
        solutionSan={solutionSteps.slice(1).map((s) => s.san)}
        onReplay={() => {
          setShowSolution(true);
          setPlaybackIdx(0);
        }}
        onNext={onNext}
        hasNext={hasNext}
        nextLabel={nextLabel}
      />
    </div>
  );
}

/**
 * The side rail — and the one place the no-spoiler rule is enforced.
 *
 * Before the puzzle is finished it shows only: whose move it is, the
 * difficulty rating, and where you are in the run. It must NOT show the
 * puzzle's themes, because the theme *is* the answer — being told "fork"
 * reduces the exercise to finding a fork you already know is there.
 *
 * After it's finished, the rail flips to a reveal: themes as chips, the
 * solution in SAN, and a link to the source game. That's also the moment
 * the themes become genuinely useful — they name the pattern you just saw,
 * which is what makes it stick.
 */
function Rail({
  puzzle,
  session,
  ratingChange,
  unratedNote,
  status,
  missed,
  solutionSan,
  onReplay,
  onNext,
  hasNext,
  nextLabel,
}: {
  puzzle: LibraryPuzzle;
  session: SessionInfo;
  ratingChange?: { from: number; to: number };
  unratedNote?: string;
  status: 'solving' | 'revealed' | 'solved';
  /** Not clean — so the puzzle is headed for Review. */
  missed: boolean;
  solutionSan: string[];
  onReplay: () => void;
  onNext: () => void;
  hasNext: boolean;
  nextLabel?: string;
}) {
  const { t } = useTranslation();
  const finished = status === 'solved' || status === 'revealed';

  return (
    <aside className="space-y-3">
      <div className="card p-3 space-y-3 text-sm">
        <div className="flex items-baseline justify-between gap-2">
          <div className="font-medium">
            {t('puzzles.solver.toMoveShort', {
              color:
                puzzle.fen.split(' ')[1] === 'w'
                  ? t('common.white')
                  : t('common.black'),
            })}
          </div>
          <div className="text-xs text-text-muted tabular-nums">
            {t('puzzles.rating', { rating: puzzle.rating })}
          </div>
        </div>

        <SessionStrip session={session} />
      </div>

      {finished && (
        <div className="card p-3 space-y-3 text-sm">
          {ratingChange && <RatingChange {...ratingChange} />}
          {!ratingChange && unratedNote && (
            <p className="text-[11px] text-text-muted">{unratedNote}</p>
          )}
          <div>
            <div className="text-xs uppercase tracking-wide text-text-muted mb-1.5">
              {t('puzzles.themesRevealed')}
            </div>
            <div className="flex flex-wrap gap-1">
              {puzzle.themes.map((th) => (
                <span
                  key={th}
                  className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-bg-raised text-text-muted"
                >
                  {formatThemeName(th)}
                </span>
              ))}
            </div>
          </div>

          <div>
            <div className="text-xs uppercase tracking-wide text-text-muted mb-1">
              {t('puzzles.solver.solution')}
            </div>
            <div className="font-mono text-xs leading-relaxed">
              {solutionSan.map((s, i) => (
                <span key={i} className={i % 2 === 0 ? 'text-good' : 'text-text-muted'}>
                  {s}
                  {i < solutionSan.length - 1 ? ' ' : ''}
                </span>
              ))}
            </div>
          </div>

          <div className="flex gap-2">
            <button type="button" className="btn text-xs flex-1" onClick={onReplay}>
              {t('puzzles.solver.replayStepByStep')}
            </button>
            <a
              className="btn text-xs flex-1 text-center"
              href={`https://lichess.org/training/${puzzle.id}`}
              target="_blank"
              rel="noreferrer noopener"
            >
              {t('puzzles.viewOnLichess')}
            </a>
          </div>

          {missed && (
            <p className="text-[11px] text-text-muted">{t('puzzles.goesToReview')}</p>
          )}

          <button
            type="button"
            className="btn w-full border-accent/50 text-accent hover:bg-accent/10"
            onClick={onNext}
            disabled={!hasNext}
            autoFocus
          >
            {nextLabel ?? (hasNext ? t('puzzles.next') : t('puzzles.runComplete'))}
          </button>
        </div>
      )}
    </aside>
  );
}

function RatingChange({ from, to }: { from: number; to: number }) {
  const { t } = useTranslation();
  const delta = Math.round(to) - Math.round(from);
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-xs text-text-muted">{t('puzzles.yourRating')}</span>
      <span className="tabular-nums">
        <span className="font-medium">{Math.round(to)}</span>
        <span
          className={`ml-1.5 text-xs ${
            delta > 0 ? 'text-good' : delta < 0 ? 'text-blunder' : 'text-text-muted'
          }`}
        >
          {delta > 0 ? `+${delta}` : delta}
        </span>
      </span>
    </div>
  );
}

/** Dot colour per outcome. Shared with the history grid's badges. */
export const OUTCOME_DOT: Record<PuzzleOutcome, string> = {
  clean: 'bg-good',
  mistake: 'bg-mistake',
  hint: 'bg-inaccuracy',
  revealed: 'bg-blunder',
};

/**
 * This session's results as dots, plus a clean-solve count. Replaces a strip
 * of "puzzle 3 of 20" dots: the run length was an implementation detail of
 * how many puzzles one fetch returned, whereas how the session is going is
 * the thing you actually glance at. Caps the dots so a long session doesn't
 * wrap into a wall of circles.
 */
function SessionStrip({ session }: { session: SessionInfo }) {
  const { t } = useTranslation();
  const MAX_DOTS = 14;
  const { results } = session;
  const shown = results.slice(-MAX_DOTS);
  const clean = results.filter((r) => r === 'clean').length;
  let streak = 0;
  for (let i = results.length - 1; i >= 0 && results[i] === 'clean'; i--) streak++;

  return (
    <div className="flex items-center justify-between gap-2">
      <div className="flex items-center gap-1 min-h-[6px]" aria-hidden>
        {shown.map((r, i) => (
          <span key={i} className={`h-1.5 w-1.5 rounded-full ${OUTCOME_DOT[r]}`} />
        ))}
        <span className="h-1.5 w-1.5 rounded-full bg-accent ring-2 ring-accent/30" />
      </div>
      <div className="text-xs text-text-muted tabular-nums whitespace-nowrap">
        {session.position && <span className="mr-2">{session.position}</span>}
        {results.length > 0 && (
          <span>{t('puzzles.sessionScore', { clean, total: results.length })}</span>
        )}
        {streak > 1 && <span className="ml-2 text-good">{t('puzzles.streak', { streak })}</span>}
      </div>
    </div>
  );
}
