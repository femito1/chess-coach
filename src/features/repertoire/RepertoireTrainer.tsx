import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { Chess } from 'chess.js';
import { db, type RepertoireCard } from '@/db/schema';
import { Board } from '@/components/Board';
import { BoardFrame } from '@/components/BoardFrame';
import { buildSolutionSteps } from '@/components/SolutionPlayer';
import { SolutionControls } from '@/components/SolutionControls';
import { gradeSrs, newSrsState, summarizeIntervals, type Grade } from '@/srs/sm2';
import { dueCards, uciPathToFen } from './store';
import { identifyOpening } from '@/features/openings/library';

const INITIAL_FEN =
  'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

export function RepertoireTrainer() {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const repertoire = useLiveQuery(() => (id ? db.repertoires.get(id) : undefined), [id]);
  const [queue, setQueue] = useState<RepertoireCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [idx, setIdx] = useState(0);
  const [status, setStatus] = useState<'thinking' | 'wrong' | 'right'>('thinking');
  const [shown, setShown] = useState(false);
  const [lastTry, setLastTry] = useState<string | null>(null);
  const [hintShown, setHintShown] = useState(false);
  const [wrongCount, setWrongCount] = useState(0);
  /** Opening identification for the *current* card. Recomputed in an
   *  effect (rather than during render) because it requires walking the
   *  repertoire tree async to recover the move sequence. Falls back to
   *  null when the position isn't in the openings library yet (e.g. very
   *  deep / off-book lines). */
  const [opening, setOpening] = useState<{
    family: string;
    name: string;
    eco: string;
  } | null>(null);
  /** UCI path from the repertoire root to (but not including) the
   *  current card's FEN. Loaded async alongside `opening` and consumed
   *  by the Show-answer simulation so it can replay the whole line
   *  from move 1 instead of dropping the user into mid-game with no
   *  context. */
  const [leadInUci, setLeadInUci] = useState<string[]>([]);

  useEffect(() => {
    if (!id) return;
    void (async () => {
      setLoading(true);
      const cards = await dueCards(id);
      setQueue(cards);
      setIdx(0);
      setStatus('thinking');
      setShown(false);
      setLastTry(null);
      setHintShown(false);
      setWrongCount(0);
      setLoading(false);
    })();
  }, [id]);

  const current = queue[idx];

  // Identify the opening for the current card by walking back through
  // the repertoire tree to recover the UCI prefix, then matching against
  // the openings library. The same UCI prefix doubles as the lead-in
  // for the "Show answer" simulation so we cache it on state.
  useEffect(() => {
    if (!current) {
      setOpening(null);
      setLeadInUci([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      const path = await uciPathToFen(current.repertoireId, current.fen);
      if (cancelled) return;
      const op = identifyOpening(path);
      setOpening(
        op ? { family: op.family, name: op.name, eco: op.eco } : null,
      );
      setLeadInUci(path);
    })();
    return () => {
      cancelled = true;
    };
  }, [current]);

  async function grade(g: Grade) {
    if (!current) return;
    // If the user needed a hint or got it wrong, the SM-2 grade is silently
    // floored — knowing-with-help isn't the same as knowing-cold. This
    // keeps the spaced-repetition curve honest without lecturing the user.
    let effectiveGrade: Grade = g;
    if (wrongCount > 0 || hintShown) {
      effectiveGrade = g === 'easy' ? 'good' : g === 'good' ? 'hard' : g;
    }
    const newState = gradeSrs(current.srs ?? newSrsState(), effectiveGrade);
    await db.repertoireCards.update(current.id, { srs: newState });
    if (idx + 1 < queue.length) {
      setIdx(idx + 1);
      setStatus('thinking');
      setShown(false);
      setLastTry(null);
      setHintShown(false);
      setWrongCount(0);
    } else {
      setQueue([]);
    }
  }

  function onMove(m: {
    from: string;
    to: string;
    promotion?: string;
  }): boolean {
    if (!current || status !== 'thinking') return false;
    const played = m.from + m.to + (m.promotion ?? '');
    const expectedBase = current.expectedUci.slice(0, 4);
    const playedBase = played.slice(0, 4);
    if (playedBase === expectedBase) {
      setStatus('right');
      return true;
    } else {
      setStatus('wrong');
      setLastTry(played);
      setWrongCount((n) => n + 1);
      // Snap the piece back so "Try again" / "Hint" picks up from the
      // expected starting position rather than the user's wrong move.
      return false;
    }
  }

  function retry() {
    setStatus('thinking');
    setLastTry(null);
  }

  function showHint() {
    setHintShown(true);
    setStatus('thinking');
    setLastTry(null);
  }

  // CRITICAL: these hooks must run on every render so React's hook
  // order is stable. Earlier they lived after the `if (queue.length
  // === 0) return …` and `if (!current) return …` early returns,
  // which meant transitioning out of those states ran more hooks than
  // the previous render — React threw "Rendered more hooks than
  // during the previous render" the moment the cards trainer
  // received its first card. Hoisting them above all early returns
  // fixes the crash; we just guard against `current` being undefined
  // while the queue is still loading.
  const solutionMoves = useMemo(
    () => (current ? [...leadInUci, current.expectedUci] : []),
    [leadInUci, current],
  );
  const solutionSteps = useMemo(
    () => buildSolutionSteps(INITIAL_FEN, solutionMoves),
    [solutionMoves],
  );
  const [playbackIdx, setPlaybackIdx] = useState(0);
  // Reset playback to the start whenever the card changes — otherwise
  // switching cards would leave the cursor pointing at a step from the
  // previous card's solution.
  useEffect(() => {
    setPlaybackIdx(0);
  }, [current]);

  if (!id) return <div>{t('review.missingId')}</div>;
  if (loading) return <div className="text-text-muted">{t('common.loading')}</div>;
  if (!repertoire) return <div className="text-text-muted">{t('repertoire.trainer.notFound')}</div>;

  if (queue.length === 0) {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <Link to="/repertoire" className="btn text-xs">{t('repertoire.trainer.back')}</Link>
          <h1 className="text-lg font-semibold truncate">{repertoire.name} · {t('repertoire.trainer.training')}</h1>
        </div>
        <div className="card p-8 text-center text-text-muted">
          {t('repertoire.trainer.nothingDue')}
        </div>
      </div>
    );
  }

  if (!current) return <div className="text-text-muted">{t('repertoire.trainer.loadingCard')}</div>;

  const orientation = repertoire.color;
  const expectedSan = (() => {
    try {
      const c = new Chess();
      c.load(current.fen);
      const mv = c.move({
        from: current.expectedUci.slice(0, 2),
        to: current.expectedUci.slice(2, 4),
        promotion: current.expectedUci.slice(4, 5) || undefined,
      });
      return mv?.san ?? current.expectedUci;
    } catch {
      return current.expectedUci;
    }
  })();

  const lastTrySan = lastTry
    ? (() => {
        try {
          const c = new Chess();
          c.load(current.fen);
          const mv = c.move({
            from: lastTry.slice(0, 2),
            to: lastTry.slice(2, 4),
            promotion: lastTry.slice(4, 5) || undefined,
          });
          return mv?.san ?? lastTry;
        } catch {
          return lastTry;
        }
      })()
    : null;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Link to="/repertoire" className="btn text-xs">{t('repertoire.trainer.back')}</Link>
        <div className="flex-1 min-w-0">
          <h1 className="text-lg font-semibold truncate">{repertoire.name} · {t('repertoire.trainer.training')}</h1>
          <div className="text-xs text-text-muted flex flex-wrap items-center gap-x-2 gap-y-1">
            <span>{t('repertoire.trainer.cardOf', { n: idx + 1, total: queue.length })}</span>
            {opening && (
              <>
                <span aria-hidden="true">·</span>
                <span className="truncate">
                  <span className="font-mono text-text-muted/70 mr-1">
                    {opening.eco}
                  </span>
                  <span className="text-text">{opening.name}</span>
                </span>
              </>
            )}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_320px] gap-4 items-start">
        <div className="space-y-3">
          {/* When "Show answer" is active we re-use the *same* main
              board for the simulation playback (no second mini-board
              pops up next to it). The board flips to view-only and
              its FEN comes from the precomputed solution steps; the
              playback chrome (prev/next/SAN ribbon) renders below the
              board where the action buttons normally are. */}
          <BoardFrame
            board={
              <Board
                fen={shown ? solutionSteps[playbackIdx]?.fen ?? current.fen : current.fen}
                orientation={orientation}
                lastMoveUci={
                  shown ? solutionSteps[playbackIdx]?.uci || undefined : undefined
                }
                viewOnly={shown || status === 'right'}
                onMove={onMove}
                highlightSquares={
                  shown
                    ? []
                    : hintShown && status === 'thinking'
                      ? [{ square: current.expectedUci.slice(0, 2), color: 'hint' }]
                      : status === 'wrong' && lastTry
                        ? [{ square: lastTry.slice(0, 2), color: 'wrong' }]
                        : []
                }
              />
            }
          />
          {!shown && (
            <div className="text-sm min-h-[1.5rem]">
              {status === 'thinking' && (
                <span className="text-text-muted">
                  {t('repertoire.trainer.toMove', { color: orientation === 'white' ? t('common.white') : t('common.black') })}
                  {hintShown && (
                    <span className="ml-2 text-accent">
                      {t('repertoire.trainer.hint')}
                    </span>
                  )}
                </span>
              )}
              {status === 'wrong' && (
                <span className="text-blunder">
                  {t('repertoire.trainer.wrongLine', { san: lastTrySan })}
                </span>
              )}
              {status === 'right' && (
                <span className="text-good">
                  {t('repertoire.trainer.correct')}<span className="font-mono">{expectedSan}</span>.
                  {(wrongCount > 0 || hintShown) && (
                    <span className="ml-2 text-text-muted text-xs">
                      {wrongCount > 0
                        ? t('repertoire.trainer.withWrong', { count: wrongCount })
                        : t('repertoire.trainer.withHint')}
                    </span>
                  )}
                </span>
              )}
            </div>
          )}
          {/* Action buttons. Visible whenever the card is unsolved, so a
              user who clicks "Try again" still has Hint / Show-answer
              within reach (fixes the "buttons disappear after retry"
              bug). Each button hides itself once it's been used. */}
          {!shown && (status === 'wrong' || status === 'thinking') && (
            <div className="flex flex-wrap gap-2">
              {status === 'wrong' && (
                <button type="button" className="btn-primary text-xs" onClick={retry}>
                  {t('repertoire.trainer.tryAgain')}
                </button>
              )}
              {!hintShown && (
                <button type="button" className="btn text-xs" onClick={showHint}>
                  {t('puzzles.solver.hint_btn')}
                </button>
              )}
              <button
                type="button"
                className="btn text-xs"
                onClick={() => {
                  setShown(true);
                  setPlaybackIdx(solutionSteps.length - 1);
                }}
              >
                {t('repertoire.trainer.showAnswer')}
              </button>
            </div>
          )}
          {shown && (
            <SolutionControls
              steps={solutionSteps}
              idx={playbackIdx}
              onIdxChange={setPlaybackIdx}
              onClose={() => setShown(false)}
            />
          )}
        </div>

        <aside className="space-y-3">
          {(status === 'right' || shown) && (
            <div className="card p-3 space-y-2">
              <div className="text-xs uppercase tracking-wide text-text-muted">
                {t('repertoire.trainer.howWell')}
              </div>
              <div className="grid grid-cols-2 gap-2">
                <button className="btn border-blunder/40 text-blunder hover:bg-blunder/10" onClick={() => grade('again')}>
                  {t('repertoire.trainer.again')}
                </button>
                <button className="btn" onClick={() => grade('hard')}>{t('repertoire.trainer.hard')}</button>
                <button className="btn" onClick={() => grade('good')}>{t('repertoire.trainer.good')}</button>
                <button className="btn border-good/40 text-good hover:bg-good/10" onClick={() => grade('easy')}>
                  {t('repertoire.trainer.easy')}
                </button>
              </div>
              <div className="text-xs text-text-muted">
                {t('repertoire.trainer.currentInterval', { intervals: summarizeIntervals(current.srs.intervalDays), ease: current.srs.ease.toFixed(2) })}
              </div>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
