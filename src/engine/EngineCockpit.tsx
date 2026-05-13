import { useEffect, useMemo, useRef, useState } from 'react';
import { Chess } from 'chess.js';
import { useTranslation } from 'react-i18next';
import {
  useEngineCockpitStore,
  attachCockpit,
  freshestActiveSlot,
  snapshotCacheStats,
  diffCacheStats,
  type CacheStatsSnapshot,
} from './cockpit';
import { formatPvLine } from './pv';
import { Board } from '@/components/Board';
import { BoardFrame } from '@/components/BoardFrame';
import { EvalBar, mateForWhite } from '@/components/EvalBar';
import { useQueueStore } from './queue';

/* =======================================================================
 *  EngineCockpit — "Stockfish brain" landing experience
 * =======================================================================
 *
 *  Shown on the import-and-review page (full-page) and on the review
 *  page itself (inline) while a game is being analyzed. Three things
 *  matter for the UX:
 *
 *    1. The user must NEVER see a generic "loading…" spinner. The
 *       cockpit always renders something concrete: either the live
 *       engine search visualization, or — when every position is
 *       served from cache — the in-game position the queue is
 *       currently processing.
 *
 *    2. Cache-hit-heavy analyses must feel fast, not broken. We snapshot
 *       `cacheStats` at mount and surface the delta ("38 of 41 found in
 *       cache, 3 sent to Stockfish") so a 2-second cached analysis
 *       reads as "wow, it remembered" rather than "did anything happen?"
 *
 *    3. Live engine output stays the centerpiece when it actually fires.
 *       PV in SAN, eval in cp/mate, depth/seldepth/nodes/NPS, all
 *       throttled in `cockpit.ts` so React never re-renders > ~10 Hz.
 *
 *  See PROJECT_STATUS.md → "Engine cockpit" for the full design rationale.
 *  Tests: src/engine/cockpit.test.ts, src/engine/pv.test.ts,
 *  scripts/test/integration/engine-cockpit.mjs. */

export interface EngineCockpitProps {
  /** Headline above the cockpit. Defaults to a friendly active phrase. */
  title?: string;
  /** Optional subtitle (e.g. "Importing your latest blitz game…"). */
  subtitle?: string;
  /** When false, the mini-board is hidden — used by the review page where
   *  the user is already looking at a much bigger board on the same screen. */
  showBoard?: boolean;
  /** Game id whose progress should drive the progress bar. When set, the
   *  progress bar reads from `useQueueStore` only when this id matches the
   *  queue's currently-active game. */
  gameId?: string;
  /** Optional PGN; when present, the mini-board falls back to rendering
   *  the position at the queue's `currentPly` so the user always sees
   *  *some* board even before the engine fires its first info event
   *  (which never happens for fully-cached games). */
  pgn?: string;
}

