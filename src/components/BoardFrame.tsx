import type { ReactNode } from 'react';

/**
 * Canonical "primary chess board" size.
 *
 * One source of truth so every primary board in the app — Review,
 * Cards trainer, Lines runner, Puzzles, Openings library — is the
 * exact same pixel size at every viewport. Drift between pages
 * ("the puzzle board feels smaller than the review board") was
 * the consistency complaint from 2026-05-07; before this constant
 * landed, each page wrapped `<Board>` in its own ad-hoc `max-w-*`
 * rules and the puzzles page even had an outer `min(664px, …)`
 * wrapper that clipped the board ~8 px below its 640-cap.
 *
 * Treat this as load-bearing: if you bump it, every primary board
 * moves together. Per-page caps for *thumbnail* boards (e.g. the
 * weakness example mini-boards) live next to those use sites and
 * are intentionally smaller, so they don't reach for this constant.
 */
export const PRIMARY_BOARD_MAX_PX = 640;

/**
 * Canonical "thumbnail" board size for inline examples (weakness
 * mistake list, future opening cards, etc.). Smaller than
 * `PRIMARY_BOARD_MAX_PX` on purpose — these boards live inside dense
 * lists where a 640-px board would push the next example a full
 * viewport down. Uses the same constant so all thumbnails stay
 * consistent with each other even as the design evolves.
 */
export const THUMBNAIL_BOARD_MAX_PX = 360;

/**
 * Small ratio (eval bar / 24 px) that we subtract from the outer
 * frame width when an eval bar is rendered alongside the board. Keeps
 * the *board* itself at `PRIMARY_BOARD_MAX_PX` regardless of whether
 * a bar is present.
 */
const EVAL_BAR_PX = 24;
const EVAL_BAR_GAP_PX = 8;

export interface BoardFrameProps {
  /** The `<Board>` element. */
  board: ReactNode;
  /** Optional `<EvalBar>` rendered to the left of the board, sharing
   *  the board's height (chessground is `aspect-square` so the bar
   *  matches automatically via `items-stretch`). */
  evalBar?: ReactNode;
  /** Optional viewport-height clamp (px) so the board can't grow
   *  taller than the user's screen on short windows. The puzzle solver
   *  is the main caller — it can't afford to push action buttons below
   *  the fold. Pass `0` (default) to skip the clamp. */
  viewportClampPx?: number;
}

/**
 * Wraps a `<Board>` (and optionally an `<EvalBar>`) at the canonical
 * primary-board width. Every page that shows a "main" board should
 * use this rather than rolling its own `max-w-*` wrapper.
 *
 * The frame itself doesn't draw a card / border / padding — it's a
 * pure sizing primitive. Status text, controls, eval graph, etc. go
 * outside the frame so they can use the full column width while the
 * board stays at its canonical size.
 */
export function BoardFrame({
  board,
  evalBar,
  viewportClampPx = 0,
}: BoardFrameProps) {
  // When an eval bar is present, the frame outer width includes the
  // bar + the gap so the *board* itself still hits exactly
  // `PRIMARY_BOARD_MAX_PX`. Without a bar, the frame width matches the
  // board cap directly.
  const outerMax = evalBar
    ? PRIMARY_BOARD_MAX_PX + EVAL_BAR_PX + EVAL_BAR_GAP_PX
    : PRIMARY_BOARD_MAX_PX;
  const maxWidth =
    viewportClampPx > 0
      ? `min(${outerMax}px, calc(100vh - ${viewportClampPx}px))`
      : `${outerMax}px`;

  if (!evalBar) {
    return (
      <div className="mx-auto w-full" style={{ maxWidth }}>
        {board}
      </div>
    );
  }
  return (
    <div
      className="mx-auto w-full flex gap-2 items-stretch"
      style={{ maxWidth }}
    >
      {evalBar}
      <div className="flex-1 min-w-0">{board}</div>
    </div>
  );
}
