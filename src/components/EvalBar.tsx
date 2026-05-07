import { cpToWinrate } from '@/engine/classify';

export interface EvalBarProps {
  /** Centipawn eval from White's perspective. `null` while engine is
   *  still thinking and there's nothing to render yet. */
  cpWhite: number | null;
  /** Optional mate score (positive = White mates in N, negative = Black). */
  mate?: number;
  /** Board orientation. White-on-bottom by default; flipped boards put
   *  White at the top of the bar. */
  orientation?: 'white' | 'black';
  /** Pixel height to match the adjacent `<Board>` (which is square). */
  className?: string;
}

/**
 * Vertical eval bar shaped to sit next to the `<Board>`. Fill ratio
 * comes from `cpToWinrate` so it matches the same winrate semantics
 * the rest of the app uses for accuracy / classification — a +1.5 cp
 * reading and a +1.5 cp move-eval-after both render the same bar
 * height.
 *
 * Layout: parent wraps board + bar in `<div class="flex gap-2">`. Width
 * is fixed (24px) so the board's max-width math is unaffected.
 */
export function EvalBar({
  cpWhite,
  mate,
  orientation = 'white',
  className,
}: EvalBarProps) {
  // White's winrate, [0..1]. When mate is in play we slam to one end.
  let winrateWhite = 0.5;
  if (mate != null && mate !== 0) {
    winrateWhite = mate > 0 ? 1 : 0;
  } else if (cpWhite != null) {
    winrateWhite = cpToWinrate(cpWhite);
  }
  // White at the bottom by default, but flip with orientation so the bar
  // mirrors the board the user is looking at.
  const whiteAtTop = orientation === 'black';
  const whitePct = Math.round(winrateWhite * 1000) / 10;
  const blackPct = 100 - whitePct;
  const label = formatEvalLabel(cpWhite, mate);
  // Anchor the label to the side that's winning, on its colour. Concretely:
  //   - White ahead (winrate > 0.5) → label sits on the white slab.
  //   - Black ahead → label sits on the black slab.
  // Whether that's the top or the bottom of the bar depends on orientation.
  const labelOnWhite = winrateWhite >= 0.5;
  const labelAtTop = whiteAtTop ? labelOnWhite : !labelOnWhite;
  const labelTextColor = labelOnWhite ? 'text-black' : 'text-white';

  return (
    <div
      className={`relative w-6 shrink-0 rounded-md overflow-hidden border border-border bg-bg-raised ${className ?? ''}`}
      title={label ? `Eval: ${label}` : 'Engine thinking…'}
    >
      <div
        className="absolute left-0 right-0 bg-black/85"
        style={{
          [whiteAtTop ? 'bottom' : 'top']: 0,
          height: `${blackPct}%`,
        }}
      />
      <div
        className="absolute left-0 right-0 bg-white"
        style={{
          [whiteAtTop ? 'top' : 'bottom']: 0,
          height: `${whitePct}%`,
        }}
      />
      {label && (
        <div
          className={`absolute left-0 right-0 text-center text-[10px] leading-none py-0.5 font-mono ${labelTextColor}`}
          style={{ [labelAtTop ? 'top' : 'bottom']: 0 }}
        >
          {label}
        </div>
      )}
    </div>
  );
}

export function formatEvalLabel(cpWhite: number | null, mate?: number): string | null {
  if (mate != null && mate !== 0) {
    // Positive mate = White mates; show side-agnostic "M<n>" with sign.
    return mate > 0 ? `M${mate}` : `-M${Math.abs(mate)}`;
  }
  if (cpWhite == null) return null;
  const v = cpWhite / 100;
  if (Math.abs(v) < 0.05) return '0.0';
  return `${v > 0 ? '+' : ''}${v.toFixed(1)}`;
}
