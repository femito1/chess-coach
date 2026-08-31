import type { Motif } from '@/db/schema';

/**
 * Bridge between the motifs *we* detect in the user's own games
 * (`src/engine/motifs.ts`) and the theme vocabulary Lichess tags its
 * puzzles with.
 *
 * This table is what makes the Recommended tab possible: it's the join
 * between "you keep missing forks" (our analysis) and "here are 8,000 fork
 * puzzles at your level" (their corpus). Everything else in the
 * recommendation pipeline is arithmetic; this is the part that encodes
 * actual judgement, so it lives alone in a small, tested file.
 *
 * Two rules held throughout:
 *
 *  1. **Only real motifs.** Lichess also tags descriptors — `short`,
 *     `veryLong`, `middlegame`, `crushing`, `master`, `oneMove`. Those
 *     describe a puzzle's shape or provenance, not the tactic in it, so
 *     they never appear here. Matching on them would serve essentially
 *     random puzzles while claiming to target a weakness.
 *
 *  2. **A miss and a blunder train the same pattern.** We distinguish
 *     `fork` (you walked into one) from `missedFork` (you failed to play
 *     one), because that distinction matters when *reporting* a weakness.
 *     For training it collapses: both are cured by drilling forks until
 *     the shape is automatic. So both map to `fork`.
 *
 * The one deliberate hole is `other`, which maps to nothing. It's the
 * catch-all our detector assigns when it can't name the pattern, so there
 * is no honest theme to match it to — inventing one would quietly fill the
 * Recommended queue with noise. `recommend.ts` therefore drops it, and
 * `motifThemes.test.ts` asserts it stays empty rather than treating that
 * as an oversight to fix.
 */
export const MOTIF_THEMES: Record<Motif, readonly string[]> = {
  // --- Patterns the user walked into -------------------------------------
  hangingPiece: ['hangingPiece'],
  fork: ['fork'],
  pin: ['pin'],
  skewer: ['skewer'],
  discoveredAttack: ['discoveredAttack', 'discoveredCheck'],
  backRank: ['backRankMate'],
  trappedPiece: ['trappedPiece'],

  /** No single Lichess theme means "your defender was overloaded", so we
   *  match the three themes whose solutions all turn on removing or
   *  distracting a defender — which is the skill being trained. */
  overloadedDefender: ['capturingDefender', 'deflection', 'interference'],

  /** Generic material loss with no nameable tactic. Matched to the three
   *  commonest ways material actually goes missing, so it degrades to
   *  "sharpen your material radar" rather than to noise. */
  lostMaterial: ['hangingPiece', 'trappedPiece', 'capturingDefender'],

  /** You let your king get exposed. Trained by attacking puzzles — seeing
   *  the attack from the other side is what teaches you to smell it. */
  weakKing: ['exposedKing', 'kingsideAttack', 'queensideAttack', 'attackingF2F7'],

  // --- Patterns the user failed to play ----------------------------------
  // Same themes as their walked-into counterparts, per rule 2 above.
  missedFork: ['fork'],
  missedPin: ['pin'],
  missedSkewer: ['skewer'],
  missedBackRank: ['backRankMate'],

  /** Missed a forced mate. Capped at mateIn3: a missed mate is almost
   *  always a short one you should have seen, and mateIn4/5 puzzles are a
   *  calculation exercise rather than pattern recognition. */
  missedMate: ['mate', 'mateIn1', 'mateIn2', 'mateIn3'],

  /** You allowed the opponent a mate. The cure is defensive vision:
   *  `defensiveMove` puzzles are only-move saves, and mate patterns train
   *  the recognition that would have warned you. */
  allowedMate: ['defensiveMove', 'mate', 'mateIn1', 'mateIn2'],

  // --- Unnameable --------------------------------------------------------
  /** Intentionally empty. See the file comment. */
  other: [],
};

/** Themes for a set of motifs, de-duplicated. Motifs with no mapping
 *  (`other`) contribute nothing. */
export function themesForMotifs(motifs: Iterable<Motif>): string[] {
  const out = new Set<string>();
  for (const m of motifs) {
    for (const t of MOTIF_THEMES[m] ?? []) out.add(t);
  }
  return [...out];
}
