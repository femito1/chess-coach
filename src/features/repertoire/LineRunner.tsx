import { useEffect, useMemo, useRef, useState } from 'react';
import { Board } from '@/components/Board';
import { BoardFrame } from '@/components/BoardFrame';
import {
  recordLineAttempt,
  recordLineCompletion,
  recordLineMove,
  type RepertoireLine,
} from './store';

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
 * surrounding page (RepertoireLineTrainer or PracticePage) drives that
 * via `key={line.uci.join(' ')}` to force a fresh mount per line, plus
 * the `onLineFinished` callback for "done" transitions.
 *
 * Extracted from RepertoireLineTrainer.tsx as a no-op refactor so the
 * new practice page can reuse it without forking. The behaviour is
 * identical to the inlined version that shipped before — same state
 * machine, same persistence calls, same hint/reveal/retry semantics.
 * Only the surrounding callbacks differ (`onLineFinished` is new; was
 * previously inlined into the parent's "next line" button).
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
  const [sessionStats, setSessionStats] = useState<SessionStats>({
    total: 0,
    wrong: 0,
    hintsUsed: 0,
  });
  // Persisted-stats bookkeeping — same idempotency contract as the
  // pre-extraction version: `recordLineAttempt` runs once per mount,
  // `recordLineCompletion` runs once per actual reach-the-end (resets
  // when the user clicks Restart so a second completion is logged
  // correctly).
  const attemptLogged = useRef(false);
  const completionLogged = useRef(false);
  const opponentTimer = useRef<number | null>(null);

  useEffect(() => {
    if (attemptLogged.current) return;
    attemptLogged.current = true;
    void recordLineAttempt(repertoireId, line).then(() => {
      onStatsChanged?.();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    setStatus('wrong');
    setWrongUci(played);
    setSessionStats((s) => ({ ...s, wrong: s.wrong + 1 }));
    void recordLineMove(repertoireId, line, 'wrong').then(() => {
      onStatsChanged?.();
    });
    return false;
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

  const controlState: LineRunnerControlState = {
    status,
    isUserTurn,
    ply,
    totalPly: line.uci.length,
    expectedSan,
    hintShown,
    revealShown,
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
