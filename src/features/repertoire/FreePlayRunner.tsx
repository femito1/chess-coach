import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Chess } from 'chess.js';
import { Board } from '@/components/Board';
import { BoardFrame } from '@/components/BoardFrame';
import { EvalBar, mateForWhite } from '@/components/EvalBar';
import { useLiveEval, getCachedLiveEval } from '@/features/review/LiveEval';
import { classifyMove } from '@/engine/classify';
import type { Classification } from '@/db/schema';
import { tClassification } from '@/i18n/chess';
import {
  FREE_PLAY_STRENGTHS,
  pickEngineMove,
  cancelFreePlayIdleTeardown,
  scheduleFreePlayIdleTeardown,
  type FreePlayStrength,
} from '@/engine/freePlayEngine';
import {
  FREE_PLAY_THINK_MS,
  sampleDelay,
  waitUntilElapsed,
} from '@/lib/humanTiming';

export interface FreePlayRunnerProps {
  /** Position the user is starting from. Typically the last FEN of the
   *  repertoire line they just finished drilling, but the component
   *  doesn't care — any legal FEN works. */
  startFen: string;
  /** The colour the user plays. The opening repertoire defines this;
   *  Stockfish takes the other side. */
  userColor: 'white' | 'black';
  /** Strength stored on the user's Settings row. The runner seeds its
   *  own per-session state from this on mount; subsequent in-runner
   *  changes don't write back to Settings (the user can pick a per-line
   *  difficulty without rewriting their global preference). */
  initialStrength: FreePlayStrength;
  /** Fired when the user clicks "Back to practice" — wires the practice
   *  page back into its line-finished flow. */
  onExit: () => void;
}

type GameOverReason =
  | 'checkmate'
  | 'stalemate'
  | 'fiftyMove'
  | 'repetition'
  | 'insufficient'
  | 'resigned';

interface MoveRecord {
  uci: string;
  san: string;
  fenAfter: string;
  side: 'user' | 'engine';
  classification?: Classification;
}

function detectGameOver(chess: Chess): GameOverReason | null {
  if (chess.isCheckmate()) return 'checkmate';
  if (chess.isStalemate()) return 'stalemate';
  if (chess.isInsufficientMaterial()) return 'insufficient';
  if (chess.isThreefoldRepetition()) return 'repetition';
  // chess.js exposes `isDraw()` which lumps in 50-move; we want to
  // separate it so the status copy is informative.
  // The 50-move clock is `halfmoves` — exposed via FEN field 4.
  const halfmoves = Number(chess.fen().split(' ')[4] ?? 0);
  if (Number.isFinite(halfmoves) && halfmoves >= 100) return 'fiftyMove';
  return null;
}

/**
 * "Play it out vs Stockfish" widget. Drops the user into the position
 * they just finished drilling and lets them play through the rest of
 * the game against a configurable-strength engine, with their moves
 * classified live (chess.com-style badge on the board) and an eval bar
 * tracking the position from White's POV.
 *
 * Architecture notes:
 *   - The opponent's reply runs on its own singleton worker
 *     (`freePlayEngine.ts`) so it doesn't fight the live-eval consumer
 *     for the review-page singleton.
 *   - The user's own move is classified by feeding pre/post FENs through
 *     the same `classifyMove` heuristic the analyzer + the review page's
 *     exploration mode use. We pull the "before" eval from
 *     `getCachedLiveEval(prevFen)` (populated by `useLiveEval` on the
 *     prior render) and the "after" eval from the live-eval consumer
 *     for the new position. Engine moves don't get a classification —
 *     they're optimal by definition, and badging them every ply would
 *     be visually noisy.
 *   - All state is ephemeral: no Dexie writes, no Game row, no analyses
 *     row. Navigating away or clicking "Back to practice" discards the
 *     played-out game, matching the design decision in the plan.
 */
