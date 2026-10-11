import { memo } from 'react';
import type * as React from 'react';

// chessground's piece sprites are keyed on a `<piece>` element.
declare module 'react' {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface IntrinsicElements {
      piece: React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement>;
    }
  }
}

/**
 * A static board thumbnail from a FEN.
 *
 * Not a chessground instance: the history grid shows dozens at once, and
 * each `Board` mounts listeners, a resize observer and a DOM tree of 64+
 * squares. This is one div with a CSS checkerboard and one `<piece>` per
 * man, reusing chessground's own piece sprites (the `.cg-wrap piece.*`
 * rules in `chessground.cburnett.css`) so thumbnails match the real board.
 */
const PIECE_NAMES: Record<string, string> = {
  p: 'pawn',
  n: 'knight',
  b: 'bishop',
  r: 'rook',
  q: 'queen',
  k: 'king',
};

export const MiniBoard = memo(function MiniBoard({
  fen,
  orientation,
  className = '',
}: {
  fen: string;
  orientation: 'white' | 'black';
  className?: string;
}) {
  const pieces: { key: string; cls: string; x: number; y: number }[] = [];
  const rows = fen.split(' ')[0].split('/');
  rows.forEach((row, r) => {
    let f = 0;
    for (const ch of row) {
      if (/\d/.test(ch)) {
        f += Number(ch);
        continue;
      }
      const name = PIECE_NAMES[ch.toLowerCase()];
      if (name) {
        const color = ch === ch.toUpperCase() ? 'white' : 'black';
        const x = orientation === 'white' ? f : 7 - f;
        const y = orientation === 'white' ? r : 7 - r;
        pieces.push({ key: `${r}-${f}`, cls: `${color} ${name}`, x, y });
      }
      f++;
    }
  });

  return (
    <div className={`cg-wrap mini-board ${className}`} aria-hidden>
      {pieces.map((p) => (
        <piece
          key={p.key}
          className={p.cls}
          style={{ transform: `translate(${p.x * 100}%, ${p.y * 100}%)` }}
        />
      ))}
    </div>
  );
});
