import { useEffect, useMemo, useRef, useState } from 'react';
import { Chessground } from 'chessground';
import type { Api as CgApi } from 'chessground/api';
import type { Config as CgConfig } from 'chessground/config';
import type { Color as CgColor, Key } from 'chessground/types';
import type { DrawShape } from 'chessground/draw';
import { Chess, type Square } from 'chess.js';
import type { Classification } from '@/db/schema';

/** Available brushes for `<Board arrows={...} />`. The first four mirror
 *  chessground's built-ins and respect any user theme; `engineBest` is a
 *  custom brush we register at init time so engine arrows stay green even
 *  though we recolor `green` to chess.com red for user-drawn shapes. */
export type ArrowBrush =
  | 'green'
  | 'red'
  | 'blue'
  | 'yellow'
  | 'engineBest';

export interface BoardArrow {
  from: string;
  to: string;
  brush?: ArrowBrush;
}

export interface BoardMove {
  from: string;
  to: string;
  promotion?: string;
}

export interface BoardProps {
  fen: string;
  orientation?: CgColor;
  /** UCI of the move that led to this position (used for highlight + badge). */
  lastMoveUci?: string;
  /** Classification of the last move, if available. Controls the badge. */
  lastMoveClassification?: Classification;
  arrows?: BoardArrow[];
  viewOnly?: boolean;
  /** If present, enables interactive play. Called with the user's attempted
   *  move. Return `false` (synchronously) to *reject* the move —
   *  chessground will be snapped back to the prop `fen`, undoing the
   *  just-rendered animation. Returning anything else (including `void`
   *  or a Promise) is treated as "accepted" and the parent is expected
   *  to advance `fen` itself. We don't await Promises here because the
   *  revert needs to happen before the user sees the wrong piece sit on
   *  its destination square. */
  onMove?: (move: BoardMove) => boolean | void | Promise<unknown>;
  /** Optional list of squares to highlight (e.g. hint = the from-square of the
   *  expected move). Rendered as a colored ring. */
  highlightSquares?: { square: string; color?: 'hint' | 'wrong' | 'right' }[];
}

/** chess.com's right-click red. Used both for the chessground `green` brush
 *  override (so default right-click feels native) and for our knight L-path
 *  overlay's stroke. */
const CHESS_COM_RED = '#dc4a4a';
const ENGINE_BEST_GREEN = '#15781B';

const CLASSIFICATION_BADGE: Record<
  Classification,
  { symbol: string; bg: string; fg: string }
> = {
  brilliant: { symbol: '!!', bg: 'bg-brilliant', fg: 'text-white' },
  best: { symbol: '★', bg: 'bg-good', fg: 'text-white' },
  excellent: { symbol: '!', bg: 'bg-good/80', fg: 'text-white' },
  good: { symbol: '✓', bg: 'bg-slate-400', fg: 'text-white' },
  book: { symbol: 'o', bg: 'bg-slate-500', fg: 'text-white' },
  inaccuracy: { symbol: '?!', bg: 'bg-inaccuracy', fg: 'text-black' },
  miss: { symbol: 'x', bg: 'bg-miss', fg: 'text-white' },
  mistake: { symbol: '?', bg: 'bg-mistake', fg: 'text-black' },
  blunder: { symbol: '??', bg: 'bg-blunder', fg: 'text-white' },
};

function computeDests(fen: string): Map<Key, Key[]> {
  const dests = new Map<Key, Key[]>();
  const chess = new Chess();
  try {
    chess.load(fen);
  } catch {
    return dests;
  }
  const moves = chess.moves({ verbose: true });
  for (const m of moves) {
    const arr = dests.get(m.from as Key);
    if (arr) arr.push(m.to as Key);
    else dests.set(m.from as Key, [m.to as Key]);
  }
  return dests;
}

function turnFromFen(fen: string): 'white' | 'black' {
  return fen.split(' ')[1] === 'w' ? 'white' : 'black';
}

/** Is (from, to) a knight-shaped jump (|df|,|dr| == {1,2}/{2,1})? */
function isKnightJump(from: string, to: string): boolean {
  if (from.length < 2 || to.length < 2) return false;
  const df = Math.abs(from.charCodeAt(0) - to.charCodeAt(0));
  const dr = Math.abs(Number(from[1]) - Number(to[1]));
  return (df === 1 && dr === 2) || (df === 2 && dr === 1);
}

