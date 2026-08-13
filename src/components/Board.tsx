import { useEffect, useMemo, useRef, useState } from 'react';
import { Chessground } from 'chessground';
import type { Api as CgApi } from 'chessground/api';
import type { Config as CgConfig } from 'chessground/config';
import type { Color as CgColor, Key } from 'chessground/types';
import type { DrawShape } from 'chessground/draw';
import { Chess, type Square } from 'chess.js';
import { playMove, playMoveSound } from '@/audio/moveSounds';
import { useTranslation } from 'react-i18next';
import type { Classification } from '@/db/schema';
import { PRIMARY_BOARD_MAX_PX } from './BoardFrame';
import { ClassificationIcon } from './ClassificationIcon';
import { tClassification } from '@/i18n/chess';

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
  /**
   * Play a sound when a piece lands (and a buzz when a move is rejected).
   *
   * Opt-in rather than default-on: this component also draws preview
   * thumbnails and auto-playing solution boards, and those firing clicks
   * unbidden would be noise, not feedback. Turn it on for boards a human is
   * actually playing or stepping through. Honours the user's global
   * sound preference either way.
   */
  sounds?: boolean;
}

/** chess.com's right-click red. Used both for the chessground `green` brush
 *  override (so default right-click feels native) and for our knight L-path
 *  overlay's stroke. */
const CHESS_COM_RED = '#dc4a4a';
const ENGINE_BEST_GREEN = '#15781B';

// Per-classification badge background + foreground. The icon glyph
// itself comes from `<ClassificationIcon>` (inline SVG, inherits
// `currentColor`), so we no longer keep a `symbol` field here. Text
// glyphs (`!!`, `??`, `🕮`) used to live here and broke across
// platforms — see ClassificationIcon for the full story.
const CLASSIFICATION_BADGE: Record<
  Classification,
  { bg: string; fg: string }