export function EngineCockpit({
  title,
  subtitle,
  showBoard = true,
  gameId,
  pgn,
}: EngineCockpitProps) {
  const { t } = useTranslation();
  const resolvedTitle = title ?? t('engineCockpit.defaultTitle');
  // Subscribe to the live cockpit store. attachCockpit() is ref-counted so
  // multiple cockpit instances share a single pool subscription.
  const slots = useEngineCockpitStore((s) => s.slots);
  useEffect(() => attachCockpit(), []);

  // Snapshot cache counters once on mount; we render deltas, not totals,
  // so the user sees stats for *this* analysis, not the whole session.
  const baselineRef = useRef<CacheStatsSnapshot>(snapshotCacheStats());
  // Force a re-render every 250 ms so cache-stats deltas update even
  // when the engine hasn't fired any info events (the cache writes don't
  // go through any observable; a cheap timer is good enough for this
  // ephemeral, short-lived UI). Tick is dependency of the cache delta
  // below so the memoized value actually changes between ticks.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => setTick((n) => n + 1), 250);
    return () => window.clearInterval(t);
  }, []);
  const delta = useMemo(
    () => diffCacheStats(baselineRef.current, snapshotCacheStats()),
    // Recompute on every store update OR every 250 ms tick — covers
    // both "engine fired info" and "cache-only progress" paths.
    [slots, tick],
  );

  // Find the freshest active engine slot (most recently updated worker
  // currently in a search). May be null if every analysis call so far
  // resolved from the cache without dispatching to a worker.
  const slot = useMemo(() => freshestActiveSlot(slots), [slots]);

  // Format the PV in SAN once per slot update — chess.js parsing is
  // cheap but not free, and the cockpit re-renders frequently.
  const pvLine = useMemo(() => {
    if (!slot || !slot.fen || slot.pvUci.length === 0) return '';
    return formatPvLine(slot.fen, slot.pvUci);
  }, [slot]);

  // Pull queue progress only when this cockpit is wired to the active game.
  const queueGameId = useQueueStore((s) => s.currentGameId);
  const queuePly = useQueueStore((s) => s.currentPly);
  const queueTotal = useQueueStore((s) => s.currentTotal);
  const queueRunning = useQueueStore((s) => s.running);
  const isOurGame = gameId !== undefined && queueGameId === gameId;
  const progressPly = isOurGame ? queuePly : 0;
  const progressTotal = isOurGame ? queueTotal : 0;
  const progressPct =
    progressTotal > 0
      ? Math.min(100, Math.round((progressPly / progressTotal) * 100))
      : 0;

  // Fallback board: when no engine slot is active, render the position the
  // queue is *currently* analyzing so the user always sees concrete state.
  // This is the single most important fix for the "looks frozen" complaint:
  // fully-cached games never light up an engine slot, but the queue is
  // tearing through positions and we can show *that* position trivially.
  const fallbackFen = useMemo(() => {
    if (!pgn || !isOurGame || progressPly <= 0) return null;
    try {
      const c = new Chess();
      c.loadPgn(pgn);
      const history = c.history({ verbose: true });
      const replay = new Chess();
      const target = Math.min(progressPly, history.length);
      for (let i = 0; i < target; i++) {
        const h = history[i];
        replay.move({ from: h.from, to: h.to, promotion: h.promotion });
      }
      return replay.fen();
    } catch {
      return null;
    }
  }, [pgn, isOurGame, progressPly]);

  // Pick which FEN to render on the mini-board. Engine slot wins when
  // present; otherwise the queue's current ply; otherwise the standard
  // starting position so the board never disappears.
  const boardFen =
    slot?.fen ?? fallbackFen ?? 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  // Highlight the engine's preferred first move on the mini-board when
  // the engine is actively thinking. We use the UCI string directly —
  // `<Board>` expects `lastMoveUci` (e.g. "e2e4"); no SAN conversion
  // needed for the highlight overlay.
  const boardLastMoveUci = useMemo(() => {
    if (!slot || !slot.fen || slot.pvUci.length === 0) return undefined;
    const firstUci = slot.pvUci[0];
    return firstUci && firstUci.length >= 4 ? firstUci : undefined;
  }, [slot]);

  // `<EvalBar>` takes White-perspective inputs. Stockfish reports cp/mate
  // from the side-to-move's perspective, so we flip when STM is Black.
  const cpWhite = useMemo<number | null>(() => {
    if (!slot || !slot.fen || slot.scoreCp === null) return null;
    const stm = slot.fen.split(' ')[1];
    return stm === 'b' ? -slot.scoreCp : slot.scoreCp;
  }, [slot]);
  const mateWhite = useMemo<number | undefined>(() => {
    if (!slot || !slot.fen || slot.scoreMate === null) return undefined;
    return mateForWhite(slot.scoreMate, slot.fen);
  }, [slot]);

  return (
    <div className="card p-4 space-y-4">
      {/* Headline + progress sit at the top — the user's primary signal
       *  that work is happening. Even with zero engine events these stay
       *  active while the queue grinds through cached positions. */}
      <header className="space-y-1">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-lg font-semibold">{resolvedTitle}</h2>
          {progressTotal > 0 && (
            <span className="text-xs text-text-muted tabular-nums">
              {t('engineCockpit.plies', { done: progressPly, total: progressTotal })}
            </span>
          )}
        </div>
        {subtitle && (
          <p className="text-sm text-text-muted">{subtitle}</p>
        )}
        {/* Always-visible progress strip. When the queue isn't on our game
         *  yet (e.g. import just finished, queue spinning up) we render an
         *  indeterminate-looking shimmer so the UI never feels frozen. */}
        <div className="h-1.5 w-full bg-bg-elevated rounded overflow-hidden mt-2">
          {progressTotal > 0 ? (
            <div
              className="h-full bg-accent transition-[width] duration-200"
              style={{ width: `${progressPct}%` }}
            />
          ) : (
            <div className="h-full w-1/3 bg-accent/40 animate-pulse" />
          )}
        </div>
      </header>

      <div className="flex flex-col md:flex-row gap-4">
        {showBoard && (
          <div className="md:w-72 flex-shrink-0">
            <BoardFrame
              evalBar={<EvalBar cpWhite={cpWhite} mate={mateWhite} />}
              board={
                <Board
                  fen={boardFen}
                  lastMoveUci={boardLastMoveUci}
                  viewOnly={true}
                />
              }
            />
          </div>
        )}
        <div className="flex-1 min-w-0">
          <CockpitReadout
            slot={slot}
            pvLine={pvLine}
            cacheDelta={delta}
            queueRunning={queueRunning && isOurGame}
          />
        </div>
      </div>
    </div>
  );
}

