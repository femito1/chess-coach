import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Chess } from 'chess.js';
import { Board, type BoardMove } from '@/components/Board';
import { BoardFrame } from '@/components/BoardFrame';
import { buildSolutionSteps } from '@/components/SolutionPlayer';
import type { PersonalLineRecord } from '@/features/openings/recommendations';
import type { Tier } from '@/features/openings/difficulty';

/**
 * The "Learn" step — the acquisition half the drill loop was missing.
 *
 * Drilling *tests* you: it asks for the move and marks you wrong when you
 * don't know it. That's spaced repetition for a line you already know, but
 * for a line you've never seen it's just repeated failure. Learn is the
 * step before that test: it walks the line move by move, plays the
 * opponent's replies for you, and asks you to *try* your own moves on the
 * board — revealing the answer the instant you ask, with no score kept.
 * Active recall, not a lecture; and because it fabricates nothing, it
 * needs no per-move prose the dataset doesn't have. Where a move's
 * master-level frequency is known it says how forced or how offbeat the
 * move is, which is the one honest thing we can say about *why* a move.
 *
 * When you're ready, "Drill this line" hands straight off into the normal
 * trainer for exactly this line (importing it first if it wasn't in your
 * repertoire yet).
 */
const START_FEN = new Chess().fen();

export interface LearnPanelProps {
  uci: string[];
  variation: string;
  family: string;
  eco: string;
  tier: Tier;
  plies: number;
  record: PersonalLineRecord | null;
  inRepertoire: boolean;
  /** Family "what is this opening" blurb, or '' when none authored. */
  familyBlurb: string;
  /** Master-level share of each move at its branch, index-aligned to
   *  `uci`; null where we have no trustworthy number for that ply. The
   *  caller is responsible for passing null rather than a value it can't
   *  stand behind — see `TRUSTWORTHY_SHARE_PLIES` in PracticePage. */
  moveShares: Array<number | null>;
  userColor: 'white' | 'black';
  adding: boolean;
  onDrill: () => void;
  onAddToSet: () => void;
  onClose: () => void;
}

/** Whose turn it is in a FEN. Derived from the position rather than from
 *  ply parity, because `buildSolutionSteps` stops at the first illegal
 *  move — so `played` and the board can disagree with parity on
 *  malformed data. `LineRunner` derives the turn the same way. */
function turnAt(fen: string): 'white' | 'black' {
  return fen.split(' ')[1] === 'b' ? 'black' : 'white';
}

