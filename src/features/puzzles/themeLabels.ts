/**
 * Human-readable labels for Lichess puzzle themes.
 *
 * The corpus ships 72 themes. Rather than author (and translate, three
 * times over) 72 label keys — most of which are proper nouns for mating
 * patterns that don't translate anyway — we de-camel-case them
 * mechanically and hand-correct only the ones the algorithm gets wrong.
 *
 * That keeps a Lichess vocabulary change from silently producing a blank
 * chip: an unmapped new theme still renders as readable text.
 */

/** Themes whose mechanical de-camel-casing reads badly. Everything not
 *  listed here falls through to `deCamel`. */
const OVERRIDES: Record<string, string> = {
  mateIn1: 'Mate in 1',
  mateIn2: 'Mate in 2',
  mateIn3: 'Mate in 3',
  mateIn4: 'Mate in 4',
  mateIn5: 'Mate in 5',
  attackingF2F7: 'Attacking f2/f7',
  xRayAttack: 'X-ray attack',
  enPassant: 'En passant',
  superGM: 'Super GM',
  masterVsMaster: 'Master vs master',
  queenRookEndgame: 'Queen + rook endgame',
  oneMove: 'One-move',
  veryLong: 'Very long',
  // Possessives read wrong when split: "Morphys Mate" → "Morphy's mate".
  morphysMate: "Morphy's mate",
  pillsburysMate: "Pillsbury's mate",
};

/** `backRankMate` → `Back rank mate` */
function deCamel(s: string): string {
  const spaced = s
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function formatThemeName(theme: string): string {
  return OVERRIDES[theme] ?? deCamel(theme);
}