> = {
  brilliant: { bg: 'bg-brilliant', fg: 'text-white' },
  best: { bg: 'bg-good', fg: 'text-white' },
  excellent: { bg: 'bg-good/80', fg: 'text-white' },
  good: { bg: 'bg-slate-400', fg: 'text-white' },
  // Background is the centralised `book` token (`tailwind.config.js`)
  // — a chess.com-style light brown. White glyph reads cleanly on it.
  book: { bg: 'bg-book', fg: 'text-white' },
  inaccuracy: { bg: 'bg-inaccuracy', fg: 'text-black' },
  miss: { bg: 'bg-miss', fg: 'text-white' },
  mistake: { bg: 'bg-mistake', fg: 'text-black' },
  blunder: { bg: 'bg-blunder', fg: 'text-white' },
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

/**
 * Square -> chessground's internal `pos2user` coords. Chessground's
 * shape SVG uses `viewBox="-4 -4 8 8"`, so each square is exactly 1 unit
 * wide, the centre of `a1` (white POV) sits at (-3.5, 3.5) and h8 at
 * (3.5, -3.5). We mirror the math so our knight overlay shares the same
 * coordinate system as chessground's straight arrows — that's what
 * makes stroke widths, arrowhead sizes, and arrow shortening line up
 * pixel-for-pixel.
 */
function squareToCgUser(
  square: string,
  orientation: 'white' | 'black',
): { x: number; y: number } {
  const fileIdx = square.charCodeAt(0) - 'a'.charCodeAt(0);
  const rankIdx = Number(square[1]) - 1;
  const boardFile = orientation === 'white' ? fileIdx : 7 - fileIdx;
  const boardRank = orientation === 'white' ? rankIdx : 7 - rankIdx;
  // pos2user(pos) = (pos[0] - 3.5, 3.5 - pos[1]) in user units.
  return { x: boardFile - 3.5, y: 3.5 - boardRank };
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
  sounds = false,
}: BoardProps) {
  const { t } = useTranslation();
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const boardRef = useRef<HTMLDivElement | null>(null);
  const api = useRef<CgApi | null>(null);
  /** Set to true for exactly one FEN sync when the USER just played a move.
   *  Suppresses chessground's re-animation so the piece doesn't appear to
   *  jump back and forward. */
  const skipNextAnim = useRef(false);
  /** Knight-jump shapes split out from chessground for our L-path overlay.
   *  Non-knight shapes (circles + straight arrows) stay inside chessground
   *  and persist there until the user erases them or the FEN changes.
   *  `destShareCount` mirrors chessground's `dests` collision map so the
   *  knight L-path can shorten its final leg by `arrowMargin(20/64)`
   *  whenever another arrow points at the same square — exactly like a
   *  straight arrow would. */
  const [knightOverlay, setKnightOverlay] = useState<{
    shapes: DrawShape[];
    destShareCount: Map<string, number>;
  }>({ shapes: [], destShareCount: new Map() });
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
  const soundsRef = useRef(sounds);
  soundsRef.current = sounds;
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
      // Have chessground publish its resolved board size via CSS custom
      // properties (`---cg-width` / `---cg-height`) on our outer wrapper.
      // chessground floors the container to a multiple of 8 pixels (so
      // every square is integer-sized and pieces align to whole pixels;
      // see `updateBounds` in chessground/render.ts), which means a
      // wrapper sized at e.g. 348 px ends up with chessground rendering
      // at 344 px. Without these CSS vars our percentage-based hint
      // overlay sized off the *outer* wrapper drifts a few pixels off
      // chessground's actual squares — visible as the "off-center hint
      // ring" complaint. The overlay now uses these vars to share
      // chessground's exact square geometry. See `SquareHighlightOverlay`
      // for the consuming side.
      addDimensionsCssVarsTo: wrapRef.current ?? undefined,
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
              // Rejected: the piece is about to snap back, so say so. Read
              // through the ref because this handler is installed once at
              // init and would otherwise close over the initial prop.
              if (soundsRef.current) playMoveSound('illegal');
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

          // Tally how many shapes target each destination across every
          // arrow chessground knows about (including knight shapes that
          // are now `invisible`-brushed). This matches chessground's own
          // `dests` collision detection (see svg.ts `isShort`) and tells
          // the knight overlay which final-leg margin to use.
          const destShareCount = new Map<string, number>();
          for (const s of next) {
            if (s.dest && s.orig !== s.dest) {
              destShareCount.set(s.dest, (destShareCount.get(s.dest) ?? 0) + 1);
            }
          }

          if (mutated) api.current?.setShapes(next);
          setKnightOverlay({ shapes: overlayKnights, destShareCount });
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
    setKnightOverlay({ shapes: [], destShareCount: new Map() });
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

  // ── move sounds ─────────────────────────────────────────────────────────
  //
  // Driven by `(fen, lastMoveUci)` rather than by the user's own drag, so one
  // hook covers every way a piece lands: the user playing, the opponent
  // auto-playing, an engine reply, stepping through a game. `soundedFenRef`
  // both suppresses the cue on first paint (arriving at a position is not a
  // move being played) and stops a re-render from replaying the same move.
  const soundedFenRef = useRef<string | null>(null);
  const fenBeforeSoundRef = useRef<string | null>(null);
  useEffect(() => {
    const previous = soundedFenRef.current;
    soundedFenRef.current = fen;
    const fenBefore = fenBeforeSoundRef.current;
    fenBeforeSoundRef.current = fen;
    if (!sounds) return;
    // First position we ever see, or a position reached without a move.
    if (previous === null || previous === fen || !lastMoveUci) return;
    playMove({ fenBefore: fenBefore ?? undefined, fenAfter: fen, uci: lastMoveUci });
  }, [fen, lastMoveUci, sounds]);

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

  // ── Long-press → annotation arrow (touch-screen fallback) ──────────────
  //
  // Chessground triggers its annotation-arrow draw mode on right-click
  // (mouse) or shift+click (keyboard). Touch screens have neither, so
  // mobile users couldn't draw the chess.com-style red arrows that
  // power our review / weakness flows at all.
  //
  // The standard touch-UI fix is "long-press" — hold a finger on the
  // board for ~350 ms without moving, and the gesture switches from
  // "drag a piece" to "draw an arrow". We implement it by watching
  // touchstart on the wrapper and, if the finger stays close to its
  // starting point for `LONG_PRESS_MS`, cancel any drag chessground
  // may have started, then drive chessground's own draw API
  // (`api.setShapes`) from subsequent touchmove + touchend events.
  //
  // We intentionally don't pre-empt the touchstart: short taps (tap to
  // select / drop a piece) still flow through chessground unchanged.
  // Only after we're confident this is a long-press do we steal the
  // gesture. Haptic feedback (`navigator.vibrate(15)`) signals the
  // mode switch the way iOS / Android system pickers do.
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    // Long-press → arrow works on every board, even read-only ones —
    // chessground's drawable.enabled is set unconditionally during
    // init, so users can annotate the openings library / weakness
    // previews / cards trainer answer state too. Piece-drag is the
    // separate concern gated by `viewOnly`, and we don't intercept
    // short taps regardless of `viewOnly` state.

    const LONG_PRESS_MS = 350;
    const MOVE_TOLERANCE_PX = 12;

    let timer: ReturnType<typeof setTimeout> | null = null;
    let startX = 0;
    let startY = 0;
    let drawing = false;
    let origKey: Key | null = null;

    function clearTimer() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    }

    function exitDrawMode() {
      drawing = false;
      origKey = null;
    }

    function onTouchStart(e: TouchEvent) {
      if (e.touches.length !== 1) return;
      clearTimer();
      const t = e.touches[0];
      startX = t.clientX;
      startY = t.clientY;
      drawing = false;
      origKey = null;

      timer = setTimeout(() => {
        const cg = api.current;
        if (!cg) return;
        // Use chessground's own square-resolver so the orig square
        // matches whatever pixel math the rest of the board uses.
        const orig = cg.getKeyAtDomPos([startX, startY]);
        if (!orig) return;
        // Cancel any drag chessground may have started in the
        // interim — we're stealing the gesture for annotation.
        cg.cancelMove();
        drawing = true;
        origKey = orig;
        // Render the start-square ring immediately so the user gets
        // visual confirmation the mode switched. (Chessground draws
        // the same ring during a normal right-click draw.)
        cg.setShapes([
          ...cg.state.drawable.shapes,
          { orig, brush: 'red' } as DrawShape,
        ]);
        if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
          try {
            navigator.vibrate?.(15);
          } catch {
            /* noop — Vibration API rejected by user / unsupported */
          }
        }
      }, LONG_PRESS_MS);
    }

    function onTouchMove(e: TouchEvent) {
      if (e.touches.length !== 1) {
        clearTimer();
        return;
      }
      const t = e.touches[0];
      if (!drawing) {
        // Cancel the long-press timer if the finger drifts past the
        // tolerance — that's a normal drag, not a hold.
        const dx = Math.abs(t.clientX - startX);
        const dy = Math.abs(t.clientY - startY);
        if (dx > MOVE_TOLERANCE_PX || dy > MOVE_TOLERANCE_PX) {
          clearTimer();
        }
        return;
      }
      // We're drawing: prevent chessground from interpreting this as a
      // drag, and update the preview shape with the current dest square.
      e.preventDefault();
      e.stopPropagation();
      const cg = api.current;
      if (!cg || !origKey) return;
      const dest = cg.getKeyAtDomPos([t.clientX, t.clientY]);
      const next: DrawShape =
        dest && dest !== origKey
          ? { orig: origKey, dest, brush: 'red' }
          : { orig: origKey, brush: 'red' };
      // Replace the *last* shape (our preview) so we don't pile up a
      // new arrow on every pixel of movement.
      const shapes = cg.state.drawable.shapes.slice();
      // Drop the previously-rendered preview (it's the last `red`
      // shape sharing our origin). If nothing matches, just append.
      for (let i = shapes.length - 1; i >= 0; i--) {
        const s = shapes[i];
        if (s.orig === origKey && s.brush === 'red') {
          shapes.splice(i, 1);
          break;
        }
      }
      shapes.push(next);
      cg.setShapes(shapes);
    }

    function onTouchEnd(e: TouchEvent) {
      clearTimer();
      if (!drawing) return;
      e.preventDefault();
      e.stopPropagation();
      const cg = api.current;
      if (cg) {
        // Drop dest-less ring previews: a "ring at orig with no dest"
        // is the visual mid-drag preview, not a final shape. Real
        // right-click drags only commit either an arrow (orig+dest) or
        // an explicit click-on-square ring (orig === dest). If the
        // user lifted off without moving, treat it as no-op.
        const finalShapes = cg.state.drawable.shapes.filter((s) => {
          if (!(s.orig === origKey && s.brush === 'red')) return true;
          return !!s.dest;
        });
        cg.setShapes(finalShapes);
        // chessground's `setShapes` does NOT fire `drawable.onChange`
        // (only `draw.end` does). Manually invoke so our Board-level
        // onChange — which routes knight arrows into an L-overlay and
        // dedups same-shape redraws — runs the same code path it would
        // for a real right-click commit.
        cg.state.drawable.onChange?.(cg.state.drawable.shapes);
      }
      exitDrawMode();
    }

    function onTouchCancel() {
      clearTimer();
      if (drawing) {
        // Drop the preview shape that we tentatively pushed.
        const cg = api.current;
        if (cg && origKey) {
          const shapes = cg.state.drawable.shapes.filter(
            (s) => !(s.orig === origKey && s.brush === 'red' && !s.dest),
          );
          cg.setShapes(shapes);
        }
        exitDrawMode();
      }
    }

    wrap.addEventListener('touchstart', onTouchStart, { passive: true });
    wrap.addEventListener('touchmove', onTouchMove, { passive: false });
    wrap.addEventListener('touchend', onTouchEnd, { passive: false });
    wrap.addEventListener('touchcancel', onTouchCancel, { passive: true });

    return () => {
      clearTimer();
      wrap.removeEventListener('touchstart', onTouchStart);
      wrap.removeEventListener('touchmove', onTouchMove);
      wrap.removeEventListener('touchend', onTouchEnd);
      wrap.removeEventListener('touchcancel', onTouchCancel);
    };
  }, []);

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
    <div
      ref={wrapRef}
      className="relative aspect-square w-full mx-auto"
      style={{ maxWidth: PRIMARY_BOARD_MAX_PX }}
    >
      <div ref={boardRef} className="w-full h-full" />
      <SquareHighlightOverlay squares={highlightSquares} orientation={orientation} />
      <KnightArrowOverlay
        shapes={knightOverlay.shapes}
        destShareCount={knightOverlay.destShareCount}
        orientation={orientation}
      />
      {badge && lastMoveUci && lastMoveClassification && (
        <BadgeOverlay
          square={lastMoveUci.slice(2, 4)}
          orientation={orientation}
          className={`${badge.bg} ${badge.fg}`}
          // Stable hook for e2e tests. Tailwind classes like `bg-good/80`
          // contain `/`, which CSS selectors can't query with a plain
          // `.bg-good`, and renames (e.g. `bg-slate-500` → `bg-book` in
          // the move-list-color refactor) silently invalidate any
          // class-based assertion in the e2e suite. A `data-` attribute
          // tied to the classification name is renamer-proof.
          classification={lastMoveClassification}
        >
          <ClassificationIcon
            classification={lastMoveClassification}
            size={18}
            aria-label={tClassification(t, lastMoveClassification)}
          />
        </BadgeOverlay>
      )}
    </div>
  );
}

