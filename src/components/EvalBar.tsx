import { cpToWinrate } from '@/engine/classify';

export interface EvalBarProps {
  /** Centipawn eval from White's perspective. `null` while engine is
   *  still thinking and there's nothing to render yet. */
  cpWhite: number | null;
  /** Optional mate score, expressed from White's perspective:
   *    +N → White mates in N (bar fills fully white).
   *    -N → Black mates in N (bar fills fully black).
   *
   *  The Stockfish wire format gives mate scores from the *side-to-
   *  move's* perspective, which means the same "mate" can flip sign
   *  every ply as the turn changes. Callers must convert from STM to
   *  White before passing this prop, otherwise the bar will swap to
   *  the opposite side after every move played in exploration / free-
   *  play mode. See `mateForWhite()` below. */
  mate?: number;
  /** Board orientation. White-on-bottom by default; flipped boards put
   *  White at the top of the bar. */
  orientation?: 'white' | 'black';
  /** Pixel height to match the adjacent `<Board>` (which is square). */
  className?: string;
}

/**
 * Convert a Stockfish `scoreMate` reading (STM-perspective) into the
 * White-perspective integer the EvalBar expects. The engine reports a
 * positive value when the side-to-move at `fen` mates the opponent and
 * a negative value when the side-to-move is being mated. The EvalBar
 * needs sign-relative-to-White so the bar fill stays anchored to the
 * winning *colour* across plies. We flip the sign when STM is Black.
 *
 * Returns `undefined` when no mate is in play, so callers can spread it
 * directly into `<EvalBar mate={mateForWhite(...)} />` without an extra
 * conditional.
 */
export function mateForWhite(
  mateStm: number | undefined,
  fenWithStm: string,
): number | undefined {
  if (mateStm == null || mateStm === 0) return undefined;
  const stm = fenWithStm.split(' ')[1];
  return stm === 'b' ? -mateStm : mateStm;
}

/**
 * Vertical eval bar shaped to sit next to the `<Board>`. Fill ratio
 * comes from `cpToWinrate` so it matches the same winrate semantics
 * the rest of the app uses for accuracy / classification — a +1.5 cp
 * reading and a +1.5 cp move-eval-after both render the same bar
 * height.
 *
 * Layout: parent wraps board + bar in `<div class="flex gap-2">`. Width
 * is fixed (`EVAL_BAR_WIDTH_PX`); `BoardFrame` imports the same constant
 * so outer sizing stays aligned.
 */
export const EVAL_BAR_WIDTH_PX = 36;

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
      className={`relative shrink-0 rounded-md overflow-hidden border border-border bg-bg-raised ${className ?? ''}`}
      style={{ width: EVAL_BAR_WIDTH_PX }}
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
          className={`absolute inset-x-0 px-0.5 text-center text-[9px] leading-none font-mono tabular-nums tracking-tight whitespace-nowrap ${labelTextColor}`}
          style={{ [labelAtTop ? 'top' : 'bottom']: 2 }}
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
