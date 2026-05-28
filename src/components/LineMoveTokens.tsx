import { useTranslation } from 'react-i18next';
import type { Color } from '@/db/schema';

/**
 * Per-token side derivation for a repertoire / opening line.
 *
 * Conventions of the repertoire `RepertoireLine` shape (see
 * `src/features/repertoire/store.ts:285-295`): `fens[0]` is the
 * starting FEN, `fens[i+1]` is the position AFTER `uci[i]`. So move
 * `i` was played from the position in `fens[i]`, and the side that
 * played it is whatever colour was to move in `fens[i]`.
 *
 * For lines that always start from the standard initial position the
 * side alternates strictly white-black-white-black starting with
 * white, so `i % 2 === 0 → white`. For lines starting from a
 * non-initial FEN we read it from the FEN's side-to-move field.
 *
 * Exported as a pure helper so the unit test can pin the contract
 * without mounting React.
 */
export function isUserMoveAt(
  fenBeforeMove: string | undefined,
  userColor: Color,
  fallbackIndex: number,
): boolean {
  if (fenBeforeMove) {
    const stm = fenBeforeMove.split(' ')[1];
    if (stm === 'w' || stm === 'b') {
      return (stm === 'w' ? 'white' : 'black') === userColor;
    }
  }
  // Fallback: assume the standard initial position so even moves are
  // White's. Used when the line doesn't carry a per-ply FEN array.
  const moverIsWhite = fallbackIndex % 2 === 0;
  return (moverIsWhite ? 'white' : 'black') === userColor;
}

/** Move-number formula matching standard PGN notation. Even indices
 *  (0, 2, 4, ...) are White's moves; the move number for ply `i` is
 *  `floor(i / 2) + 1`. Wrapped so a future "non-standard start" code
 *  path can override the formula in one place. */
export function moveNumberAt(plyIndex: number, isWhiteMove: boolean): {
  number: number;
  isWhiteMove: boolean;
} {
  return { number: Math.floor(plyIndex / 2) + 1, isWhiteMove };
}

/**
 * Numbered + color-coded SAN ribbon for a chess line. Replaces the
 * raw `sans.slice(0, 8).join(' ')` dump that used to live in the
 * practice line picker (the user complained: "feels lazy, hard to
 * tell which moves are yours and which are the opponent's, and when
 * lines are too long you can't see the whole thing").
 *
 * Three things this component fixes:
 *   1. Move numbering (`1. e4 e5  2. Nf3 Nc6 ...`) so the ribbon
 *      reads like a real move list.
 *   2. Color coding via `userColor` — the user's moves render in the
 *      accent colour, the opponent's in muted text — so the user can
 *      tell at a glance whose move is whose.
 *   3. Wrapping (`flex-wrap`) instead of single-line truncation —
 *      long lines now fold onto multiple rows and stay fully visible.
 *
 * Optional `currentPly` highlights one move (1-indexed: `currentPly=3`
 * highlights the third half-move); used by the in-runner ribbon to
 * show "you are here" feedback while drilling.
 *
 * Optional `onPly(ply)` makes each token clickable (matches the
 * openings library's `MoveListPreview` jump-to-ply behaviour). When
 * omitted, tokens render as static `<span>`s.
 */
export function LineMoveTokens({
  sans,
  fens,
  userColor,
  currentPly,
  onPly,
  size = 'sm',
  showLegend = false,
}: {
  /** SAN list, one entry per played ply. */
  sans: readonly string[];
  /** Optional FEN-before-each-move; `fens[i]` is the position from
   *  which `sans[i]` was played. When provided we read side-to-move
   *  from it (correct for lines starting from a non-initial FEN);
   *  when absent we assume the standard initial position. */
  fens?: readonly string[];
  /** Which side is "the user" — used to decide colouring. */
  userColor: Color;
  /** 1-indexed ply to highlight (`currentPly === 3` highlights the
   *  third half-move). Pass 0 / undefined to render no highlight. */
  currentPly?: number;
  /** Optional click handler. Receives the ply (1-indexed) the user
   *  clicked, mirroring the openings library `MoveListPreview` API.
   *  When omitted, tokens are static spans. */
  onPly?: (ply: number) => void;
  /** `'sm'` (12 px) for the picker sidebar; `'md'` (14 px) for the
   *  runner ribbon. */
  size?: 'sm' | 'md';
  /** Optional legend ("you" / "opponent") under the ribbon. Off by
   *  default — only the runner ribbon renders it because the picker
   *  is dense. */
  showLegend?: boolean;
}) {
  const { t } = useTranslation();
  if (sans.length === 0) return null;
  const sizeClass = size === 'md' ? 'text-sm' : 'text-xs';
  const numClass =
    size === 'md' ? 'text-text-muted' : 'text-text-muted/70';
  const userTokenCls = 'text-accent';
  const oppTokenCls = 'text-text';
  const mutedSeparator = 'text-text-muted/50';
  return (
    <div className="space-y-1">
      <div className={`flex flex-wrap gap-x-1.5 gap-y-0.5 font-mono ${sizeClass}`}>
        {sans.map((san, i) => {
          const fen = fens?.[i];
          const isUser = isUserMoveAt(fen, userColor, i);
          const isWhiteMove = fen
            ? fen.split(' ')[1] === 'w'
            : i % 2 === 0;
          const moveNum = Math.floor(i / 2) + 1;
          const ply = i + 1;
          const isHighlighted =
            typeof currentPly === 'number' && currentPly === ply;
          const tokenCls = `${isUser ? userTokenCls : oppTokenCls} ${
            isHighlighted
              ? 'bg-accent/20 px-1 rounded ring-1 ring-accent/60'
              : ''
          }`.trim();
          return (
            <span key={i} className="inline-flex items-baseline gap-0.5">
              {isWhiteMove && (
                <span className={numClass}>{moveNum}.</span>
              )}
              {!isWhiteMove && i === 0 && (
                // Line starts on Black's move (e.g. starting from a
                // mid-game FEN): emit the standard "1..." ellipsis so
                // the ribbon still reads correctly.
                <span className={numClass}>{moveNum}…</span>
              )}
              {onPly ? (
                <button
                  type="button"
                  onClick={() => onPly(ply)}
                  className={`${tokenCls} hover:underline cursor-pointer`}
                  aria-current={isHighlighted ? 'true' : undefined}
                >
                  {san}
                </button>
              ) : (
                <span
                  className={tokenCls}
                  aria-current={isHighlighted ? 'true' : undefined}
                >
                  {san}
                </span>
              )}
              {/* Visual separator between move-pairs for readability. */}
              {!isWhiteMove && i < sans.length - 1 && (
                <span className={mutedSeparator}> </span>
              )}
            </span>
          );
        })}
      </div>
      {showLegend && (
        <div className="flex items-center gap-3 text-[11px] text-text-muted">
          <span className="inline-flex items-center gap-1">
            <span className="inline-block w-2 h-2 rounded-full bg-accent" />
            {t('common.you')}
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="inline-block w-2 h-2 rounded-full bg-text-muted/70" />
            {t('common.opponent')}
          </span>
        </div>
      )}
    </div>
  );
}