/** Mirrors the chessground brush palette we configure in `Board()`. Each
 *  entry has the same `color` / `opacity` / `lineWidth` used in the
 *  chessground brushes config above so straight arrows and knight
 *  L-arrows render with identical stroke widths and tints. Keep them in
 *  sync if either palette changes.
 *
 *  `green` and `red` both map to chess.com red because that's what
 *  chessground does for user-drawn shapes (the brush remap above
 *  rewrites green → CHESS_COM_RED). `engineBest` retains chessground's
 *  classic green for the analysis review's recommendation arrow.
 */
const KNIGHT_BRUSH: Record<string, { color: string; opacity: number; lineWidth: number }> = {
  green: { color: CHESS_COM_RED, opacity: 0.85, lineWidth: 12 },
  red: { color: CHESS_COM_RED, opacity: 0.85, lineWidth: 12 },
  blue: { color: '#003088', opacity: 0.85, lineWidth: 12 },
  yellow: { color: '#e68f00', opacity: 0.85, lineWidth: 12 },
  engineBest: { color: ENGINE_BEST_GREEN, opacity: 0.9, lineWidth: 12 },
};

/**
 * Renders an L-shaped knight arrow that matches chessground's straight
 * arrows pixel-for-pixel: same coordinate system (viewBox `-4 -4 8 8`,
 * `xMidYMid slice`), same stroke width (`lineWidth/64` user units),
 * same opacity application (only on the `<line>`, not on a parent
 * group), same arrowhead marker geometry (`M0,0 V4 L3,2 Z`, `refX=2.05`,
 * `refY=2`, `markerWidth=4`), and the same tail shortening
 * (`arrowMargin = 10/64` for a single arrow, `20/64` when another arrow
 * targets the same square — i.e. `isShort` from chessground/src/svg.ts).
 *
 * Why the careful match: previously the L-arrow used a different SVG
 * coordinate system (`viewBox 0 0 100 100`, `preserveAspectRatio
 * "none"`), butt linecaps, and a parent-group `opacity`. The result
 * looked DARKER than the regular straight arrows (the line + arrowhead
 * fill stacked their alpha at the corner) and ran all the way to the
 * destination corner, visually pushing colliding straight arrows off
 * their square. Mirroring chessground's geometry exactly fixes both:
 * stacking is identical, and our knight participates in the same
 * `arrowMargin` shortening rule that chessground applies to the
 * straight arrow it's colliding with.
 */
