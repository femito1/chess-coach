import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Board } from '@/components/Board';
import { BoardFrame } from '@/components/BoardFrame';
import { EVAL_BAR_WIDTH_PX } from '@/components/EvalBar';
import {
  recordLineAttempt,
  recordLineCompletion,
  recordLineMove,
  type RepertoireLine,
} from './store';

/**
 * `wrong` is no longer a status the user can sit in. A wrong move
 * auto-retries: chessground snaps the piece back, we bump the
 * session-stats counter, and we stay in `thinking` so the user can
 * just play again on the same board with no button click. The status
 * still appears in the union for legacy callers that switch on it,
 * but it's not produced by the state machine anymore. (Earlier
 * versions of the runner locked into `wrong` and required a "Try
 * again" button click; the puzzles flow shipped the same auto-retry
 * change first, this is the repertoire equivalent.)
 */
export type LineStatus = 'thinking' | 'wrong' | 'right' | 'done';

export interface SessionStats {
  total: number;
  wrong: number;
  hintsUsed: number;
}

const OPPONENT_AUTOPLAY_DELAY_MS = 600;

export interface LineRunnerProps {
  repertoireId: string;
  line: RepertoireLine;
  userColor: 'white' | 'black';
  /** Fired when the user reaches the final ply of this line (whether
   *  the run was perfect or not). The practice page uses this hook to
   *  schedule the next line in sequential / random / repeat modes. */
  onLineFinished?: (result: { perfect: boolean }) => void;
  /** Per-line stats updated; used to refresh the surrounding UI. */
  onStatsChanged?: () => void;
  /** Optional nodes rendered below the board (status row, action
   *  buttons). Practice page injects mode-aware controls here. */
  renderControls?: (state: LineRunnerControlState) => React.ReactNode;
}

export interface LineRunnerControlState {
  status: LineStatus;
  isUserTurn: boolean;
  ply: number;
  totalPly: number;
  expectedSan: string | undefined;
  hintShown: boolean;
  revealShown: boolean;
  /** Sticky for the line's lifetime: true once the user has made any
   *  wrong attempt on this line. Renderers use this to keep the Hint
   *  + Show-answer buttons surfaced after the first mistake, even
   *  after the user goes on to play correct moves. Cleared by
   *  `onRestart`. */
  mistakeMade: boolean;
  /** True for one frame after a wrong move (the `wrongUci` state is
   *  set; chessground has reverted the piece and the board is back
   *  in the previous accepted state). Renderers use this to flash a
   *  "Not your prep here" status. Cleared on the next move attempt
   *  / hint / reveal / restart. */
  wrongFlash: boolean;
  sessionStats: SessionStats;
  onRetry: () => void;
  onHint: () => void;
  onReveal: () => void;
  onPlayReveal: () => void;
  onRestart: () => void;
}


/**
 * Pure "play through one repertoire line" widget. Owns its board state,
 * per-attempt hints/reveal/retry logic, and the persistence of per-line
 * stats. Doesn't know anything about *which* line comes next — the
 * surrounding page (PracticePage) drives that via
 * `key={line.uci.join(' ')}` to force a fresh mount per line, plus the
 * `onLineFinished` callback for "done" transitions.
 *
 * Originally extracted from the legacy `RepertoireLineTrainer.tsx`
 * (the `/repertoire/:id/lines` page), which was removed 2026-05-12
 * when the practice page became the canonical drill flow. The
 * behaviour is identical to the inlined version that shipped before —
 * same state machine, same persistence calls, same hint/reveal/retry
 * semantics. Only the surrounding callbacks differ (`onLineFinished`
 * is new; was previously inlined into the parent's "next line" button).
 */
