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
  puzzleId: string;
  rating: number;
  /** First try, no hint, no reveal. */
  clean: boolean;
  hintUsed: boolean;
  revealed: boolean;
  msTaken: number;
}

/**
 * Vertical space (px) the page chrome needs, so `BoardFrame` can clamp the
 * board to what's actually left of the viewport.
 *
 * The board is sized off `100vh - clamp`, so this has to cover everything
 * above and below it or the board runs off the bottom of the screen and takes
 * the status row with it. Measured at 1440x900:
 *
 *   above:  header 48 + page title 50 + tab bar 52 + gaps ~24   = ~174
 *   below:  status row 28 + session note 20 + page padding 48    = ~96
 *
 * The old solver passed 220, which was right for a page with no tab bar; with
 * one, the board overflowed by ~70 px and pushed the whole action row under
 * the fold.
 */
export const BOARD_CLAMP_PX = 280;

/** Extra reserve when the Recommended summary card sits above the board. */
export const BOARD_CLAMP_WITH_SUMMARY_PX = 390;

export function LibraryPuzzleSolver({
  puzzle,
  index,
  total,
  streak,
  sessionNote,
  boardClampPx = BOARD_CLAMP_PX,
  onDone,
  onNext,
  hasNext,
}: {
  puzzle: LibraryPuzzle;
  /** 1-based position in the current run, for the progress strip. */
  index: number;
  total: number;
  streak: number;
  /** Session-level context line, e.g. what Recommended matched on. Shown
   *  once under the board — never per-puzzle theme info. */
  sessionNote?: string;
  /** Vertical space to reserve for page chrome. See `BOARD_CLAMP_PX`. */
  boardClampPx?: number;
  onDone: (outcome: SolveOutcome) => void;
  onNext: () => void;
  hasNext: boolean;
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

  const liveEval = useLiveEval(boardFen, 12);

  /** Report the outcome exactly once per puzzle. `wrongAttempts` and
   *  `usedHint` are passed explicitly because callers may fire from inside
   *  a `setTimeout` closure where the state values are stale. */
  function report(opts: {
    clean: boolean;
    hintUsed: boolean;
    revealed: boolean;
  }) {
    if (reportedRef.current) return;
    reportedRef.current = true;
    onDone({
      puzzleId: puzzle.id,
      rating: puzzle.rating,
      clean: opts.clean,
      hintUsed: opts.hintUsed,
      revealed: opts.revealed,
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
      setAttempts((n) => n + 1);
      setMistakeMade(true);
      return false;
    }

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
      // Snapshot the cleanliness inputs now — by the time the timer fires,
      // reading `attempts`/`hintUsed` would close over stale values.
      const cleanAtCommit = attempts === 0 && !hintUsed;
      const hintAtCommit = hintUsed;
      replyTimerRef.current = window.setTimeout(() => {
        replyTimerRef.current = null;
        setFen(finalFen);
        setLastUci(finalUci);
        setSolvedIdx(finalIdx);
        setAwaitingReply(false);
        if (finalSolved) {
          setStatus('solved');
          report({ clean: cleanAtCommit, hintUsed: hintAtCommit, revealed: false });
        }
      }, delay);
      return true;
    }

    setFen(result.fen);
    setLastUci(result.lastUci);
    setSolvedIdx(result.nextSolvedIdx);
    if (result.solved) {
      setStatus('solved');
      report({ clean: attempts === 0 && !hintUsed, hintUsed, revealed: false });
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
    setHintShown(true);
    setHintUsed(true);
  }

  function revealAndFail() {
    cancelPendingReply();
    setShowSolution(true);
    setStatus('revealed');
    setHintShown(false);
    setPlaybackIdx(0);
    report({ clean: false, hintUsed, revealed: true });
  }

  const nextExpected = puzzle.solution[solvedIdx];
  const hintSquares =
    hintShown && status === 'solving' && nextExpected
      ? [{ square: nextExpected.slice(0, 2), color: 'hint' as const }]
      : [];

  const finished = status === 'solved' || status === 'revealed';

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
              <button type="button" className="btn text-xs" onClick={showHint}>
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
        index={index}
        total={total}
        streak={streak}
        status={status}
        hintUsed={hintUsed}
        solutionSan={solutionSteps.slice(1).map((s) => s.san)}
        onReplay={() => {
          setShowSolution(true);
          setPlaybackIdx(0);
        }}
        onNext={onNext}
        hasNext={hasNext}
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
  index,
  total,
  streak,
  status,
  hintUsed,
  solutionSan,
  onReplay,
  onNext,
  hasNext,
}: {
  puzzle: LibraryPuzzle;
  index: number;
  total: number;
  streak: number;
  status: 'solving' | 'revealed' | 'solved';
  hintUsed: boolean;
  solutionSan: string[];
  onReplay: () => void;
  onNext: () => void;
  hasNext: boolean;
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

        <ProgressStrip index={index} total={total} streak={streak} />
      </div>

      {finished && (
        <div className="card p-3 space-y-3 text-sm">
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

          {status === 'solved' && hintUsed && (
            <p className="text-[11px] text-text-muted">
              {t('puzzles.notRetiredHint')}
            </p>
          )}
          {status === 'revealed' && (
            <p className="text-[11px] text-text-muted">{t('puzzles.notRetiredRevealed')}</p>
          )}

          <button
            type="button"
            className="btn w-full border-accent/50 text-accent hover:bg-accent/10"
            onClick={onNext}
            disabled={!hasNext}
            autoFocus
          >
            {hasNext ? t('puzzles.next') : t('puzzles.runComplete')}
          </button>
        </div>
      )}
    </aside>
  );
}

/** Dots for the current run plus the clean-solve streak. Caps the rendered
 *  dots so a long run doesn't wrap into a wall of circles. */
function ProgressStrip({
  index,
  total,
  streak,
}: {
  index: number;
  total: number;
  streak: number;
}) {
  const { t } = useTranslation();
  const MAX_DOTS = 12;
  const shown = Math.min(total, MAX_DOTS);
  // When the run is longer than the strip, slide the window so the current
  // puzzle stays visible rather than pinning to the first 12.
  const offset = Math.max(0, Math.min(index - Math.ceil(shown / 2), total - shown));

  return (
    <div className="flex items-center justify-between gap-2">
      <div className="flex items-center gap-1" aria-hidden>
        {Array.from({ length: shown }, (_, i) => {
          const pos = offset + i + 1;
          return (
            <span
              key={pos}
              className={`h-1.5 w-1.5 rounded-full ${
                pos < index
                  ? 'bg-good'
                  : pos === index
                    ? 'bg-accent ring-2 ring-accent/30'
                    : 'bg-border'
              }`}
            />
          );
        })}
      </div>
      <div className="text-xs text-text-muted tabular-nums whitespace-nowrap">
        <span>{t('puzzles.progressOf', { index, total })}</span>
        {streak > 1 && <span className="ml-2 text-good">{t('puzzles.streak', { streak })}</span>}
      </div>
    </div>
  );
}
