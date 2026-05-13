import { useEffect, useMemo } from 'react';
import { useParams, Link, useSearchParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { Chess } from 'chess.js';
import { db, type Motif } from '@/db/schema';
import { requeueGame } from '@/db/queries';
import { Board } from '@/components/Board';
import { BoardFrame } from '@/components/BoardFrame';
import { EvalBar, mateForWhite } from '@/components/EvalBar';
import { EvalGraph } from '@/components/EvalGraph';
import { MoveList } from '@/components/MoveList';
import type { Classification, MoveEval } from '@/db/schema';
import { useReviewState } from './useReviewState';
import { useLiveEval, formatCp, getCachedLiveEval } from './LiveEval';
import { AccuracyPanel } from './AccuracyPanel';
import { MoveInsight } from './MoveInsight';
import { classifyMove, CLASSIFICATION_LABEL } from '@/engine/classify';
import { MOTIF_EXPLANATION, MOTIF_LABEL } from '@/engine/motifs';
import { EngineCockpit } from '@/engine/EngineCockpit';

export function ReviewPage() {
  const { id } = useParams<{ id: string }>();
  const game = useLiveQuery(() => (id ? db.games.get(id) : undefined), [id]);
  const analysis = useLiveQuery(() => (id ? db.analyses.get(id) : undefined), [id]);

  const rs = useReviewState(game);
  const [searchParams] = useSearchParams();

  // Deep-link support: /review/:id?ply=N jumps to that ply. Runs only once
  // per game load, and only if the target is within the mainline.
  useEffect(() => {
    const p = Number(searchParams.get('ply'));
    if (!Number.isFinite(p) || p < 1) return;
    if (rs.mainlineFens.length === 0) return;
    rs.goToMainlinePly(Math.min(p, rs.mainlineFens.length - 1));
    // intentionally depends on length only so we don't re-jump when the user navigates
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game?.id, rs.mainlineFens.length]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      if (e.key === 'ArrowRight') rs.step(1);
      else if (e.key === 'ArrowLeft') rs.step(-1);
      else if (e.key === 'Home') rs.goToMainlinePly(0);
      else if (e.key === 'End') rs.goToMainlinePly(rs.mainlineFens.length - 1);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [rs]);

  const liveEval = useLiveEval(rs.isExploring ? rs.currentFen : '', 14);

  // Off-mainline classification + insight data:
  // When the user has played at least one exploration move, classify
  // the most recent one using the cached eval of the position *before*
  // the move (`prevFen`) and the live eval of the position *after*
  // (`rs.currentFen`). Uses the same `classifyMove` heuristic the
  // analyzer applies to mainline moves so the badge matches what the
  // user is used to seeing on real game moves.
  //
  // We also surface the SAN of the played move and the SAN of what the
  // engine actually wanted from the *before* position — without the
  // latter, the user gets a confusing UI where the badge says "best /
  // brilliant" but the engine panel below shows a different move (which
  // is the engine's preferred *response* to their move, not the
  // alternative they should have played).
  const explorationInsight = useMemo<
    | {
        classification: Classification;
        moverColor: 'White' | 'Black';
        playedSan: string;
        engineWantedSan?: string;
        engineWantedWasPlayed: boolean;
        evalAfterCpWhite: number;
        mateAfter?: number;
      }
    | undefined
  >(() => {
    if (!rs.isExploring) return undefined;
    if (rs.explorationMoves.length === 0) return undefined;
    if (!liveEval || liveEval.running) return undefined;

    const last = rs.explorationMoves[rs.explorationMoves.length - 1];
    const prevFen =
      rs.explorationMoves.length >= 2
        ? rs.explorationMoves[rs.explorationMoves.length - 2].fen
        : rs.mainlineFens[rs.mainlinePly];
    if (!prevFen) return undefined;

    // "Before" eval. Two sources, in priority order:
    //   1. Live cache — populated as soon as `useLiveEval` resolves a
    //      position. Covers every pos beyond the first exploration move.
    //   2. Mainline analysis fallback — for the very first off-mainline
    //      move, `prevFen` is `mainlineFens[mainlinePly]`. We don't have
    //      a live eval for it (we only kick the engine off in
    //      exploration), but we DO have the stored mainline `MoveEval`
    //      whose `winrateBefore` is exactly the side-to-move winrate at
    //      that fen, and whose `bestMoveUci` is the engine's #1 there.
    let moverWinrateBefore: number | undefined;
    let bestUciBefore: string | undefined;
    const cached = getCachedLiveEval(prevFen);
    if (cached) {
      moverWinrateBefore = cached.winrateStm;
      bestUciBefore = cached.bestMoveUci;
    } else if (
      rs.explorationMoves.length === 1 &&
      analysis &&
      analysis.moves[rs.mainlinePly]
    ) {
      const branchPoint = analysis.moves[rs.mainlinePly];
      moverWinrateBefore = branchPoint.winrateBefore;
      bestUciBefore = branchPoint.bestMoveUci;
    }
    if (moverWinrateBefore == null) return undefined;

    // Mover's winrate at `currentFen` = `1 - side-to-move-at-currentFen
    // winrate`, because the side-to-move has flipped since the mover
    // played their move.
    const moverWinrateAfter = 1 - liveEval.winrateStm;
    const isBest = bestUciBefore != null && bestUciBefore === last.uci;

    const classification = classifyMove({
      moverWinrateBefore,
      moverWinrateAfter,
      isBest,
      // We don't know the original ply; pass a high number so we don't
      // trip the early-game `book` shortcut for any non-book exploration.
      ply: 99,
      inBookPhase: false,
      fenBefore: prevFen,
      fenAfter: rs.currentFen,
      playedUci: last.uci,
      prevMoveToSquare: undefined,
    });

    const moverColor: 'White' | 'Black' =
      prevFen.split(' ')[1] === 'w' ? 'White' : 'Black';

    let engineWantedSan: string | undefined;
    if (bestUciBefore) {
      try {
        const c = new Chess(prevFen);
        const m = c.move({
          from: bestUciBefore.slice(0, 2),
          to: bestUciBefore.slice(2, 4),
          promotion: bestUciBefore.slice(4, 5) || undefined,
        });
        engineWantedSan = m?.san;
      } catch {
        engineWantedSan = undefined;
      }
    }

    return {
      classification,
      moverColor,
      playedSan: last.san,
      engineWantedSan,
      engineWantedWasPlayed: isBest,
      evalAfterCpWhite: liveEval.cpWhite,
      mateAfter: liveEval.mate,
    };
  }, [
    rs.isExploring,
    rs.explorationMoves,
    rs.mainlineFens,
    rs.mainlinePly,
    rs.currentFen,
    liveEval,
    analysis,
  ]);
  const explorationClassification = explorationInsight?.classification;

  // Deep-link banner state. The weaknesses page links to
  // `/review/:id?ply=N&from=weakness&motifs=fork,pin` so we can render
  // a dedicated "you came from the weaknesses page" banner with the
  // mistake's classification + motif explanations. Pulled into its
  // own memo so the JSX below stays readable.
  const fromWeaknessBanner = useMemo<
    | {
        moverColor: 'White' | 'Black';
        playedSan: string;
        bestSan?: string;
        classification: Classification;
        motifs: Motif[];
      }
    | null
  >(() => {
    if (searchParams.get('from') !== 'weakness') return null;
    if (!analysis) return null;
    const ply = Number(searchParams.get('ply'));
    if (!Number.isFinite(ply) || ply < 1) return null;
    const moveEval = analysis.moves[ply - 1];
    if (!moveEval) return null;
    const motifsParam = searchParams.get('motifs');
    const motifs = motifsParam
      ? (motifsParam.split(',').filter((m) => m in MOTIF_EXPLANATION) as Motif[])
      : moveEval.motifs ?? [];
    return {
      moverColor: ply % 2 === 1 ? 'White' : 'Black',
      playedSan: moveEval.san,
      bestSan: moveEval.bestMoveSan,
      classification: moveEval.classification,
      motifs,
    };
  }, [searchParams, analysis]);

  if (!id) return <div>Missing id.</div>;
  if (game === undefined) return <div className="text-text-muted">Loading…</div>;
  if (!game) return <div className="text-text-muted">Game not found.</div>;

  const currentMoveEval: MoveEval | undefined =
    !rs.isExploring && rs.mainlinePly > 0 ? analysis?.moves[rs.mainlinePly - 1] : undefined;
  const moverColorLabel: 'White' | 'Black' =
    rs.mainlinePly > 0 && rs.mainlinePly % 2 === 1 ? 'White' : 'Black';

  // Eval bar input. Mainline reads the analyzed move-after-eval (White
  // POV); exploration uses the live engine's running result.
  //
  // CRITICAL: Stockfish reports mate from the *side-to-move's*
  // perspective, but the EvalBar expects mate from White's perspective
  // so the bar stays anchored to the winning colour as the turn flips.
  // Without `mateForWhite(...)`, the bar would swap to the opposite
  // side after every reply: e.g. after user (white) plays a move that
  // forces mate-in-1, it's black to move, the engine reports
  // `scoreMate = -1` (STM = black is being mated), and a naive
  // `mate > 0 ? white : black` bar would fill BLACK as if black were
  // winning. Convert to white-POV at the call site.
  const barCpWhite = rs.isExploring
    ? (liveEval?.cpWhite ?? null)
    : currentMoveEval
      ? currentMoveEval.evalCpAfter
      : null;
  const barMate = rs.isExploring
    ? mateForWhite(liveEval?.mate, rs.currentFen)
    : currentMoveEval
      ? mateForWhite(currentMoveEval.mateInAfter, currentMoveEval.fenAfter)
      : undefined;

  // Use the dedicated `engineBest` brush so the engine's recommendation
  // arrow keeps its classic green look even though the chessground
  // `green` brush has been remapped to chess.com red for user-drawn
  // shapes.
  const arrows =
    !rs.isExploring && currentMoveEval?.bestMoveUci && currentMoveEval.classification !== 'best'
      ? [{ from: currentMoveEval.bestMoveUci.slice(0, 2), to: currentMoveEval.bestMoveUci.slice(2, 4), brush: 'engineBest' as const }]
      : rs.isExploring && liveEval?.bestMoveUci
        ? [{ from: liveEval.bestMoveUci.slice(0, 2), to: liveEval.bestMoveUci.slice(2, 4), brush: 'blue' as const }]
        : [];

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Link to="/games" className="btn text-xs">← Back</Link>
        <div className="flex-1 min-w-0">
          <h1 className="text-lg font-semibold truncate">
            {game.username} <span className="text-text-muted">vs</span> {game.opponent}
          </h1>
          <div className="text-xs text-text-muted truncate">
            {game.opening ?? 'Unknown opening'} · {new Date(game.endTime).toLocaleString()} · {game.timeClass}
          </div>
        </div>
        <a href={game.url} target="_blank" rel="noreferrer" className="btn text-xs">Chess.com ↗</a>
      </div>

      {fromWeaknessBanner && (
        <FromWeaknessBanner banner={fromWeaknessBanner} />
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_360px] gap-4 items-start">
        <div className="space-y-3">
          <BoardFrame
            evalBar={
              <EvalBar
                cpWhite={barCpWhite}
                mate={barMate}
                orientation={game.userColor}
              />
            }
            board={
              <Board
                fen={rs.currentFen}
                orientation={game.userColor}
                lastMoveUci={rs.lastUci}
                lastMoveClassification={
                  rs.isExploring
                    ? explorationClassification
                    : currentMoveEval?.classification
                }
                arrows={arrows}
                viewOnly={false}
                onMove={(m) => rs.tryPlay(m)}
              />
            }
          />

          <div className="flex items-center justify-between gap-2 text-sm">
            <div className="flex gap-1">
              <button className="btn" onClick={() => rs.goToMainlinePly(0)}>⏮</button>
              <button className="btn" onClick={() => rs.step(-1)}>◀</button>
              <button className="btn" onClick={() => rs.step(1)}>▶</button>
              <button className="btn" onClick={() => rs.goToMainlinePly(rs.mainlineFens.length - 1)}>⏭</button>
              {rs.isExploring && (
                <button type="button" className="btn-primary ml-2" onClick={() => rs.resetExploration()}>
                  Return to game
                </button>
              )}
            </div>
            <div className="text-text-muted text-xs">
              {rs.isExploring
                ? `Exploring (+${rs.explorationMoves.length} move${rs.explorationMoves.length === 1 ? '' : 's'})`
                : `Ply ${rs.mainlinePly}/${rs.mainlineFens.length - 1}`}
              {' · ← / → keys'}
            </div>
          </div>

          {rs.isExploring ? (
            <>
              {explorationInsight && (
                <ExplorationMoveInsight insight={explorationInsight} />
              )}
              <div className="card p-3 text-sm border-accent/40 bg-accent/5">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-xs uppercase tracking-wide text-accent">
                    Engine (depth {liveEval?.depth ?? '…'})
                  </div>
                  <div className="font-mono text-sm">
                    {liveEval ? formatCp(liveEval.cpWhite, liveEval.mate) : 'thinking…'}
                  </div>
                </div>
                <div className="text-xs text-text-muted mt-1">
                  {liveEval?.bestMoveSan ? (
                    <>
                      Best response from this position:{' '}
                      <span className="font-mono text-good">{liveEval.bestMoveSan}</span>
                    </>
                  ) : (
                    'Calculating best response…'
                  )}
                </div>
                <div className="text-xs text-text-muted mt-1">
                  You moved pieces off the original game. Press ← or "Return to game" to go back.
                </div>
              </div>
            </>
          ) : analysis ? (
            <EvalGraph moves={analysis.moves} currentPly={rs.mainlinePly} onJump={rs.goToMainlinePly} />
          ) : game.analysisStatus === 'error' ? (
            <div className="card p-4 text-sm border-blunder/40 bg-blunder/5">
              <div className="font-medium text-blunder mb-1">Analysis failed</div>
              <div className="text-xs text-text-muted font-mono break-words">
                {game.analysisError ?? 'unknown error'}
              </div>
              <button type="button" className="btn mt-3 text-xs" onClick={() => void requeueGame(game.id)}>
                Retry analysis
              </button>
            </div>
          ) : (
            // No analysis row yet. Surface the live Stockfish cockpit
            // instead of an opaque "Analyzing this game now…" placeholder.
            // The cockpit subscribes to the engine pool and renders
            // depth iterations, NPS, the current PV, and a mini-board
            // showing the position being searched. We pass `gameId` so
            // the cockpit's progress bar only counts plies for *this*
            // game, not whatever the queue happens to be running.
            // `showBoard={false}` because the review page already
            // renders the actual game board at the top of the column —
            // a second mini-board would be visually noisy.
            <div className="card p-4">
              <EngineCockpit
                title={
                  game.analysisStatus === 'running'
                    ? 'Stockfish is analyzing this game'
                    : 'Queued for analysis'
                }
                subtitle={
                  game.analysisStatus === 'running'
                    ? 'Live readout from the engine. The eval graph will appear here as soon as analysis lands.'
                    : 'The analyzer picks up newest games first — this should start within a moment.'
                }
                showBoard={false}
                gameId={game.id}
                pgn={game.pgn}
              />
            </div>
          )}

          {!rs.isExploring && currentMoveEval && (
            <MoveInsight move={currentMoveEval} moverColor={moverColorLabel} />
          )}
        </div>

        <aside className="space-y-3">
          <AccuracyPanel game={game} />
          <MoveList
            moves={analysis?.moves ?? []}
            currentPly={rs.isExploring ? -1 : rs.mainlinePly}
            onSelect={rs.goToMainlinePly}
            explorationFromPly={rs.isExploring ? rs.mainlinePly : null}
          />
        </aside>
      </div>
    </div>
  );
}

/**
 * Mirrors `MoveInsight` for off-mainline moves. We can't reuse the
 * mainline component directly because it's typed against `MoveEval`
 * (which is the analyzer's stored shape, not the live-eval shape).
 *
 * Crucially, this component shows BOTH the user's played move + its
 * classification AND what the engine actually wanted from the position
 * before the move. Without that second line, a user who sees the `!!`
 * (Brilliant) badge on a move and then sees a *different* move labelled
 * "Best:" in the panel below assumes the badge is wrong — when in fact
 * the panel was showing the engine's preferred *response* to their move
 * (the live eval is for the *new* position with side-to-move flipped).
 */
function ExplorationMoveInsight({
  insight,
}: {
  insight: {
    classification: Classification;
    moverColor: 'White' | 'Black';
    playedSan: string;
    engineWantedSan?: string;
    engineWantedWasPlayed: boolean;
    evalAfterCpWhite: number;
    mateAfter?: number;
  };
}) {
  const label = CLASSIFICATION_LABEL[insight.classification];
  const tone =
    insight.classification === 'blunder'
      ? 'border-blunder/60 bg-blunder/10'
      : insight.classification === 'mistake'
        ? 'border-mistake/60 bg-mistake/10'
        : insight.classification === 'miss'
          ? 'border-miss/60 bg-miss/10'
          : insight.classification === 'inaccuracy'
            ? 'border-inaccuracy/60 bg-inaccuracy/10'
            : insight.classification === 'brilliant'
              ? 'border-brilliant/60 bg-brilliant/10'
              : insight.classification === 'best' || insight.classification === 'excellent'
                ? 'border-good/60 bg-good/10'
                : 'border-border bg-bg-soft';

  const evalAfter = formatCp(insight.evalAfterCpWhite, insight.mateAfter);

  return (
    <div className={`card p-3 border ${tone}`}>
      <div className="text-xs uppercase tracking-wide text-text-muted">{label}</div>
      <div className="text-sm">
        {insight.moverColor} played{' '}
        <span className="font-mono font-semibold">{insight.playedSan}</span>.
        {insight.engineWantedSan && (
          insight.engineWantedWasPlayed ? (
            <>
              {' '}The engine had it as the top move.
            </>
          ) : (
            <>
              {' '}Engine preferred{' '}
              <span className="font-mono text-good font-semibold">
                {insight.engineWantedSan}
              </span>
              .
            </>
          )
        )}
      </div>
      <div className="text-xs text-text-muted mt-1">Eval after: {evalAfter}</div>
    </div>
  );
}

/**
 * Header banner that appears when the user reaches the review page via
 * a "Review in full" deep-link from the weaknesses page. Re-uses the
 * mistake's classification + motif metadata to explain *why* this
 * position is being shown — so the user isn't dropped into a board
 * full of pieces with no context (the original feedback that motivated
 * the inline mini-board on the weaknesses page).
 *
 * Mirrors the visual rhythm of the pre-existing analysis-error / no-
 * analysis cards (small "card" with coloured left border based on the
 * mistake's classification), so the banner looks like a natural part
 * of the review page rather than a transient toast.
 */
function FromWeaknessBanner({
  banner,
}: {
  banner: {
    moverColor: 'White' | 'Black';
    playedSan: string;
    bestSan?: string;
    classification: Classification;
    motifs: Motif[];
  };
}) {
  const tone =
    banner.classification === 'blunder'
      ? 'border-blunder/60 bg-blunder/10'
      : banner.classification === 'mistake'
        ? 'border-mistake/60 bg-mistake/10'
        : banner.classification === 'miss'
          ? 'border-miss/60 bg-miss/10'
          : 'border-inaccuracy/60 bg-inaccuracy/10';
  const label = CLASSIFICATION_LABEL[banner.classification];
  return (
    <div className={`card p-3 border ${tone}`}>
      <div className="flex items-baseline justify-between flex-wrap gap-2">
        <div className="text-xs uppercase tracking-wide">
          From weaknesses · {label}
        </div>
        <Link to="/weaknesses" className="text-xs text-accent hover:underline">
          ← Back to weaknesses
        </Link>
      </div>
      <p className="text-sm mt-1">
        {banner.moverColor} played{' '}
        <span className="font-mono font-semibold text-blunder">
          {banner.playedSan}
        </span>
        {banner.bestSan && (
          <>
            {' '}— the engine preferred{' '}
            <span className="font-mono font-semibold text-good">
              {banner.bestSan}
            </span>
          </>
        )}
        . The board is positioned right on this move; step backward (←)
        to see the position before it, or use the arrow on the board to
        compare.
      </p>
      {banner.motifs.length > 0 && (
        <ul className="mt-2 space-y-1 text-xs">
          {banner.motifs.map((m) => (
            <li key={m} className="text-text-muted">
              <span className="font-medium text-text">
                {MOTIF_LABEL[m]}:
              </span>{' '}
              {MOTIF_EXPLANATION[m]}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
