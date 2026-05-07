import { useEffect, useMemo, useState } from 'react';
import { Chess } from 'chess.js';
import { Board } from './Board';
import { THUMBNAIL_BOARD_MAX_PX } from './BoardFrame';

/**
 * Inline "simulation" view of a sequence of moves with prev / next /
 * first / last controls. Used by:
 *
 *   - Puzzles ("Reveal" → step through the engine-verified solution
 *     starting at the puzzle FEN).
 *   - Repertoire cards ("Show answer" → step through the line from the
 *     repertoire root, ending on the expected card move).
 *
 * The component is purely a presentational driver:
 *   - `startFen` is the position we replay from.
 *   - `moves` is the UCI sequence to play out (each step computes both
 *     a SAN label and a board FEN by replaying through chess.js).
 *   - `userColor` (optional) flips the board so the simulation always
 *     plays from the perspective the rest of the page already shows.
 *
 * The viewer is read-only: clicking on the board does nothing; the
 * only interactive surface is the prev/next buttons + arrow keys.
 *
 * Why not reuse LineRunner? LineRunner is a *trainer* (the user has
 * to play the moves to advance). Here we just want a tape-deck-style
 * playback where every move is auto-played and the user scrubs. Two
 * different jobs, two different components — keeps both small.
 */
export interface SolutionPlayerProps {
  startFen: string;
  moves: string[];
  /** Flips the board's orientation. Defaults to whichever side is to
   *  move at `startFen`. */
  orientation?: 'white' | 'black';
  /** Optional title above the simulation (e.g. "Solution"). */
  title?: string;
  /** Optional callback fired when the user closes the simulation. */
  onClose?: () => void;
}

export interface SolutionStep {
  /** FEN after applying steps 0..i moves to startFen. */
  fen: string;
  /** SAN of the move that produced this position, or '' for step 0. */
  san: string;
  /** UCI of the move that produced this position, or '' for step 0. */
  uci: string;
}

/** Build a list of FENs by replaying `moves` over `startFen`. Stops at
 *  the first illegal move so a malformed solution doesn't crash the
 *  page (returns whatever was successfully replayed up to that point).
 *  Each step's FEN is the position *after* its move.
 *
 *  Exported for unit tests; UI consumers should use `<SolutionPlayer>`
 *  directly. */
export function buildSolutionSteps(
  startFen: string,
  moves: string[],
): SolutionStep[] {
  const steps: SolutionStep[] = [{ fen: startFen, san: '', uci: '' }];
  let chess: Chess;
  try {
    chess = new Chess();
    chess.load(startFen);
  } catch {
    return steps;
  }
  for (const uci of moves) {
    try {
      const mv = chess.move({
        from: uci.slice(0, 2),
        to: uci.slice(2, 4),
        promotion: uci.slice(4, 5) || undefined,
      });
      if (!mv) break;
      steps.push({ fen: chess.fen(), san: mv.san, uci });
    } catch {
      break;
    }
  }
  return steps;
}