export function FreePlayRunner({
  startFen,
  userColor,
  initialStrength,
  onExit,
}: FreePlayRunnerProps) {
  const opponentColor = userColor === 'white' ? 'black' : 'white';

  // ── State model ─────────────────────────────────────────────────────
  // `history` is the linear timeline of moves played so far (the "tip"
  // of play). `cursor` is the current viewing position along that
  // timeline: 0 = `startFen`, 1 = after history[0], ..., history.length
  // = the tip. ←/→ arrows scrub the cursor between checkpoints (see
  // `prevCheckpoint`/`nextCheckpoint`); making a NEW move while
  // `cursor < history.length` truncates history at the cursor and
  // appends the new move (lichess/chess.com analysis-board "discard
  // future variation" semantics, the user's pick on 2026-05-20).
  //
  // Why cursor + history rather than two separate timelines: it keeps
  // there always being exactly one "tip" the engine is allowed to
  // reply on, avoids tracking a tree, and means scrubbing back to
  // re-check a prior position is just `setCursor`, no FEN math.
  const [history, setHistory] = useState<MoveRecord[]>([]);
  const [cursor, setCursor] = useState(0);
  const [strength, setStrength] = useState<FreePlayStrength>(initialStrength);
  const [thinking, setThinking] = useState(false);
  const [gameOver, setGameOver] = useState<GameOverReason | null>(null);
  /** True for ~4s after mount — status-bar hint only (does not push layout). */
  const [showBanner, setShowBanner] = useState(true);
  /** Delay engine work until after first paint so remounting the board
   *  isn't competing with two Stockfish cold-boots on the same frame. */
  const [enginesReady, setEnginesReady] = useState(false);

  // Derived board-state: position the user is currently *viewing*
  // (which is the tip when `cursor === history.length`, otherwise a
  // historical position).
  const currentEntry = cursor > 0 ? history[cursor - 1] : null;
  const currentFen = currentEntry ? currentEntry.fenAfter : startFen;
  const lastUci = currentEntry?.uci;
  // Only the user-move at the EXACT cursor position gets its badge
  // painted on the board. Older user moves don't (a past badge sitting
  // on a piece the user has since moved is confusing); engine moves
  // never get a badge by design.
  const lastClassification =
    currentEntry && currentEntry.side === 'user'
      ? currentEntry.classification
      : undefined;
  const atTip = cursor === history.length;

  // Cancellation token for in-flight opponent moves. If the user clicks
  // "Back to practice" while Stockfish is searching, we want to abandon
  // the result rather than commit a stale reply onto a now-unmounted
  // (or reset) board. Also bumped on `restart`, `resign`, and any
  // cursor change so a search kicked off at the tip can't land
  // mid-scrub.
  const opponentTokenRef = useRef(0);

  // Banner auto-dismiss.
  useEffect(() => {
    const id = window.setTimeout(() => setShowBanner(false), 4000);
    return () => window.clearTimeout(id);
  }, []);

  // Open the engine gate after paint. Double-rAF waits for the board
  // layout to settle; a short timeout keeps WASM init off the click
  // frame so the transition doesn't feel hitchy.
  useEffect(() => {
    let cancelled = false;
    let timeoutId = 0;
    let raf2 = 0;
    const raf1 = window.requestAnimationFrame(() => {
      raf2 = window.requestAnimationFrame(() => {
        timeoutId = window.setTimeout(() => {
          if (!cancelled) setEnginesReady(true);
        }, 80);
      });
    });
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(raf1);
      window.cancelAnimationFrame(raf2);
      if (timeoutId) window.clearTimeout(timeoutId);
    };
  }, []);

  // Bump the opponent token on unmount so any in-flight Stockfish reply
  // is dropped instead of being committed onto a stale board. Defer the
  // worker teardown via a short idle timer (same pattern as
  // `releaseLiveEval` for the review-page engine): we DO want to free
  // the ~30 MB WASM heap when the user leaves practice, but we DO NOT
  // want to nuke it during React StrictMode's dev-only fake unmount/
  // remount cycle, which would kill an in-flight `analyze` between
  // mount-1 and mount-2 and leave the worker pointing at `null` — every
  // subsequent `setOption`/`position`/`go` then no-ops because
  // `this.worker?.postMessage` short-circuits, and the React effect
  // deadlocks waiting for a `bestmove` that never comes. The 1.5s grace
  // window is short enough that real navigations away free the heap
  // promptly, but long enough that StrictMode's synchronous remount
  // cancels the timer before it fires.
  useEffect(() => {
    return () => {
      opponentTokenRef.current += 1;
      // Next mount (StrictMode remount or re-entry) cancels this via
      // `cancelFreePlayIdleTeardown` so we don't kill an in-flight
      // search between mount-1 and mount-2.
      scheduleFreePlayIdleTeardown(1500);
    };
  }, []);

  // Cancel any pending teardown from a just-prior CTA unmount or
  // StrictMode fake unmount before we start using the opponent worker.
  useEffect(() => {
    cancelFreePlayIdleTeardown();
  }, []);

  // Live engine eval for the *current* board position (i.e. whichever
  // position the cursor is pointing at — tip OR a scrubbed-back
  // history position). Drives the eval bar; also supplies the
  // post-move winrate we feed into `classifyMove` when the cursor is
  // at the tip and the tip's last entry is a fresh unclassified user
  // move. Scrubbing back makes the bar reflect the historical
  // position — this is consistent with review-page exploration and is
  // exactly what the user expects when looking at a prior decision.
  // Keep evaluating after game-over so the mating / final user move can
  // still classify (and the eval bar shows the terminal position). Only
  // the opponent search loop is gated on `gameOver`.
  const liveEval = useLiveEval(enginesReady ? currentFen : '', 14);

  // Side to move at the current position. Derived from the FEN so we
  // don't have to trust an external source-of-truth.
  const stm: 'white' | 'black' = useMemo(
    () => (currentFen.split(' ')[1] === 'w' ? 'white' : 'black'),
    [currentFen],
  );
  // `isUserTurn` covers both gating user input on the Board AND
  // whether the engine should reply. We additionally require the
  // cursor to be at the tip (`atTip`) — scrubbing back to a historical
  // position with engine-to-move must NOT trigger a fresh search.
  const isUserTurn = stm === userColor && !gameOver && atTip;

  // Classify the tip's most recent user move once the live eval for
  // the resulting position lands. Gated on `atTip` so a scrub back to
  // a historical position doesn't accidentally re-classify the tip's
  // user move using an eval for a different (cursor-pointed) FEN.
  //
  // The before/after winrate plumbing mirrors the review page's
  // exploration classification (see ReviewPage.tsx ~line 95):
  //   - "before" = cached live eval of the position prior to the user's
  //     move (populated by `useLiveEval` on the previous render, or by
  //     the user's earlier visit to that position via the back arrow).
  //   - "after"  = current live eval of the new position.
  // For the very first move (`startFen` had no prior eval), we treat
  // the position as not-yet-classifiable and skip the badge — the next
  // move will start the chain.
  useEffect(() => {
    if (!atTip) return;
    if (history.length === 0) return;
    const last = history[history.length - 1];
    if (last.side !== 'user') return;
    if (last.classification) return;
    if (!liveEval || liveEval.running) return;
    const prevFen =
      history.length >= 2 ? history[history.length - 2].fenAfter : startFen;
    const cached = getCachedLiveEval(prevFen);
    if (!cached) return;
    const moverWinrateBefore = cached.winrateStm;
    const moverWinrateAfter = 1 - liveEval.winrateStm;
    const isBest =
      cached.bestMoveUci != null && cached.bestMoveUci === last.uci;
    const classification = classifyMove({
      moverWinrateBefore,
      moverWinrateAfter,
      isBest,
      ply: 99,
      inBookPhase: false,
      fenBefore: prevFen,
      fenAfter: last.fenAfter,
      playedUci: last.uci,
    });
    setHistory((h) => {
      const next = h.slice();
      next[next.length - 1] = { ...next[next.length - 1], classification };
      return next;
    });
  }, [history, liveEval, startFen, atTip]);

  // Opponent move loop. Whenever it's the engine's turn AT THE TIP
  // and the game isn't over, fire `pickEngineMove` and commit the
  // result. The `atTip` guard prevents a search from being kicked off
  // while the user is scrubbing back through history — the engine
  // shouldn't think on a position that isn't actually being played
  // out. We use a token so a stale reply (from a position the user
  // has since rewound away from, restarted, or replaced via a
  // different move) is dropped instead of being applied.
  useEffect(() => {
    if (!enginesReady) return;
    if (isUserTurn || gameOver) return;
    if (!atTip) return;
    const token = ++opponentTokenRef.current;
    setThinking(true);
    // Sample a human-feeling think-time for *this* reply. Drawn once
    // per move so a sequence of replies doesn't feel metronomic. We
    // start the search immediately at full Stockfish speed (so the
    // eval bar / classification consumers see the right numbers) and
    // floor the visible move commit at this delay — the user sees
    // Stockfish "think", not snap-react. See humanTiming.ts for the
    // bands per strength.
    const thinkBudget = sampleDelay(FREE_PLAY_THINK_MS[strength]);
    const thinkStartedAt = Date.now();
    void (async () => {
      try {
        const uci = await pickEngineMove(currentFen, strength);
        if (token !== opponentTokenRef.current) return;
        if (!uci) {
          // Shouldn't happen unless Stockfish reports `(none)` on a
          // terminal position — `detectGameOver` should have caught
          // this on the previous commit, but guard anyway.
          setThinking(false);
          return;
        }
        const chess = new Chess();
        chess.load(currentFen);
        const move = chess.move({
          from: uci.slice(0, 2),
          to: uci.slice(2, 4),
          promotion: uci.slice(4, 5) || undefined,
        });
        if (!move) {
          setThinking(false);
          return;
        }
        // Floor the visible commit at the sampled human-think budget.
        // If Stockfish was slow (cold-boot, deep search, weak machine)
        // this is a no-op; if it was fast we wait so the user sees the
        // engine "think". Re-check the cancellation token after the
        // wait — the user may have hit "Restart" during the pause.
        await waitUntilElapsed(thinkStartedAt, thinkBudget);
        if (token !== opponentTokenRef.current) return;
        const fenAfter = chess.fen();
        const reason = detectGameOver(chess);
        // Append at the tip. Cursor follows the new tip so the user
        // sees the engine's reply land on the board immediately.
        // Classification is implicitly cleared because the new tip
        // entry is engine-side (no badge), and the cursor moves past
        // any prior user-move badge.
        setHistory((h) => [
          ...h,
          {
            uci,
            san: move.san,
            fenAfter,
            side: 'engine',
          },
        ]);
        setCursor((c) => c + 1);
        setThinking(false);
        if (reason) setGameOver(reason);
      } catch (err) {
        if (token !== opponentTokenRef.current) return;
        // If the worker errors out, surface a resign-state so the user
        // isn't stuck staring at a thinking spinner forever.
        console.error('[freePlay] opponent search failed', err);
        setThinking(false);
      }
    })();
  }, [enginesReady, isUserTurn, gameOver, currentFen, strength, atTip]);

  const handleUserMove = useCallback(
    (m: { from: string; to: string; promotion?: string }): boolean | void => {
      // Allow user input whenever it's their turn from the position
      // they're CURRENTLY VIEWING — even if that's a scrubbed-back
      // historical position and not the tip. Playing a different move
      // from a rewound position is the explicit "branch off" case the
      // user asked for; we discard the now-invalidated future
      // continuation and the new move becomes the tip.
      if (gameOver) return false;
      if (stm !== userColor) return false;
      const chess = new Chess();
      chess.load(currentFen);
      const move = chess.move({
        from: m.from,
        to: m.to,
        promotion: m.promotion ?? 'q',
      });
      if (!move) return false;
      const fenAfter = chess.fen();
      const uci = m.from + m.to + (m.promotion ?? '');
      const reason = detectGameOver(chess);
      // If the user is mid-history (cursor < length), playing a move
      // here means "diverge from this point". Truncate the future
      // continuation and append the new move at the cursor. Also
      // cancel any in-flight Stockfish reply: a search that resolves
      // *after* a divergence would commit onto the now-stale future,
      // which we've just thrown away.
      if (!atTip) {
        opponentTokenRef.current += 1;
        setThinking(false);
      }
      setHistory((h) => [
        ...h.slice(0, cursor),
        { uci, san: move.san, fenAfter, side: 'user' },
      ]);
      setCursor(cursor + 1);
      if (reason) setGameOver(reason);
      return true;
    },
    [stm, userColor, gameOver, currentFen, atTip, cursor],
  );

  function restart() {
    opponentTokenRef.current += 1;
    setHistory([]);
    setCursor(0);
    setGameOver(null);
    setThinking(false);
  }

  function resign() {
    opponentTokenRef.current += 1;
    setGameOver('resigned');
  }

  // ── Cursor navigation (← / → arrows) ──────────────────────────────
  // The user can scrub through history move-by-move. Each press of
  // ← or → moves the cursor by one FULL MOVE — to the nearest
  // checkpoint where it's the user's turn (or to `startFen` /
  // `history.length` at the boundaries). This keeps the user always
  // landing on a position they're allowed to act from rather than
  // halfway through a 2-ply exchange. Engine moves are the "between"
  // states the cursor skips over; they're still rendered briefly when
  // they're committed at the tip, but the back/forward navigation
  // doesn't pause on them.
  //
  // A cursor position `c` represents "we're viewing the position
  // *after* the first `c` history entries". c=0 → startFen.
  // "User-on-move at c" iff the side-to-move at that position is
  // `userColor` — derived by parsing the FEN. The boundary positions
  // (0 and history.length) are always valid checkpoints regardless of
  // whose turn it is, so the user can always scrub all the way back
  // to startFen and all the way forward to the tip.
  function fenAt(c: number): string {
    return c === 0 ? startFen : history[c - 1].fenAfter;
  }
  function isUserOnMoveAt(c: number): boolean {
    return fenAt(c).split(' ')[1] === (userColor === 'white' ? 'w' : 'b');
  }
  /** Find the previous cursor position the user can land on. Returns
   *  the largest `c < cursor` with `isUserOnMoveAt(c)`, or 0 if no
   *  such position exists (which means startFen is the only previous
   *  checkpoint). Returns null when already at the earliest point. */
  function prevCheckpoint(): number | null {
    if (cursor === 0) return null;
    for (let c = cursor - 1; c > 0; c--) {
      if (isUserOnMoveAt(c)) return c;
    }
    return 0;
  }
  /** Find the next cursor position. Symmetric with `prevCheckpoint`:
   *  returns the smallest `c > cursor` with `isUserOnMoveAt(c)`, or
   *  `history.length` if none, or null when already at the tip. */
  function nextCheckpoint(): number | null {
    if (cursor >= history.length) return null;
    for (let c = cursor + 1; c < history.length; c++) {
      if (isUserOnMoveAt(c)) return c;
    }
    return history.length;
  }

  function goBack() {
    const target = prevCheckpoint();
    if (target == null) return;
    // Cancel any in-flight Stockfish reply: scrubbing back makes the
    // tip's pending search irrelevant. If the user later returns to
    // the tip via → and engine-on-move, the loop will fire again.
    opponentTokenRef.current += 1;
    setThinking(false);
    setCursor(target);
    // Scrubbing past a terminal state (mate / stalemate / etc.) lifts
    // the game-over flag for the cursored-back position. If the user
    // forwards back to the tip, the terminal state will reapply via
    // the next-move detection chain.
    if (gameOver && target < history.length) setGameOver(null);
  }

  function goForward() {
    const target = nextCheckpoint();
    if (target == null) return;
    setCursor(target);
    // Re-detect game-over if we just scrubbed forward to the tip and
    // the tip's last entry was a terminal state. Cheap to re-check.
    if (target === history.length && history.length > 0) {
      const tip = history[history.length - 1];
      const c = new Chess();
      c.load(tip.fenAfter);
      const reason = detectGameOver(c);
      if (reason) setGameOver(reason);
    }
  }

  // Whether ← / → are currently meaningful. Surface them in the UI as
  // ghost buttons so the user discovers the affordance on hover; the
  // arrow-key shortcuts work whenever they're meaningful even without
  // the buttons being clicked.
  const canGoBack = prevCheckpoint() != null;
  const canGoForward = nextCheckpoint() != null;

  // Keyboard: ←/→ scrub the cursor. We attach to `window` rather than
  // a focused element so the user doesn't have to click the board
  // first, but bail out when the focus is in an input / select /
  // textarea (e.g. the strength dropdown) so we don't steal arrow-key
  // navigation from those controls.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const tgt = e.target as HTMLElement | null;
      if (tgt) {
        const tag = tgt.tagName;
        if (
          tag === 'INPUT' ||
          tag === 'TEXTAREA' ||
          tag === 'SELECT' ||
          tgt.isContentEditable
        ) {
          return;
        }
      }
      if (e.key === 'ArrowLeft') {
        if (canGoBack) {
          e.preventDefault();
          goBack();
        }
      } else if (e.key === 'ArrowRight') {
        if (canGoForward) {
          e.preventDefault();
          goForward();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canGoBack, canGoForward, cursor, history.length]);

  // Eval bar plumbing. Same convention as the review page: convert
  // Stockfish's STM-perspective mate to White-perspective via
  // `mateForWhite` so the bar fill stays anchored to the winning
  // colour as the turn flips during the played-out game.
  const barCpWhite = liveEval ? liveEval.cpWhite : null;
  const barMate = mateForWhite(liveEval?.mate, currentFen);

  return (
    <div className="space-y-3">
      <BoardFrame
        evalBar={
          <EvalBar
            cpWhite={barCpWhite}
            mate={barMate}
            orientation={userColor}
          />
        }
        board={
          <Board
            fen={currentFen}
            orientation={userColor}
            lastMoveUci={lastUci}
            lastMoveClassification={lastClassification}
            // Allow input whenever it's the user's colour to move at
            // the position currently shown — including a rewound
            // historical position. Playing from a past position is
            // the explicit "branch off" workflow (the future
            // continuation gets discarded). Lock input only when:
            //   - the game is genuinely over (mate / stalemate /
            //     resign / etc.) AND we're at the tip (a rewound
            //     terminal position lifts `gameOver` so play can
            //     resume), OR
            //   - it's the engine's colour to move at the cursored
            //     position (the user shouldn't be able to play
            //     Stockfish's pieces).
            viewOnly={
              (gameOver !== null && cursor === history.length) ||
              stm !== userColor
            }
            onMove={handleUserMove}
          />
        }
      />

      <FreePlayStatusBar
        userColor={userColor}
        opponentColor={opponentColor}
        thinking={thinking}
        gameOver={gameOver}
        history={history}
        cursor={cursor}
        strength={strength}
        showBanner={showBanner}
        onChangeStrength={setStrength}
        onResign={resign}
        onRestart={restart}
        onBack={goBack}
        onForward={goForward}
        canGoBack={canGoBack}
        canGoForward={canGoForward}
        onExit={onExit}
      />
    </div>
  );
}

