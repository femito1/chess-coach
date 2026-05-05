import { useEffect, useRef } from 'react';
import type { MoveEval, Classification } from '@/db/schema';
import { CLASSIFICATION_SYMBOL } from '@/engine/classify';

export interface MoveListProps {
  moves: MoveEval[];
  currentPly: number;
  onSelect: (ply: number) => void;
  /** If set, indicates the move list is showing an off-mainline exploration. */
  explorationFromPly?: number | null;
}

const classToneClass: Record<Classification, string> = {
  brilliant: 'text-brilliant',
  best: 'text-good',
  excellent: 'text-good/80',
  good: 'text-text',
  book: 'text-text-muted',
  inaccuracy: 'text-inaccuracy',
  miss: 'text-miss',
  mistake: 'text-mistake',
  blunder: 'text-blunder',
};

export function MoveList({ moves, currentPly, onSelect, explorationFromPly }: MoveListProps) {
  const activeRef = useRef<HTMLButtonElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const btn = activeRef.current;
    const container = containerRef.current;
    if (!btn || !container) return;
    // Scroll only inside the move-list container; never touch the page.
    const btnRect = btn.getBoundingClientRect();
    const cRect = container.getBoundingClientRect();
    if (btnRect.top < cRect.top) {
      container.scrollTop += btnRect.top - cRect.top;
    } else if (btnRect.bottom > cRect.bottom) {
      container.scrollTop += btnRect.bottom - cRect.bottom;
    }
  }, [currentPly]);

  const rows: { moveNumber: number; white?: MoveEval; black?: MoveEval }[] = [];
  for (const m of moves) {
    const moveNumber = Math.ceil(m.ply / 2);
    const isWhite = m.ply % 2 === 1;
    const lastRow = rows[rows.length - 1];
    if (isWhite || !lastRow || lastRow.moveNumber !== moveNumber) {
      rows.push({ moveNumber, [isWhite ? 'white' : 'black']: m });
    } else {
      lastRow.black = m;
    }
  }

  return (
    <div
      ref={containerRef}
      className="card font-mono text-sm divide-y divide-border/40 max-h-[70vh] overflow-y-auto overscroll-contain"
    >
      {rows.length === 0 && (
        <div className="text-text-muted text-center py-6">No moves analyzed yet.</div>
      )}
      {rows.map((row) => {
        const ply = (row.white ?? row.black)?.ply ?? 0;
        const isDimmed =
          explorationFromPly != null && ply > explorationFromPly;
        return (
          <div
            key={row.moveNumber}
            className={`flex items-center gap-1 px-2 py-0.5 ${isDimmed ? 'opacity-40' : ''}`}
          >
            <span className="w-7 text-right text-text-muted text-xs">{row.moveNumber}.</span>
            <MoveCell move={row.white} currentPly={currentPly} onSelect={onSelect} activeRef={activeRef} />
            <MoveCell move={row.black} currentPly={currentPly} onSelect={onSelect} activeRef={activeRef} />
          </div>
        );
      })}
    </div>
  );
}

function MoveCell({
  move,
  currentPly,
  onSelect,
  activeRef,
}: {
  move: MoveEval | undefined;
  currentPly: number;
  onSelect: (ply: number) => void;
  activeRef: React.MutableRefObject<HTMLButtonElement | null>;
}) {
  if (!move) return <span className="flex-1" />;
  const isCurrent = move.ply === currentPly;
  const tone = classToneClass[move.classification];
  const sym = CLASSIFICATION_SYMBOL[move.classification];
  return (
    <button
      ref={isCurrent ? activeRef : undefined}
      type="button"
      onClick={() => onSelect(move.ply)}
      className={`flex-1 text-left px-1.5 py-0.5 rounded ${tone} ${
        isCurrent ? 'bg-accent/20' : 'hover:bg-bg-raised'
      }`}
      title={`${move.classification} · eval ${formatCp(move.evalCpAfter)}`}
    >
      {move.san}
      {sym && <span className="ml-0.5 text-xs opacity-80">{sym}</span>}
    </button>
  );
}

function formatCp(cp: number): string {
  const v = cp / 100;
  return `${v > 0 ? '+' : ''}${v.toFixed(2)}`;
}