/** Square -> pixel center (in percent of board size) from white's POV. */
function squareToPct(
  square: string,
  orientation: 'white' | 'black',
): { x: number; y: number } {
  const fileIdx = square.charCodeAt(0) - 'a'.charCodeAt(0);
  const rankIdx = Number(square[1]) - 1;
  const boardFile = orientation === 'white' ? fileIdx : 7 - fileIdx;
  const boardRank = orientation === 'white' ? 7 - rankIdx : rankIdx;
  return {
    x: (boardFile + 0.5) * 12.5,
    y: (boardRank + 0.5) * 12.5,
  };
}

/**
 * Build an L-shaped path (Chess.com-style) from `from` to `to` for a
 * knight move. The long leg goes first along the axis of the larger
 * delta; the short leg turns 90deg and ends at the destination.
 */
function knightLPath(
  from: string,
  to: string,
  orientation: 'white' | 'black',
): { d: string; arrowAt: { x: number; y: number; angle: number } } | null {
  if (!isKnightJump(from, to)) return null;
  const a = squareToPct(from, orientation);
  const b = squareToPct(to, orientation);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  // Long leg along the axis with larger magnitude.
  const longHoriz = Math.abs(dx) > Math.abs(dy);
  const corner = longHoriz ? { x: b.x, y: a.y } : { x: a.x, y: b.y };
  const d = `M ${a.x} ${a.y} L ${corner.x} ${corner.y} L ${b.x} ${b.y}`;
  // Arrowhead angle is along the final (short) leg.
  const angle =
    (Math.atan2(b.y - corner.y, b.x - corner.x) * 180) / Math.PI;
  return { d, arrowAt: { x: b.x, y: b.y, angle } };
}