interface CockpitReadoutProps {
  slot: ReturnType<typeof freshestActiveSlot>;
  pvLine: string;
  cacheDelta: CacheStatsSnapshot;
  queueRunning: boolean;
}

function CockpitReadout({ slot, pvLine, cacheDelta, queueRunning }: CockpitReadoutProps) {
  const { t } = useTranslation();
  // Cache-stats line is always visible during analysis, even when the
  // engine isn't actively searching — that's exactly the case where the
  // user most needs reassurance ("nothing happened on screen, but it
  // *was* working").
  const totalConsulted =
    cacheDelta.hits + cacheDelta.misses + cacheDelta.bookSkips;
  const cacheLine =
    totalConsulted > 0 ? (
      <p className="text-xs text-text-muted">
        {cacheDelta.hits > 0 && (
          <>
            <span className="font-semibold text-text-default">
              {cacheDelta.hits}
            </span>{' '}
            {t('engineCockpit.servedFromCache')}
          </>
        )}
        {cacheDelta.hits > 0 && cacheDelta.misses > 0 && ' · '}
        {cacheDelta.misses > 0 && (
          <>
            <span className="font-semibold text-text-default">
              {cacheDelta.misses}
            </span>{' '}
            {t('engineCockpit.sentToStockfish')}
          </>
        )}
        {cacheDelta.bookSkips > 0 && (
          <>
            {' · '}
            <span className="font-semibold text-text-default">
              {cacheDelta.bookSkips}
            </span>{' '}
            {t('engineCockpit.bookSkips')}
          </>
        )}
      </p>
    ) : (
      <p className="text-xs text-text-muted">
        {queueRunning ? t('engineCockpit.crunchingOpening') : t('engineCockpit.warmingEngine')}
      </p>
    );

  if (!slot) {
    return (
      <div className="space-y-3">
        {cacheLine}
        <p className="text-sm text-text-muted">
          {t('engineCockpit.noNeed')}
        </p>
      </div>
    );
  }

  const evalLabel =
    slot.scoreMate !== null
      ? `M${Math.abs(slot.scoreMate)}${slot.scoreMate < 0 ? t('engineCockpit.againstSTM') : ''}`
      : slot.scoreCp !== null
        ? `${(slot.scoreCp / 100).toFixed(2)}`
        : '—';

  return (
    <dl className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-2 text-sm">
      <Stat label={t('engineCockpit.stat.eval')} value={evalLabel} />
      <Stat label={t('engineCockpit.stat.depth')} value={`${slot.depth}/${slot.requestedDepth}`} />
      <Stat label={t('engineCockpit.stat.selDepth')} value={String(slot.seldepth || slot.depth)} />
      <Stat label={t('engineCockpit.stat.speed')} value={formatNps(slot.nps)} />
      <Stat label={t('engineCockpit.stat.nodes')} value={formatNodes(slot.nodes)} />
      <Stat label={t('engineCockpit.stat.time')} value={formatTime(slot.time)} />
      <div className="col-span-2 sm:col-span-2">{cacheLine}</div>
      {pvLine && (
        <div className="col-span-2 sm:col-span-4">
          <dt className="text-xs uppercase tracking-wide text-text-muted">
            {t('engineCockpit.bestLine')}
          </dt>
          <dd className="font-mono text-sm break-words leading-snug mt-0.5">
            {pvLine}
          </dd>
        </div>
      )}
    </dl>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-text-muted">{label}</dt>
      <dd className="font-mono tabular-nums">{value}</dd>
    </div>
  );
}

function formatNps(nps: number): string {
  if (!nps) return '—';
  if (nps >= 1_000_000) return `${(nps / 1_000_000).toFixed(1)}M nps`;
  if (nps >= 1_000) return `${(nps / 1_000).toFixed(0)}k nps`;
  return `${nps} nps`;
}

function formatNodes(nodes: number): string {
  if (!nodes) return '—';
  if (nodes >= 1_000_000) return `${(nodes / 1_000_000).toFixed(1)}M`;
  if (nodes >= 1_000) return `${(nodes / 1_000).toFixed(0)}k`;
  return String(nodes);
}

function formatTime(ms: number): string {
  if (!ms) return '—';
  if (ms >= 10_000) return `${(ms / 1000).toFixed(0)}s`;
  if (ms >= 1_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms}ms`;
}