function KnightArrowOverlay({
  shapes,
  destShareCount,
  orientation,
}: {
  shapes: DrawShape[];
  destShareCount: Map<string, number>;
  orientation: 'white' | 'black';
}) {
  if (shapes.length === 0) return null;
  return (
    <svg
      viewBox="-4 -4 8 8"
      preserveAspectRatio="xMidYMid slice"
      className="absolute inset-0 pointer-events-none"
      // z-index 9 matches chessground's `.cg-custom-svgs` so the L-shape is
      // painted above pieces (z-index 2/8) but below a piece being dragged
      // (z-index 11), exactly like chess.com.
      //
      // CRITICAL: chessground's `.cg-shapes` stylesheet applies an
      // SVG-level `opacity: 0.6` on top of each per-arrow `opacity: 0.85`,
      // landing at an effective ~0.51 alpha for user arrows (see
      // node_modules/chessground/assets/chessground.base.css:113-117).
      // Our overlay must inherit the same outer multiplier or every
      // knight arrow renders noticeably brighter / more saturated than
      // the straight arrows next to it. (Pixel sampling confirmed it:
      // knight RGB(216,89,84) vs straight RGB(230,143,126) over the
      // same brush — exactly the 0.85 → 0.51 alpha gap.)
      style={{ width: '100%', height: '100%', zIndex: 9, opacity: 0.6 }}
    >
      <defs>
        {shapes.map((s, i) => {
          const cfg = brushFor(s);
          return (
            <marker
              key={`m-${i}-${cfg.color}`}
              id={`knight-arrowhead-${i}`}
              viewBox="0 0 4 4"
              refX="2.05"
              refY="2"
              markerWidth="4"
              markerHeight="4"
              orient="auto"
              overflow="visible"
            >
              <path d="M0,0 V4 L3,2 Z" fill={cfg.color} />
            </marker>
          );
        })}
      </defs>
      {shapes.map((s, i) => {
        if (!s.dest) return null;
        const cfg = brushFor(s);
        const a = squareToCgUser(s.orig, orientation);
        const b = squareToCgUser(s.dest, orientation);
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        // Long leg first along the axis with larger magnitude — that's
        // the chess.com convention.
        const longHoriz = Math.abs(dx) > Math.abs(dy);
        const corner = longHoriz ? { x: b.x, y: a.y } : { x: a.x, y: b.y };
        // Shorten the final leg so the line tip sits inside the
        // arrowhead, exactly like chessground does for straight arrows.
        // Chessground uses `arrowMargin = (shorten ? 20 : 10) / 64`, with
        // `shorten=true` whenever another arrow targets the same square.
        const shorten = (destShareCount.get(s.dest) ?? 0) > 1;
        const margin = (shorten ? 20 : 10) / 64;
        const legDx = b.x - corner.x;
        const legDy = b.y - corner.y;
        const legLen = Math.hypot(legDx, legDy) || 1;
        const tipX = b.x - (legDx / legLen) * margin;
        const tipY = b.y - (legDy / legLen) * margin;
        const d = `M ${a.x} ${a.y} L ${corner.x} ${corner.y} L ${tipX} ${tipY}`;
        const strokeWidth = cfg.lineWidth / 64;
        return (
          <path
            key={`p-${i}`}
            d={d}
            stroke={cfg.color}
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
            opacity={cfg.opacity}
            markerEnd={`url(#knight-arrowhead-${i})`}
          />
        );
      })}
    </svg>
  );
}