export function Board({
  fen,
  orientation = 'white',
  lastMoveUci,
  lastMoveClassification,
  arrows = [],
  viewOnly = true,
  onMove,
  highlightSquares = [],
}: BoardProps) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const boardRef = useRef<HTMLDivElement | null>(null);
  const api = useRef<CgApi | null>(null);
  /** Set to true for exactly one FEN sync when the USER just played a move.
   *  Suppresses chessground's re-animation so the piece doesn't appear to
   *  jump back and forward. */
  const skipNextAnim = useRef(false);
  /** Knight-jump shapes split out from chessground for our L-path overlay.
   *  Non-knight shapes (circles + straight arrows) stay inside chessground
   *  and persist there until the user erases them or the FEN changes. */
  const [knightShapes, setKnightShapes] = useState<DrawShape[]>([]);
  /** When we replace a knight arrow's brush with `invisible` to suppress
   *  chessground's straight-line rendering, we'd lose the user's chosen
   *  colour. We stash the original brush keyed by `${orig}-${dest}` so the
   *  L-path overlay can paint it back in the same colour. The map shrinks
   *  whenever chessground drops a shape (toggle-off, fen change, click). */
  const knightOriginalBrushRef = useRef<Map<string, string>>(new Map());
  /** Latest values of frequently-changing props as refs, so the chessground
   *  event handlers always see the current `onMove` / `fen` without forcing
   *  us to call `api.set()` (which clobbers user-drawn shapes). */
  const onMoveRef = useRef(onMove);
  onMoveRef.current = onMove;
  const fenRef = useRef(fen);
  fenRef.current = fen;
  /** Last FEN string we pushed into chessground. Tracked here (rather than
   *  inferred from `api.getFen()`) because chessground returns the
   *  pieces-only portion, while we need to compare full-FEN turn/castling
   *  to know if a parent-driven sync has actually changed anything. */
  const lastFen = useRef(fen);

  const dests = useMemo(() => (viewOnly ? new Map<Key, Key[]>() : computeDests(fen)), [fen, viewOnly]);
  const turn = useMemo(() => turnFromFen(fen), [fen]);

  // ── One-time chessground init ────────────────────────────────────────────
  // IMPORTANT: chessground binds its mousedown / touchstart handlers exactly
  // once, in `bindBoard`, and skips that binding entirely when the initial
  // state has `viewOnly: true` (see chessground/src/events.ts). Calling
  // `api.set({ viewOnly: false })` later updates the state flag but does NOT
  // attach the missing listeners, so the board ends up permanently inert
  // (no piece dragging AND no right-click draw). To dodge that we ALWAYS
  // initialize with `viewOnly: false` and simulate read-only mode instead
  // by toggling `movable.color` / `draggable.enabled` — that keeps draw
  // (right-click) usable in review screens while still preventing piece
  // movement.
  useEffect(() => {
    if (!boardRef.current || api.current) return;

    const config: CgConfig = {
      fen,
      orientation,
      viewOnly: false,
      turnColor: turn,
      coordinates: true,
      animation: { enabled: true, duration: 80 },
      draggable: { enabled: !viewOnly },
      movable: {
        free: false,
        color: viewOnly ? undefined : 'both',
        dests,
        showDests: true,
        events: {
          after: (orig, dest) => {
            const cb = onMoveRef.current;
            if (!cb) return;
            const destRank = dest.charAt(1);
            const currentFen = fenRef.current;
            const currentTurn = turnFromFen(currentFen);
            const needsPromo =
              (destRank === '8' || destRank === '1') &&
              isPawnOn(currentFen, orig) &&
              (destRank === '8' ? currentTurn === 'white' : currentTurn === 'black');
            skipNextAnim.current = true;
            const result = cb({
              from: orig,
              to: dest,
              promotion: needsPromo ? 'q' : undefined,
            });
            // Parent rejected the move: snap chessground back to the
            // prop FEN immediately. Without this, the piece would stay
            // in its wrong square (chessground already animated the
            // move) until something else triggered a fen sync — which
            // is exactly the "Try again" bug. We re-set with animation
            // off so the revert is instantaneous.
            //
            // CRUCIAL: chessground sets `state.movable.dests = undefined`
            // and flips `state.turnColor` *before* invoking this `after`
            // callback (see chessground/dist/board.js ~L119). If we only
            // restore `fen` + `turnColor` here, the board ends up
            // un-movable: dests is gone, so no piece can be dragged
            // legally. We must re-pass the legal `dests` map so the user
            // can actually try again. The downstream React effect on
            // `[viewOnly, dests]` won't help because the prop reference
            // hasn't changed (fen + viewOnly are identical to before).
            if (result === false) {
              const expected = fenRef.current;
              api.current?.set({
                fen: expected,
                turnColor: turnFromFen(expected),
                movable: {
                  free: false,
                  color: 'both',
                  dests: computeDests(expected),
                  showDests: true,
                },
                animation: { enabled: false, duration: 0 },
              });
              lastFen.current = expected;
              skipNextAnim.current = false;
            }
          },
        },
      },
      drawable: {
        enabled: true,
        // Left-clicking the board clears any user shapes — chess.com
        // convention. Chessground only clears when the click hits an
        // empty/non-movable square, OR when a previously selected piece
        // is deselected; that's good enough that a normal "tap somewhere
        // on the board" wipes prior arrows/highlights.
        eraseOnClick: true,
        defaultSnapToValidMove: false,
        // Recolor:
        //   1. `green` (chessground's default for plain right-click) is
        //      remapped to chess.com's red, so highlights/arrows look
        //      familiar without an extra rewrite step in `onChange`. That
        //      matters because rewriting brushes after the fact breaks
        //      chessground's same-shape toggle (it compares brushes when
        //      deciding whether a redraw is "the same shape" → toggle
        //      off). With matching brushes, redraw natively toggles.
        //   2. `engineBest` is a brand-new brush keyed off chessground's
        //      original green color; the analysis review uses it for the
        //      engine's recommendation arrow.
        //   3. `invisible` is a zero-opacity, zero-width brush we use to
        //      "hide" knight arrows from chessground's renderer while
        //      keeping their state record (so toggle-off still works).
        //      We then paint the L-path ourselves in <KnightArrowOverlay>.
        brushes: {
          green: { key: 'g', color: CHESS_COM_RED, opacity: 0.85, lineWidth: 12 },
          red: { key: 'r', color: CHESS_COM_RED, opacity: 0.85, lineWidth: 12 },
          blue: { key: 'b', color: '#003088', opacity: 0.85, lineWidth: 12 },
          yellow: { key: 'y', color: '#e68f00', opacity: 0.85, lineWidth: 12 },
          engineBest: {
            key: 'eb',
            color: '#15781B',
            opacity: 0.9,
            lineWidth: 12,
          },
          // chessground's `lineWidth || 10` and `opacity || 1` fallbacks
          // mean we can't use 0 to hide the brush — we'd get a default
          // black 10px line back. Instead use a fully transparent colour:
          // both the SVG `<line>` stroke AND the arrowhead `<marker>` path
          // fill use `brush.color`, so a transparent value zeroes both.
          invisible: {
            key: 'inv',
            color: 'rgba(0,0,0,0)',
            opacity: 1,
            lineWidth: 1,
          },
          // chessground requires the named "pale*" brushes to exist for
          // its dest-collision rendering path; keep their built-in defs.
          paleBlue: { key: 'pb', color: '#003088', opacity: 0.4, lineWidth: 15 },
          paleGreen: { key: 'pg', color: '#15781B', opacity: 0.4, lineWidth: 15 },
          paleRed: { key: 'pr', color: '#882020', opacity: 0.4, lineWidth: 15 },
          paleGrey: { key: 'pgr', color: '#4a4a4a', opacity: 0.35, lineWidth: 15 },
          purple: { key: 'purple', color: '#68217a', opacity: 0.65, lineWidth: 12 },
          pink: { key: 'pink', color: '#ee2080', opacity: 0.5, lineWidth: 12 },
          white: { key: 'white', color: 'white', opacity: 1, lineWidth: 12 },
        },
        onChange: (shapes) => {
          // Knight arrows are tricky: chessground only renders straight
          // lines, so we (a) hide their straight rendering by swapping
          // the brush to `invisible`, and (b) draw an L-shaped overlay
          // ourselves in <KnightArrowOverlay>. The catch is that
          // chessground's redraw-toggle logic compares the *stored*
          // brush against the *incoming* brush — once we've stored
          // `invisible`, a redraw with the same colour is treated as a
          // brush change and the arrow is replaced (never toggles off).
          // We restore the chess.com behaviour ("redraw same arrow ->
          // arrow disappears") by detecting that case here and dropping
          // the shape ourselves.
          const overlayKnights: DrawShape[] = [];
          const next: DrawShape[] = [];
          let mutated = false;
          for (const s of shapes) {
            const isArrow = !!s.dest && s.orig !== s.dest;
            if (isArrow && isKnightJump(s.orig, s.dest!)) {
              const key = `${s.orig}-${s.dest}`;
              const incomingBrush = s.brush;
              const remembered = knightOriginalBrushRef.current.get(key);

              // User just drew (incoming brush is the real colour, not
              // our stand-in `invisible`).
              if (incomingBrush && incomingBrush !== 'invisible') {
                // Redraw of the *same* colour on the *same* squares
                // means the user wants to erase it. Drop the shape
                // entirely instead of re-hiding it.
                if (remembered === incomingBrush) {
                  knightOriginalBrushRef.current.delete(key);
                  mutated = true;
                  continue;
                }
                // Otherwise it's either a brand-new arrow or a colour
                // change. Remember the new colour and store the hidden
                // proxy so chessground stops drawing the straight line.
                knightOriginalBrushRef.current.set(key, incomingBrush);
                overlayKnights.push({ ...s, brush: incomingBrush });
                next.push({ ...s, brush: 'invisible' });
                mutated = true;
                continue;
              }

              // Brush is already `invisible` (or missing): this entry
              // came from a previous setShapes call. Keep it as-is and
              // re-emit the overlay using the remembered colour.
              const realBrush = remembered ?? 'green';
              overlayKnights.push({ ...s, brush: realBrush });
              next.push(s);
              continue;
            }
            next.push(s);
          }

          // Drop forgotten entries from the brush map so the cache doesn't
          // grow unboundedly across thousands of moves.
          if (overlayKnights.length === 0) {
            knightOriginalBrushRef.current.clear();
          } else {
            const live = new Set(
              overlayKnights.map((s) => `${s.orig}-${s.dest}`),
            );
            for (const k of knightOriginalBrushRef.current.keys()) {
              if (!live.has(k)) knightOriginalBrushRef.current.delete(k);
            }
          }

          if (mutated) api.current?.setShapes(next);
          setKnightShapes(overlayKnights);
        },
      },
    };
    api.current = Chessground(boardRef.current, config);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── FEN sync ─────────────────────────────────────────────────────────────
  // chessground resets `state.drawable.shapes` whenever a fen is passed (see
  // its config.ts ~line 114), so we only call `set({ fen })` when the FEN
  // actually changes — never on unrelated re-renders. That's what makes
  // right-click annotations persist until the next move.
  useEffect(() => {
    if (!api.current) return;
    if (lastFen.current === fen) return;
    lastFen.current = fen;
    const animEnabled = !skipNextAnim.current;
    if (skipNextAnim.current) skipNextAnim.current = false;
    api.current.set({
      fen,
      turnColor: turn,
      animation: { enabled: animEnabled, duration: 80 },
    });
    setKnightShapes([]);
    knightOriginalBrushRef.current.clear();
  }, [fen, turn]);

  // ── lastMove highlight sync (independent of fen) ─────────────────────────
  useEffect(() => {
    if (!api.current) return;
    api.current.set({
      lastMove: lastMoveUci
        ? ([lastMoveUci.slice(0, 2), lastMoveUci.slice(2, 4)] as [Key, Key])
        : undefined,
    });
  }, [lastMoveUci]);

  useEffect(() => {
    if (!api.current) return;
    api.current.set({ orientation });
  }, [orientation]);

  useEffect(() => {
    if (!api.current) return;
    // We never toggle the real `viewOnly` flag (see init comment); instead
    // we switch off piece-moving but leave the rest of the board (including
    // right-click drawing) alive.
    api.current.set({
      draggable: { enabled: !viewOnly },
      movable: viewOnly
        ? { free: false, color: undefined, dests: new Map() }
        : {
            free: false,
            color: 'both',
            dests,
            showDests: true,
          },
    });
  }, [viewOnly, dests]);

  // ── Auto-arrows (engine best move etc.) ──────────────────────────────────
  // setAutoShapes doesn't disturb user shapes, so engine arrows can update
  // without erasing right-click annotations.
  useEffect(() => {
    if (!api.current) return;
    api.current.setAutoShapes(
      arrows.map((a) => ({
        orig: a.from as Key,
        dest: a.to as Key,
        brush: a.brush ?? 'blue',
      })),
    );
  }, [arrows]);

  useEffect(() => {
    return () => {
      api.current?.destroy();
      api.current = null;
    };
  }, []);

  const badge =
    lastMoveUci && lastMoveClassification
      ? CLASSIFICATION_BADGE[lastMoveClassification]
      : null;

  return (
    <div ref={wrapRef} className="relative aspect-square w-full max-w-[560px] mx-auto">
      <div ref={boardRef} className="w-full h-full" />
      <SquareHighlightOverlay squares={highlightSquares} orientation={orientation} />
      <KnightArrowOverlay shapes={knightShapes} orientation={orientation} />
      {badge && lastMoveUci && (
        <BadgeOverlay
          square={lastMoveUci.slice(2, 4)}
          orientation={orientation}
          className={`${badge.bg} ${badge.fg}`}
        >
          {badge.symbol}
        </BadgeOverlay>
      )}
    </div>
  );
}

/** Mirrors the chessground brush palette we configure in `Board()`. We
 *  keep `green` and `red` mapped to chess.com red so user-drawn knight
 *  arrows colour-match the straight-arrow shapes chessground draws for
 *  rooks/bishops. `engineBest` retains chessground's classic green for
 *  the analysis review's recommendation arrow. */
const BRUSH_COLOR: Record<string, string> = {
  green: CHESS_COM_RED,
  red: CHESS_COM_RED,
  blue: '#003088',
  yellow: '#e68f00',
  engineBest: ENGINE_BEST_GREEN,
};

function KnightArrowOverlay({
  shapes,
  orientation,
}: {
  shapes: DrawShape[];
  orientation: 'white' | 'black';
}) {
  if (shapes.length === 0) return null;
  // Chessground's arrows use a `marker-end` triangle whose tip sits flush
  // with the end of the line (the line is shortened by `arrowMargin`
  // worth of stroke widths). We reproduce that look here so a knight's
  // L-path doesn't visually clash with a rook/bishop arrow drawn next to
  // it. Each brush colour gets its own `<marker>` because SVG markers
  // can't reference the parent stroke colour declaratively.
  const colors = Array.from(
    new Set(
      shapes
        .map((s) => (s.brush && BRUSH_COLOR[s.brush]) ?? BRUSH_COLOR.green)
        .filter(Boolean),
    ),
  );
  return (
    <svg
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      className="absolute inset-0 pointer-events-none"
      // z-index 9 matches chessground's `.cg-custom-svgs` so the L-shape is
      // painted above pieces (z-index 2/8) but below a piece being dragged
      // (z-index 11), exactly like chess.com.
      style={{ width: '100%', height: '100%', zIndex: 9 }}
    >
      <defs>
        {colors.map((c) => (
          <marker
            key={c}
            id={`knight-arrowhead-${markerId(c)}`}
            viewBox="0 0 4 4"
            refX="2.05"
            refY="2"
            markerWidth="4"
            markerHeight="4"
            orient="auto"
            // Setting markerUnits to strokeWidth (the default) makes the
            // arrowhead scale with the line. Chessground's marker uses
            // the same path: M0,0 V4 L3,2 Z — a triangle pointing right.
          >
            <path d="M0,0 V4 L3,2 Z" fill={c} />
          </marker>
        ))}
      </defs>
      {shapes.map((s, i) => {
        if (!s.dest) return null;
        const path = knightLPath(s.orig, s.dest, orientation);
        if (!path) return null;
        const color =
          (s.brush && BRUSH_COLOR[s.brush]) ?? BRUSH_COLOR.green;
        return (
          <g key={i} opacity={0.85}>
            <path
              d={path.d}
              stroke={color}
              strokeWidth={2.4}
              strokeLinecap="butt"
              strokeLinejoin="round"
              fill="none"
              markerEnd={`url(#knight-arrowhead-${markerId(color)})`}
            />
          </g>
        );
      })}
    </svg>
  );
}

/** Convert a hex / colour string into something safe for an SVG `id`. */
function markerId(color: string): string {
  return color.replace(/[^a-zA-Z0-9]/g, '');
}

const HIGHLIGHT_COLOR: Record<NonNullable<NonNullable<BoardProps['highlightSquares']>[number]['color']>, string> = {
  hint: '#7aa2f7',
  wrong: '#e06c75',
  right: '#7bc47f',
};

/**
 * Renders a colored ring on each requested square. Used for hints (blue)
 * and feedback (red/green) during repertoire training.
 */
function SquareHighlightOverlay({
  squares,
  orientation,
}: {
  squares: NonNullable<BoardProps['highlightSquares']>;
  orientation: 'white' | 'black';
}) {
  if (squares.length === 0) return null;
  return (
    <svg
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      className="absolute inset-0 pointer-events-none"
      style={{ width: '100%', height: '100%', zIndex: 9 }}
    >
      {squares.map((sq, i) => {
        const c = squareToPct(sq.square, orientation);
        const color = HIGHLIGHT_COLOR[sq.color ?? 'hint'];
        return (
          <circle
            key={`${sq.square}-${i}`}
            cx={c.x}
            cy={c.y}
            // 12.5% per square; ring just inside the square edge.
            r={5}
            fill="none"
            stroke={color}
            strokeWidth={1.2}
            opacity={0.9}
          />
        );
      })}
    </svg>
  );
}

function isPawnOn(fen: string, square: string): boolean {
  try {
    const c = new Chess();
    c.load(fen);
    const piece = c.get(square as Square);
    return piece?.type === 'p';
  } catch {
    return false;
  }
}

function BadgeOverlay({
  square,
  orientation,
  className,
  children,
}: {
  square: string;
  orientation: 'white' | 'black';
  className: string;
  children: React.ReactNode;
}) {
  // Convert algebraic to 0..7 file/rank indices.
  const fileIdx = square.charCodeAt(0) - 'a'.charCodeAt(0);
  const rankIdx = Number(square[1]) - 1;
  // Chessground renders a1 at bottom-left when orientation is white.
  const boardFile = orientation === 'white' ? fileIdx : 7 - fileIdx;
  const boardRank = orientation === 'white' ? 7 - rankIdx : rankIdx;
  const leftPct = (boardFile / 8) * 100;
  const topPct = (boardRank / 8) * 100;
  return (
    <div
      className="absolute pointer-events-none flex items-center justify-center"
      style={{
        left: `calc(${leftPct}% + 12.5% - 14px)`,
        top: `calc(${topPct}% - 2px)`,
        width: 28,
        height: 28,
      }}
    >
      <span
        className={`inline-flex items-center justify-center rounded-full text-[11px] font-bold shadow-md border border-black/20 ${className}`}
        style={{ width: 28, height: 28, lineHeight: 1 }}
      >
        {children}
      </span>
    </div>
  );
}