export function LearnPanel({
  uci,
  variation,
  family,
  eco,
  tier,
  plies,
  record,
  inRepertoire,
  familyBlurb,
  moveShares,
  userColor,
  adding,
  onDrill,
  onAddToSet,
  onClose,
}: LearnPanelProps) {
  const { t } = useTranslation();
  const steps = useMemo(() => buildSolutionSteps(START_FEN, uci), [uci]);
  // Drive everything off the steps we could actually replay, never off
  // `uci.length`: a malformed line yields fewer steps, and trusting the
  // raw length would ask for a move the board can't be at.
  const totalPlies = steps.length - 1;
  // `played` = number of plies revealed/played so far. Board rests at
  // steps[played]. Upcoming moves stay concealed in the ribbon.
  const [played, setPlayed] = useState(0);
  const [wrongGuess, setWrongGuess] = useState(false);

  const atEnd = played >= totalPlies;
  const current = steps[Math.min(played, totalPlies)];
  const isUserMove = !atEnd && turnAt(current.fen) === userColor;
  // A line containing none of the user's moves (e.g. a 1-ply opening when
  // preparing the other colour) has nothing to recall — say so rather
  // than auto-playing to the end and declaring mastery.
  const hasUserMoves = useMemo(
    () => steps.slice(0, totalPlies).some((s) => turnAt(s.fen) === userColor),
    [steps, totalPlies, userColor],
  );

  const play = useCallback(() => {
    setWrongGuess(false);
    setPlayed((p) => Math.min(totalPlies, p + 1));
  }, [totalPlies]);

  // Auto-play the opponent's moves so the learner only has to recall
  // their own. Runs whenever we land on an opponent-to-move ply.
  useEffect(() => {
    if (atEnd || isUserMove) return;
    const id = setTimeout(() => {
      setWrongGuess(false);
      setPlayed((p) => Math.min(totalPlies, p + 1));
    }, 550);
    return () => clearTimeout(id);
  }, [atEnd, isUserMove, played, totalPlies]);

  const restart = useCallback(() => {
    setPlayed(0);
    setWrongGuess(false);
  }, []);

  // Active recall: accept the user's own move only when it matches the
  // line. A wrong guess is rejected (board snaps back) and never scored —
  // Learn is for acquisition, so mistakes here cost nothing.
  const tryGuess = useCallback(
    (move: BoardMove): boolean => {
      if (atEnd || !isUserMove) return false;
      // Compare against the step we actually replayed, not raw `uci`.
      const expected = steps[played + 1]?.uci ?? '';
      // Squares must match. Promotion is compared leniently: the Board
      // always supplies 'q' (there is no promotion picker), while a
      // library line may record the same move with no promotion char at
      // all — a strict compare would make such a move unplayable forever.
      const ok =
        expected.slice(0, 4) === move.from + move.to &&
        expected.length >= 4;
      if (ok) {
        play();
        return true;
      }
      setWrongGuess(true);
      return false;
    },
    [atEnd, isUserMove, played, steps, play],
  );

  const reveal = useCallback(() => {
    play();
  }, [play]);

  const lastShare = played > 0 ? moveShares[played - 1] ?? null : null;

  return (
    <div className="card p-3 space-y-3" data-testid="learn-panel">
      <div className="flex items-baseline justify-between gap-2">
        <div className="min-w-0">
          <div className="text-xs uppercase tracking-wide text-text-muted">
            {t('practice.learn.title')}
          </div>
          <div className="text-sm font-medium truncate">
            {eco && <span className="font-mono text-text-muted mr-1">{eco}</span>}
            {variation || family}
          </div>
        </div>
        <button type="button" className="btn text-xs shrink-0" onClick={onClose}>
          {t('practice.learn.close')}
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-[11px] text-text-muted">
        <span className="tabular-nums">
          {t('practice.linePicker.plyTag', { count: plies })}
        </span>
        <span>·</span>
        <span>{t(`practice.linePicker.tier.${tier}` as const)}</span>
        {record && (
          <>
            <span>·</span>
            <span title={record.inherited ? t('practice.linePicker.recordInheritedHint') : t('practice.linePicker.recordHint')}>
              {record.inherited ? '≈ ' : ''}
              {t('practice.linePicker.record', {
                wins: record.wins,
                draws: record.draws,
                losses: record.losses,
              })}
            </span>
          </>
        )}
      </div>

      {familyBlurb && (
        <p className="text-xs text-text-muted leading-relaxed">{familyBlurb}</p>
      )}

      <div className="mx-auto w-full">
        <BoardFrame
          board={
            <Board
              fen={current.fen}
              orientation={userColor}
              lastMoveUci={current.uci || undefined}
              viewOnly={atEnd || !isUserMove}
              onMove={!atEnd && isUserMove ? tryGuess : undefined}
            />
          }
        />
      </div>

      {/* Concealing SAN ribbon: shows played moves; the pending move is a
          placeholder so Learn tests recall rather than reading ahead. */}
      <LearnRibbon steps={steps} played={played} pending={!atEnd} />

      {/* Prompt / feedback line. aria-live so the recall loop is usable
          without watching the board. */}
      <div className="text-xs min-h-[1.5rem]" aria-live="polite" role="status">
        {atEnd ? (
          <span className="text-good font-medium">
            {hasUserMoves
              ? t('practice.learn.complete')
              : t('practice.learn.noUserMoves')}
          </span>
        ) : isUserMove ? (
          <span className={wrongGuess ? 'text-blunder' : 'text-text'}>
            {wrongGuess
              ? t('practice.learn.notQuite')
              : t('practice.learn.yourMovePrompt')}
          </span>
        ) : (
          <span className="text-text-muted">{t('practice.learn.opponentReplies')}</span>
        )}
      </div>

      {/* Forcedness / frequency for the move just played — the one honest
          "why this move" we can derive without authored prose. */}
      {lastShare != null && played > 0 && (
        <div className="text-[11px] text-text-muted">
          {(() => {
            // Name the move the number is about — otherwise, sitting under
            // a "your move" prompt, it reads as describing the position
            // the user is being asked about rather than the move that
            // just landed.
            const san = steps[played].san;
            const pct = Math.round(lastShare * 100);
            if (lastShare >= 0.85) return t('practice.learn.shareForced', { san, pct });
            if (lastShare <= 0.1) return t('practice.learn.shareRare', { san, pct });
            return t('practice.learn.shareChoice', { san, pct });
          })()}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {!atEnd && isUserMove && (
          <button
            type="button"
            className="btn text-xs"
            onClick={reveal}
            data-testid="learn-reveal"
          >
            {t('practice.learn.revealMove')}
          </button>
        )}
        {played > 0 && (
          <button type="button" className="btn text-xs" onClick={restart}>
            {t('practice.learn.restart')}
          </button>
        )}
        <div className="flex-1" />
        <button
          type="button"
          className="btn text-xs"
          disabled={adding}
          onClick={onAddToSet}
        >
          {inRepertoire
            ? t('practice.learn.addToSet')
            : adding
              ? t('practice.learn.adding')
              : t('practice.learn.addToRepertoire')}
        </button>
        <button
          type="button"
          className="btn-primary text-xs"
          disabled={adding}
          onClick={onDrill}
          data-testid="learn-drill"
        >
          {t('practice.learn.drillThisLine')}
        </button>
      </div>
    </div>
  );
}

/** SAN ribbon that reveals only what's been played; the next move is a
 *  concealed placeholder so the learner recalls it rather than reads it. */
function LearnRibbon({
  steps,
  played,
  pending,
}: {
  steps: ReturnType<typeof buildSolutionSteps>;
  played: number;
  pending: boolean;
}) {
  return (
    <div className="flex flex-wrap gap-x-2 gap-y-0.5 font-mono text-xs">
      {steps.slice(1, played + 1).map((s, i) => {
        const moveNumber = Math.floor(i / 2) + 1;
        const isWhite = i % 2 === 0;
        return (
          <span key={i} className="text-text">
            {isWhite && <span className="text-text-muted/70 mr-0.5">{moveNumber}.</span>}
            {s.san}
          </span>
        );
      })}
      {pending && (
        <span className="text-text-muted/60">
          {played % 2 === 0 && (
            <span className="mr-0.5">{Math.floor(played / 2) + 1}.</span>
          )}
          ?
        </span>
      )}
    </div>
  );
}