export function LineRunner({
  repertoireId,
  line,
  userColor,
  onLineFinished,
  onStatsChanged,
  renderControls,
}: LineRunnerProps) {
  const [ply, setPly] = useState(0);
  const [status, setStatus] = useState<LineStatus>('thinking');
  const [hintShown, setHintShown] = useState(false);
  const [revealShown, setRevealShown] = useState(false);
  const [wrongUci, setWrongUci] = useState<string | null>(null);
  /** Sticky for the line's lifetime: once the user has made any
   *  wrong attempt on this line, surface the Hint + Show-answer
   *  buttons alongside the always-on row from then on, even after
   *  they go on to play correct moves. Mirrors the puzzles
   *  `mistakeMade` contract — once you've slipped on a line, you
   *  should be able to fall back to a hint or reveal at any later
   *  ply without having to deliberately make another mistake. */
  const [mistakeMade, setMistakeMade] = useState(false);
  const [sessionStats, setSessionStats] = useState<SessionStats>({
    total: 0,
    wrong: 0,
    hintsUsed: 0,
  });
  // Persisted-stats bookkeeping: `recordLineAttempt` runs once per line
  // *engagement*, `recordLineCompletion` runs once per actual
  // reach-the-end (resets when the user clicks Restart so a second
  // completion is logged correctly).
  //
  // This used to fire on mount, which counted merely *seeing* a line as
  // an attempt. That became wrong once the Learn panel shipped: Learn
  // occupies the same slot as the runner, so opening and closing it
  // unmounted and remounted this component and logged a fresh attempt
  // against a line the user never played — five peeks inflated the count
  // by five and dragged that line's completion rate down. Logging on the
  // first real engagement (a move attempt, or asking for a hint /
  // answer) is both immune to remounts and a truer reading of "attempts".
  const attemptLogged = useRef(false);
  const completionLogged = useRef(false);
  const opponentTimer = useRef<number | null>(null);

  const logAttemptOnce = useCallback(() => {
    if (attemptLogged.current) return;
    attemptLogged.current = true;
    void recordLineAttempt(repertoireId, line).then(() => {
      onStatsChanged?.();
    });
  }, [repertoireId, line, onStatsChanged]);

  const isUserTurn = useMemo(() => {
    if (ply >= line.uci.length) return false;
    const fen = line.fens[ply];
    const turn = fen.split(' ')[1] === 'w' ? 'white' : 'black';
    return turn === userColor;
  }, [ply, line, userColor]);

  useEffect(() => {
    if (status !== 'thinking') return;
    if (ply >= line.uci.length) {
      setStatus('done');
      if (!completionLogged.current) {
        completionLogged.current = true;
        const perfect =
          sessionStats.wrong === 0 && sessionStats.hintsUsed === 0;
        void recordLineCompletion(repertoireId, line, perfect).then(() => {
          onStatsChanged?.();
          onLineFinished?.({ perfect });
        });
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ply, isUserTurn, status, line, repertoireId]);

  const expectedUci = line.uci[ply];
  const expectedSan = line.san[ply];
  const expectedFromSquare = expectedUci ? expectedUci.slice(0, 2) : undefined;

  function tryMove(m: { from: string; to: string; promotion?: string }): boolean {
    if (!isUserTurn || status !== 'thinking') return false;
    logAttemptOnce();
    const played = m.from + m.to + (m.promotion ?? '');
    setSessionStats((s) => ({ ...s, total: s.total + 1 }));
    if (played.slice(0, 4) === expectedUci.slice(0, 4)) {
      setStatus('right');
      setHintShown(false);
      setRevealShown(false);
      setWrongUci(null);
      void recordLineMove(repertoireId, line, 'correct').then(() => {
        onStatsChanged?.();
      });
      window.setTimeout(() => {
        setStatus('thinking');
        setPly((p) => p + 1);
      }, 350);
      return true;
    }
    // Wrong move: bump the counters and unlock the sticky Hint +
    // Show-answer affordances via `mistakeMade`, but DON'T flip into a
    // `'wrong'` status. The Board's `onMove → false` revert path
    // already snaps the piece back to its source, so we stay in
    // `'thinking'` and the user can just re-drag — no Try-again button
    // click required. The red `wrong-square` highlight is preserved
    // for one frame of feedback (cleared on the next attempt or by
    // the hint/reveal flow). Mirrors the puzzles auto-retry change.
    setWrongUci(played);
    setMistakeMade(true);
    setSessionStats((s) => ({ ...s, wrong: s.wrong + 1 }));
    void recordLineMove(repertoireId, line, 'wrong').then(() => {
      onStatsChanged?.();
    });
    return false;
  }

  /**
   * Kept around for the `LineRunnerControlState.onRetry` slot so
   * existing renderControls callers can still wire up a "Try again"
   * button if they want to. With the auto-retry flow there's no
   * reason to render one — the board is already back in the previous
   * accepted state — so both shipping callsites
   * (`PracticeStatusBar` + `RunnerStatusBar`) stop rendering it.
   * Calling it just clears the wrong-square highlight without
   * touching `mistakeMade`, matching the previous behaviour for any
   * external consumer that still surfaces it.
   */
  function retry() {
    setWrongUci(null);
  }

  function showHint() {
    logAttemptOnce();
    setHintShown(true);
    setWrongUci(null);
    setSessionStats((s) => ({ ...s, hintsUsed: s.hintsUsed + 1 }));
  }

  function reveal() {
    logAttemptOnce();
    setRevealShown(true);
    setWrongUci(null);
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
    setMistakeMade(false);
    setSessionStats({ total: 0, wrong: 0, hintsUsed: 0 });
  }

  const fen = line.fens[Math.min(ply, line.fens.length - 1)];
  const lastUci = ply > 0 ? line.uci[ply - 1] : undefined;

  const highlightSquares =
    hintShown && expectedFromSquare && status === 'thinking'
      ? [{ square: expectedFromSquare, color: 'hint' as const }]
      : wrongUci && status === 'thinking'
        ? // Brief red ring on the wrong from-square so the user
          // gets visual feedback even though we don't lock into a
          // `'wrong'` state anymore. Cleared on the next move
          // attempt (`tryMove` resets `wrongUci` on the success
          // branch; the wrong branch overwrites it with the new
          // wrong square) or by the hint / reveal flow.
          [{ square: wrongUci.slice(0, 2), color: 'wrong' as const }]
        : [];

  const controlState: LineRunnerControlState = {
    status,
    isUserTurn,
    ply,
    totalPly: line.uci.length,
    expectedSan,
    hintShown,
    revealShown,
    mistakeMade,
    wrongFlash: wrongUci !== null && status === 'thinking',
    sessionStats,
    onRetry: retry,
    onHint: showHint,
    onReveal: reveal,
    onPlayReveal: playRevealedMove,
    onRestart: restartLine,
  };

  return (
    <div className="space-y-3">
      <BoardFrame
        // Reserve the eval-bar gutter once the line is finished so
        // "Play it out vs engine" can mount FreePlayRunner (with a real
        // EvalBar) without shoving the board sideways.
        evalBar={
          status === 'done' ? (
            <div
              className="shrink-0 self-stretch"
              style={{ width: EVAL_BAR_WIDTH_PX }}
              aria-hidden
            />
          ) : undefined
        }
        board={
          <Board
            fen={fen}
            orientation={userColor}
            lastMoveUci={lastUci}
            viewOnly={status !== 'thinking' || !isUserTurn}
            onMove={tryMove}
            highlightSquares={highlightSquares}
          />
        }
      />
      {renderControls?.(controlState)}
    </div>
  );
}
