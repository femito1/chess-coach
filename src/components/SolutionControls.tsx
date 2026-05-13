import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { SolutionStep } from './SolutionPlayer';

/**
 * Headless playback controls for a `<SolutionStep[]>` sequence.
 * Renders the SAN ribbon + prev / next / first / last buttons plus a
 * close affordance, but draws *nothing* on a board — the parent is
 * expected to render its own `<Board fen={steps[idx].fen} viewOnly />`
 * so the simulation re-uses the trainer's main board instead of
 * popping a second mini-board next to it.
 *
 * Why this is split out from `SolutionPlayer`: the original component
 * embedded its own board to be a drop-in for the right-hand aside.
 * Users wanted the playback to take over the trainer's primary board
 * so the position scales properly, the eval bar stays attached, and
 * there's no jarring "small extra board pops up" UX. By keeping the
 * step builder + the controls as separate primitives, both call sites
 * share the same prev / next / SAN-ribbon logic without duplicating
 * keyboard handling.
 *
 * The keyboard handler still lives here (←/→/Home/End scrub) and is
 * unhooked when `enabled === false` so the trainer's own arrow-key
 * shortcuts (e.g. "next card") aren't trampled when playback is off.
 */
export interface SolutionControlsProps {
  steps: SolutionStep[];
  idx: number;
  onIdxChange: (next: number) => void;
  onClose?: () => void;
  /** Compact (no-title) variant for use directly under a board. */
  title?: string;
  /** Disable the keyboard listener. Defaults to true. */
  enabled?: boolean;
}

export function SolutionControls({
  steps,
  idx,
  onIdxChange,
  onClose,
  title,
  enabled = true,
}: SolutionControlsProps) {
  const { t } = useTranslation();
  const resolvedTitle = title ?? t('solutionControls.title');
  useEffect(() => {
    if (!enabled) return;
    function onKey(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement) return;
      if (e.target instanceof HTMLTextAreaElement) return;
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        onIdxChange(Math.max(0, idx - 1));
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        onIdxChange(Math.min(steps.length - 1, idx + 1));
      } else if (e.key === 'Home') {
        e.preventDefault();
        onIdxChange(0);
      } else if (e.key === 'End') {
        e.preventDefault();
        onIdxChange(steps.length - 1);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled, idx, steps.length, onIdxChange]);

  if (steps.length <= 1) {
    return (
      <div className="card p-3 text-xs text-text-muted">
        {t('solutionControls.noMoves')}
      </div>
    );
  }

  const atStart = idx === 0;
  const atEnd = idx === steps.length - 1;

  return (
    <div className="card p-3 space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <div className="text-xs uppercase tracking-wide text-text-muted">
          {resolvedTitle}
        </div>
        <div className="text-[11px] text-text-muted font-mono">
          {idx} / {steps.length - 1}
        </div>
      </div>
      <SanRibbon steps={steps} idx={idx} onJump={onIdxChange} />
      <div className="flex flex-wrap items-center gap-2 justify-between">
        <div className="flex gap-1">
          <button
            type="button"
            className="btn text-xs"
            onClick={() => onIdxChange(0)}
            disabled={atStart}
            title={t('solutionControls.firstMove')}
          >
            ⏮
          </button>
          <button
            type="button"
            className="btn text-xs"
            onClick={() => onIdxChange(Math.max(0, idx - 1))}
            disabled={atStart}
            title={t('solutionControls.prevTitle')}
          >
            {t('solutionControls.prev')}
          </button>
          <button
            type="button"
            className="btn text-xs"
            onClick={() => onIdxChange(Math.min(steps.length - 1, idx + 1))}
            disabled={atEnd}
            title={t('solutionControls.nextTitle')}
          >
            {t('solutionControls.next')}
          </button>
          <button
            type="button"
            className="btn text-xs"
            onClick={() => onIdxChange(steps.length - 1)}
            disabled={atEnd}
            title={t('solutionControls.lastMove')}
          >
            ⏭
          </button>
        </div>
        {onClose && (
          <button type="button" className="btn text-xs" onClick={onClose}>
            {t('solutionControls.close')}
          </button>
        )}
      </div>
    </div>
  );
}

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