function FreePlayStatusBar({
  userColor,
  opponentColor,
  thinking,
  gameOver,
  history,
  cursor,
  strength,
  showBanner,
  onChangeStrength,
  onResign,
  onRestart,
  onBack,
  onForward,
  canGoBack,
  canGoForward,
  onExit,
}: {
  userColor: 'white' | 'black';
  opponentColor: 'white' | 'black';
  thinking: boolean;
  gameOver: GameOverReason | null;
  history: MoveRecord[];
  /** Position along the history timeline (0..history.length). When
   *  this isn't the tip, the status row surfaces a "Reviewing past
   *  position" hint and the engine pauses replying. */
  cursor: number;
  strength: FreePlayStrength;
  showBanner: boolean;
  onChangeStrength: (level: FreePlayStrength) => void;
  onResign: () => void;
  onRestart: () => void;
  /** Step the cursor back one full move (toward `startFen`). Bound to
   *  ←. The button is also surfaced explicitly for users who don't
   *  know the keyboard shortcut. */
  onBack: () => void;
  /** Step the cursor forward one full move (toward the tip). Bound to
   *  → arrow. */
  onForward: () => void;
  canGoBack: boolean;
  canGoForward: boolean;
  onExit: () => void;
}) {
  const { t } = useTranslation();
  const lastUserMove = [...history].reverse().find((m) => m.side === 'user');
  const colorLabel = (c: 'white' | 'black') =>
    c === 'white' ? t('common.white') : t('common.black');

  return (
    <div className="card p-3 space-y-2">
      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <div className="text-xs uppercase tracking-wide text-text-muted">
          {t('practice.freePlay.youAre', { color: colorLabel(userColor) })}
          {' \u00b7 '}
          {t('practice.freePlay.opponent', { color: colorLabel(opponentColor) })}
        </div>
        <div className="text-xs text-text-muted">
          {t('practice.freePlay.movesPlayed', { count: history.length })}
        </div>
      </div>

      {/* Single status row — intro hint reuses this slot so the board
          above never jumps when the banner appears or dismisses.
          Scrub/mate status always wins; the intro can overlay the
          initial "thinking…" window so the transition still reads. */}
      <div className="text-sm min-h-[2.5rem]">
        {cursor < history.length ? (
          // The user is reviewing a past position. Surface a clear
          // "you're not on the tip" hint so they don't think their
          // input has been ignored when the engine doesn't reply —
          // the engine is intentionally paused while reviewing. The
          // text doubles as a hint to the keyboard shortcuts.
          <span className="text-accent">
            {t('practice.freePlay.reviewingPast', {
              ply: cursor,
              total: history.length,
            })}
          </span>
        ) : gameOver ? (
          <span className="text-text">
            {t(`practice.freePlay.gameOver.${gameOver}`)}
          </span>
        ) : showBanner ? (
          <span className="text-accent">{t('practice.freePlay.banner')}</span>
        ) : thinking ? (
          <span className="text-text-muted">{t('practice.freePlay.thinking')}</span>
        ) : lastUserMove?.classification ? (
          <span className="text-text-muted">
            {t('practice.freePlay.lastMove', {
              san: lastUserMove.san,
              label: tClassification(t, lastUserMove.classification),
            })}
          </span>
        ) : (
          <span className="text-text-muted">{t('practice.freePlay.yourMove')}</span>
        )}
      </div>

      <div className="flex items-center gap-2 flex-wrap text-xs">
        <label className="text-text-muted" htmlFor="freeplay-strength">
          {t('practice.freePlay.strengthLabel')}
        </label>
        <select
          id="freeplay-strength"
          className="input text-xs py-1"
          value={strength}
          onChange={(e) => onChangeStrength(e.target.value as FreePlayStrength)}
        >
          {FREE_PLAY_STRENGTHS.map((level) => (
            <option key={level} value={level}>
              {t(`settings.freePlayStrength.level.${level}`)}
            </option>
          ))}
        </select>

        <div className="ml-auto flex flex-wrap gap-2">
          {/* Back/forward arrow buttons for users who don't know
           *  the keyboard shortcuts. They mirror exactly what ←/→ do
           *  and disable rather than hide so the affordance stays
           *  in a stable spot in the layout — easier to learn the
           *  shortcut by clicking once and noticing the keys work
           *  the same way. */}
          <button
            type="button"
            className="btn text-xs"
            onClick={onBack}
            disabled={!canGoBack}
            title={t('practice.freePlay.backShortcut')}
            aria-label={t('practice.freePlay.back')}
          >
            ←
          </button>
          <button
            type="button"
            className="btn text-xs"
            onClick={onForward}
            disabled={!canGoForward}
            title={t('practice.freePlay.forwardShortcut')}
            aria-label={t('practice.freePlay.forward')}
          >
            →
          </button>
          {!gameOver && (
            <button type="button" className="btn text-xs" onClick={onResign}>
              {t('practice.freePlay.resign')}
            </button>
          )}
          <button type="button" className="btn text-xs" onClick={onRestart}>
            {t('practice.freePlay.restart')}
          </button>
          <button type="button" className="btn-primary text-xs" onClick={onExit}>
            {t('practice.freePlay.backToPractice')}
          </button>
        </div>
      </div>
    </div>
  );
}
