import type { MoveEval } from '@/db/schema';
import { CLASSIFICATION_LABEL } from '@/engine/classify';
import { MOTIF_LABEL } from '@/engine/motifs';

export function MoveInsight({
  move,
  moverColor,
}: {
  move: MoveEval;
  moverColor: 'White' | 'Black';
}) {
  const label = CLASSIFICATION_LABEL[move.classification];
  const tone =
    move.classification === 'blunder'
      ? 'border-blunder/60 bg-blunder/10'
      : move.classification === 'mistake'
        ? 'border-mistake/60 bg-mistake/10'
        : move.classification === 'miss'
          ? 'border-miss/60 bg-miss/10'
          : move.classification === 'inaccuracy'
            ? 'border-inaccuracy/60 bg-inaccuracy/10'
            : move.classification === 'brilliant'
              ? 'border-brilliant/60 bg-brilliant/10'
              : move.classification === 'best' || move.classification === 'excellent'
                ? 'border-good/60 bg-good/10'
                : 'border-border bg-bg-soft';

  return (
    <div className={`card p-3 border ${tone}`}>
      <div className="text-xs uppercase tracking-wide text-text-muted">{label}</div>
      <div className="text-sm">
        {moverColor} played <span className="font-mono font-semibold">{move.san}</span>.
        {move.bestMoveSan && move.classification !== 'best' && (
          <>
            {' '}Engine preferred <span className="font-mono text-good font-semibold">{move.bestMoveSan}</span>.
          </>
        )}
      </div>
      <div className="text-xs text-text-muted mt-1">
        Eval: {formatEvalAfter(move)} · depth {move.depth}
        {move.phase && <> · {move.phase}</>}
        {move.clockAfter != null && (
          <> · clock {formatClock(move.clockAfter)}</>
        )}
      </div>
      {move.motifs && move.motifs.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {move.motifs.map((m) => (
            <span
              key={m}
              className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-bg-raised text-text-muted"
            >
              {MOTIF_LABEL[m]}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function formatClock(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatEvalAfter(m: MoveEval): string {
  if (m.mateInAfter != null) return `M${m.mateInAfter}`;
  const v = m.evalCpAfter / 100;
  return `${v > 0 ? '+' : ''}${v.toFixed(2)}`;
}