/** Look up the chessground-equivalent brush config for a knight shape.
 *  Falls back to `green` (chess.com red) for unknown brushes so we never
 *  render a stray black default. */
function brushFor(shape: DrawShape): {
  color: string;
  opacity: number;
  lineWidth: number;
} {
  const key = shape.brush ?? 'green';
  return KNIGHT_BRUSH[key] ?? KNIGHT_BRUSH.green;
}

const HIGHLIGHT_COLOR: Record<NonNullable<NonNullable<BoardProps['highlightSquares']>[number]['color']>, string> = {
  hint: '#7aa2f7',
  wrong: '#e06c75',
  right: '#7bc47f',
};

/**
 * Renders a colored ring on each requested square. Used for hints (blue)
 * and feedback (red/green) during repertoire training and puzzles.
 *
 * Implementation note: we used to draw this as an SVG circle with
 * `viewBox="0 0 100 100" preserveAspectRatio="none"`, then as a stack of
 * absolutely-positioned `div`s sized at 12.5% × 12.5% of the *outer
 * wrapper*. Both still drifted a few pixels off-centre on viewport
 * widths that aren't multiples of 8: chessground floors its inner
 * container to a multiple of 8 px (`updateBounds` in
 * chessground/render.ts) so each square stays integer-sized, which
 * means the chessground content is up to 7 px narrower than the outer
 * wrapper. Our percentage overlay sized off the wrapper would land 1–4
 * px past where the actual piece sits — that's the "circle is off
 * centre" complaint.
 *
 * Fix: chessground publishes its resolved board dimensions on our
 * wrapper via CSS custom properties (`---cg-width` / `---cg-height`,
 * three dashes — chessground's literal name). The overlay sizes itself
 * to those exact pixel dimensions and the per-cell children stay at the
 * same 12.5% percentages, so they share chessground's rounding and the
 * ring stays glued to the square centre on every viewport. Falls back
 * to `100%` before chessground has a chance to set the vars (first
 * paint), which matches the previous behaviour for that one frame.
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
    <div
      className="pointer-events-none"
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: 'var(---cg-width, 100%)',
        height: 'var(---cg-height, 100%)',
        zIndex: 9,
      }}
    >
      {squares.map((sq, i) => {
        const fileIdx = sq.square.charCodeAt(0) - 'a'.charCodeAt(0);
        const rankIdx = Number(sq.square[1]) - 1;
        const boardFile = orientation === 'white' ? fileIdx : 7 - fileIdx;
        const boardRank = orientation === 'white' ? 7 - rankIdx : rankIdx;
        const color = HIGHLIGHT_COLOR[sq.color ?? 'hint'];
        // Per-square cell at exactly 12.5% × 12.5% of the board, in the
        // same percentage grid chessground uses for pieces — this keeps
        // the ring centered on every viewport size. The inner ring is
        // 80% of the cell so it sits just inside the square edge,
        // leaving the piece visible underneath.
        return (
          <div
            key={`${sq.square}-${i}`}
            style={{
              position: 'absolute',
              left: `${boardFile * 12.5}%`,
              top: `${boardRank * 12.5}%`,
              width: '12.5%',
              height: '12.5%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <div
              style={{
                width: '80%',
                height: '80%',
                borderRadius: '50%',
                border: `2px solid ${color}`,
                opacity: 0.9,
                boxSizing: 'border-box',
              }}
            />
          </div>
        );
      })}
    </div>
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
  classification,
  children,
}: {
  square: string;
  orientation: 'white' | 'black';
  className: string;
  classification: Classification;
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
        data-test-classification-badge={classification}
      >
        {children}
      </span>
    </div>
  );
}