export function SolutionPlayer({
  startFen,
  moves,
  orientation,
  title,
  onClose,
}: SolutionPlayerProps) {
  const steps = useMemo(
    () => buildSolutionSteps(startFen, moves),
    [startFen, moves],
  );
  const [idx, setIdx] = useState(0);

  // Reset to the start whenever the source moves change (e.g. user
  // navigated to a different puzzle / card). Without this, switching
  // puzzles while the player was open would leave the cursor on a
  // nonsensical step from the previous solution.
  useEffect(() => {
    setIdx(0);
  }, [startFen, moves.join(',')]);

  // Keyboard navigation matches what users expect from a tape-deck
  // (←/→ step, Home/End jump). We deliberately don't bind these
  // outside the player's lifecycle so they can't fight the trainer's
  // own keyboard shortcuts when the player isn't mounted.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement) return;
      if (e.target instanceof HTMLTextAreaElement) return;
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        setIdx((i) => Math.max(0, i - 1));
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        setIdx((i) => Math.min(steps.length - 1, i + 1));
      } else if (e.key === 'Home') {
        e.preventDefault();
        setIdx(0);
      } else if (e.key === 'End') {
        e.preventDefault();
        setIdx(steps.length - 1);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [steps.length]);

  const fallbackOrientation = useMemo<'white' | 'black'>(() => {
    if (orientation) return orientation;
    return startFen.split(' ')[1] === 'b' ? 'black' : 'white';
  }, [orientation, startFen]);

  if (steps.length <= 1) {
    return (
      <div className="card p-3 space-y-2">
        {title && (
          <div className="flex items-baseline justify-between">
            <div className="text-xs uppercase tracking-wide text-text-muted">
              {title}
            </div>
            {onClose && (
              <button type="button" className="btn text-xs" onClick={onClose}>
                Close
              </button>
            )}
          </div>
        )}
        <div className="text-xs text-text-muted">
          No solution moves to replay.
        </div>
      </div>
    );
  }

  const current = steps[idx];
  const atStart = idx === 0;
  const atEnd = idx === steps.length - 1;

  return (
    <div className="card p-3 space-y-3">
      <div className="flex items-baseline justify-between gap-2">
        <div className="text-xs uppercase tracking-wide text-text-muted">
          {title ?? 'Solution playback'}
        </div>
        <div className="text-[11px] text-text-muted font-mono">
          {idx} / {steps.length - 1}
        </div>
      </div>
      <div
        className="mx-auto w-full"
        style={{ maxWidth: THUMBNAIL_BOARD_MAX_PX }}
      >
        <Board
          fen={current.fen}
          orientation={fallbackOrientation}
          lastMoveUci={current.uci || undefined}
          viewOnly
        />
      </div>
      <SanRibbon steps={steps} idx={idx} onJump={setIdx} />
      <div className="flex flex-wrap items-center gap-2 justify-between">
        <div className="flex gap-1">
          <button
            type="button"
            className="btn text-xs"
            onClick={() => setIdx(0)}
            disabled={atStart}
            title="First move (Home)"
          >
            ⏮
          </button>
          <button
            type="button"
            className="btn text-xs"
            onClick={() => setIdx((i) => Math.max(0, i - 1))}
            disabled={atStart}
            title="Previous move (←)"
          >
            ◀ Prev
          </button>
          <button
            type="button"
            className="btn text-xs"
            onClick={() => setIdx((i) => Math.min(steps.length - 1, i + 1))}
            disabled={atEnd}
            title="Next move (→)"
          >
            Next ▶
          </button>
          <button
            type="button"
            className="btn text-xs"
            onClick={() => setIdx(steps.length - 1)}
            disabled={atEnd}
            title="Last move (End)"
          >
            ⏭
          </button>
        </div>
        {onClose && (
          <button type="button" className="btn text-xs" onClick={onClose}>
            Close
          </button>
        )}
      </div>
    </div>
  );
}

/** Compact SAN ribbon showing every move in the simulation; the
 *  current step is highlighted, and clicking any move jumps the
 *  player to it. Renders nothing for the synthetic step-0 entry. */
function SanRibbon({
  steps,
  idx,
  onJump,
}: {
  steps: SolutionStep[];
  idx: number;
  onJump: (i: number) => void;
}) {
  return (
    <div className="flex flex-wrap gap-x-2 gap-y-0.5 font-mono text-xs">
      {steps.map((s, i) => {
        if (i === 0) return null;
        const moveNumber = Math.floor((i - 1) / 2) + 1;
        const isWhite = (i - 1) % 2 === 0;
        return (
          <button
            key={i}
            type="button"
            onClick={() => onJump(i)}
            className={`px-1 rounded transition-colors ${
              i === idx
                ? 'bg-accent/20 text-accent font-semibold'
                : 'text-text-muted hover:text-text'
            }`}
          >
            {isWhite && (
              <span className="text-text-muted/70 mr-0.5">{moveNumber}.</span>
            )}
            {s.san}
          </button>
        );
      })}
    </div>
  );
}
