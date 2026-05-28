import { Chess } from 'chess.js';
import {
  OPENING_FAMILIES,
  OPENING_LINES,
  type OpeningFamilyMeta,
  type OpeningLine,
} from '@/data/openings.generated';
import { db, type Color, type Repertoire } from '@/db/schema';
import { addMove, createRepertoire } from '@/features/repertoire/store';

export type { OpeningLine };

export interface FamilyGroup {
  family: string;
  count: number;
  /** Sorted list of ECO codes present in this family. */
  ecos: string[];
  /** Which color is preparing this opening — White (initiator) or Black
   *  (responder). Surfaced everywhere lines are listed so the user knows
   *  what side they'll be playing if they pick this. */
  color: Color;
  /** Authored popularity rank from `data/openings/popularity.tsv` (1 = most
   *  popular per chess.com's published top-20 + master-game frequency
   *  rankings; 999 = obscure / joke opening). Used by `sortFamilies`. */
  popularity: number;
  /** Plain-English blurb explaining the opening's main idea + which kind
   *  of player it suits. Empty string when no description has been
   *  authored (only happens for opening data that landed after the last
   *  popularity.tsv update). */
  description: string;
}

export interface VariationEntry extends OpeningLine {
  plies: number;
}

/** UI-side sort modes for the openings library + persistence. The
 *  string literals are stable; persisted under `chess-coach:openings:sort`
 *  by `LibraryPage`. Bump the persisted-state version if a label is
 *  removed so old rows aren't accidentally rehydrated. */
export type FamilySort = 'popular' | 'most-lines' | 'fewest-lines' | 'alpha';

const FAMILY_SORT_VALUES: readonly FamilySort[] = [
  'popular',
  'most-lines',
  'fewest-lines',
  'alpha',
];

export function isFamilySort(v: unknown): v is FamilySort {
  return typeof v === 'string' && (FAMILY_SORT_VALUES as readonly string[]).includes(v);
}

/** Build the per-family aggregate by joining `OPENING_LINES` with the
 *  authored `OPENING_FAMILIES` metadata (popularity + description).
 *  Computed once at module load — `OPENING_LINES` and `OPENING_FAMILIES`
 *  are both compile-time constants. */
const FAMILIES_RAW: FamilyGroup[] = (() => {
  // ECO set per family — built from OPENING_LINES because OPENING_FAMILIES
  // doesn't carry it (the build script could carry it but it's cheap to
  // recompute and saves bundle size).
  const ecosPerFamily = new Map<string, Set<string>>();
  for (const line of OPENING_LINES) {
    const set = ecosPerFamily.get(line.family) ?? new Set<string>();
    set.add(line.eco);
    ecosPerFamily.set(line.family, set);
  }
  return OPENING_FAMILIES.map(
    (m: OpeningFamilyMeta): FamilyGroup => ({
      family: m.family,
      count: m.lineCount,
      ecos: Array.from(ecosPerFamily.get(m.family) ?? []).sort(),
      color: familyColor(m.family),
      popularity: m.popularity,
      description: m.description,
    }),
  );
})();

/**
 * Group every line by its top-level family name and apply the requested
 * sort. The `'popular'` mode (default) ranks by the authored popularity
 * map from `data/openings/popularity.tsv` with a stable alphabetical
 * tiebreaker, so multiple unranked obscure openings still surface in a
 * deterministic order.
 */
export function getFamilies(sort: FamilySort = 'popular'): FamilyGroup[] {
  return sortFamilies(FAMILIES_RAW, sort);
}

/** Pure sort, exported separately so the unit test can pin every mode
 *  without going through the live dataset. */
export function sortFamilies(
  groups: readonly FamilyGroup[],
  sort: FamilySort,
): FamilyGroup[] {
  const out = groups.slice();
  switch (sort) {
    case 'popular':
      // Lower popularity rank wins; obscure (999) drop to the bottom and
      // tie-break alphabetically inside each rank tier so the order is
      // stable and the user can find a family by scanning A→Z within a
      // tier.
      out.sort(
        (a, b) =>
          a.popularity - b.popularity || a.family.localeCompare(b.family),
      );
      break;
    case 'most-lines':
      out.sort(
        (a, b) => b.count - a.count || a.family.localeCompare(b.family),
      );
      break;
    case 'fewest-lines':
      out.sort(
        (a, b) => a.count - b.count || a.family.localeCompare(b.family),
      );
      break;
    case 'alpha':
      out.sort((a, b) => a.family.localeCompare(b.family));
      break;
  }
  return out;
}

/** Look up the authored description for a family. Returns the empty
 *  string when no description has been authored — the UI hides the
 *  panel in that case rather than rendering an empty card. */
export function familyDescription(family: string): string {
  const meta = OPENING_FAMILIES.find((m) => m.family === family);
  return meta?.description ?? '';
}

/**
 * All variations within a given family, including a synthetic "Main line"
 * entry if the family itself has a bare (variation === "") record. Sorted
 * with the bare entry first, then shortest-path first so users see the
 * canonical lines before the sidelines.
 */
export function getVariations(family: string): VariationEntry[] {
  const rows = OPENING_LINES.filter((l) => l.family === family);
  return rows
    .map((l) => ({ ...l, plies: l.uci.length }))
    .sort((a, b) => {
      if (a.variation === '' && b.variation !== '') return -1;
      if (b.variation === '' && a.variation !== '') return 1;
      if (a.plies !== b.plies) return a.plies - b.plies;
      return a.name.localeCompare(b.name);
    });
}

/**
 * Case-insensitive substring match on ECO + name. Cheap enough to run on
 * every keystroke over the full dataset (~3700 rows).
 */
export function searchOpenings(query: string, limit = 50): VariationEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const out: VariationEntry[] = [];
  for (const line of OPENING_LINES) {
    if (
      line.eco.toLowerCase().includes(q) ||
      line.name.toLowerCase().includes(q)
    ) {
      out.push({ ...line, plies: line.uci.length });
      if (out.length >= limit) break;
    }
  }
  return out;
}

/**
 * Convert a UCI move list into cumulative (fenAfter, san) pairs starting
 * from the initial position. Used by the preview board + move list.
 */
export function replayLine(line: OpeningLine): { fens: string[]; sans: string[] } {
  const c = new Chess();
  const fens: string[] = [c.fen()];
  const sans: string[] = [];
  for (const u of line.uci) {
    const mv = c.move({
      from: u.slice(0, 2),
      to: u.slice(2, 4),
      promotion: u.slice(4, 5) || undefined,
    });
    if (!mv) break;
    fens.push(c.fen());
    sans.push(mv.san);
  }
  return { fens, sans };
}

/**
 * Push every move of `line` through the existing repertoire store so each
 * user-to-move position gets an SRS card. Returns how many moves were
 * added (duplicates get skipped by `addMove`).
 */
export async function addLineToRepertoire(
  repertoireId: string,
  line: OpeningLine,
): Promise<number> {
  const c = new Chess();
  let added = 0;
  for (const uci of line.uci) {
    const parentFen = c.fen();
    const mv = c.move({
      from: uci.slice(0, 2),
      to: uci.slice(2, 4),
      promotion: uci.slice(4, 5) || undefined,
    });
    if (!mv) break;
    const node = await addMove(repertoireId, parentFen, uci);
    if (node) added++;
  }
  return added;
}

/**
 * Add every line in a family to a repertoire. Each line is processed
 * sequentially so that shared prefixes collapse into the same nodes
 * (the store dedupes by FEN). Stamps `Repertoire.bulkLoadedAt` on
 * completion so the openings page can show "All lines added" instead
 * of letting the user click the bulk-add button again.
 */
export async function addFamilyToRepertoire(
  repertoireId: string,
  family: string,
  onProgress?: (done: number, total: number) => void,
): Promise<number> {
  const lines = OPENING_LINES.filter((l) => l.family === family);
  let total = 0;
  for (let i = 0; i < lines.length; i++) {
    total += await addLineToRepertoire(repertoireId, lines[i]);
    onProgress?.(i + 1, lines.length);
  }
  await db.repertoires.update(repertoireId, { bulkLoadedAt: Date.now() });
  return total;
}

/**
 * Return the user's repertoires for the given color, creating a default
 * one if none exist. Used by the "Add to repertoire" action on the
 * library page so the button is never dead.
 */
export async function repertoiresForColor(color: Color): Promise<Repertoire[]> {
  return db.repertoires.where('color').equals(color).toArray();
}

/**
 * Locate (or create) the repertoire bound to a specific openings-library
 * family. Used by the family-first add flow on the library page: the
 * user picks a Najdorf line, and we route it into "their" Sicilian
 * Defense repertoire (creating one on the fly if needed).
 *
 * Color is inferred from the family — colour-mismatched families don't
 * exist in our dataset (a Sicilian rep is *always* black-side prep).
 *
 * Idempotent: subsequent calls return the same repertoire row.
 */
export async function ensureFamilyRepertoire(family: string): Promise<Repertoire> {
  const color = familyColor(family);
  // Filter on the indexed `color` first, then narrow to the family in
  // JS — `family` isn't indexed. The result set is tiny in practice
  // (a user has maybe 5\u201320 repertoires), so the JS filter is
  // cheap.
  const candidates = await db.repertoires.where('color').equals(color).toArray();
  const existing = candidates.find(
    (r) => r.kind === 'family' && r.family === family,
  );
  if (existing) return existing;
  return createRepertoire({
    name: family,
    color,
    kind: 'family',
    family,
  });
}

/**
 * Backwards-compat: pre-family-refactor call sites that just want
 * "some repertoire for this color, create if missing". Now creates a
 * legacy `'custom'` repertoire rather than a family-bound one — call
 * `ensureFamilyRepertoire(family)` from new code.
 */
export async function ensureRepertoire(
  color: Color,
  name = color === 'white' ? 'My White Repertoire' : 'My Black Repertoire',
): Promise<Repertoire> {
  const existing = await repertoiresForColor(color);
  if (existing.length > 0) return existing[0];
  return createRepertoire({ name, color, kind: 'custom' });
}

/**
 * Which side picks this opening — i.e. who needs to know it as preparation?
 *
 * The Lichess dataset names are remarkably consistent: families whose name
 * ends with "Defense" (or "Defence", or familiar shorthands like "Sicilian"
 * / "Caro-Kann" / "Pirc") are Black's response systems; everything else
 * (Openings, Attacks, Gambits, named Games, etc.) is initiated by White.
 * For lines that BOTH sides need to know (mainline Italian, QGD), we pick
 * the side that "owns" the variation by whose turn it is at the deepest ply.
 */
export function colorHint(line: OpeningLine): Color {
  const family = line.family;
  // Hard-coded list of families that are unambiguously Black-side prep
  // (Black is the one choosing the system). Covers everything in the
  // Lichess dataset that doesn't end with "Defense" but should.
  const BLACK_FAMILIES = new Set<string>([
    'Sicilian Defense',
    'Caro-Kann Defense',
    'French Defense',
    'Pirc Defense',
    'Modern Defense',
    'Alekhine Defense',
    'Scandinavian Defense',
    'Nimzo-Indian Defense',
    "Queen's Indian Defense",
    "King's Indian Defense",
    'Grünfeld Defense',
    "Queen's Gambit Declined",
    "Queen's Gambit Accepted",
    'Slav Defense',
    'Semi-Slav Defense',
    'Dutch Defense',
    'Benoni Defense',
    'Benko Gambit',
    'Old Indian Defense',
    'Bogo-Indian Defense',
    'Tarrasch Defense',
    'Chigorin Defense',
    'Czech Defense',
    "Owen's Defense",
    "St. George Defense",
    "Robatsch Defense",
    'Englund Gambit',
    'Budapest Defense',
    'Albin Countergambit',
    "Marshall Defense",
  ]);
  if (BLACK_FAMILIES.has(family)) return 'black';
  // Family name ends with "Defense"/"Defence" -> Black's prep.
  const lower = family.toLowerCase();
  if (lower.endsWith('defense') || lower.endsWith('defence')) return 'black';
  if (lower.includes('countergambit')) return 'black';
  // Default: White is the one initiating the opening (anything labeled
  // Opening/Attack/Gambit/Game/named-after-a-master).
  return 'white';
}

/** Human-friendly label for the colorHint output. */
export function colorLabel(c: Color): string {
  return c === 'white' ? 'You play White' : 'You play Black';
}

/** Family-level color hint. Defers to the first line in the family. */
export function familyColor(family: string): Color {
  const first = OPENING_LINES.find((l) => l.family === family);
  if (!first) return 'white';
  return colorHint(first);
}

/**
 * Best-effort identification of the opening that a UCI move sequence
 * represents. Returns the longest known book line that is a prefix of
 * the input, so e.g. a 12-ply Najdorf line matches the deepest Najdorf
 * variation rather than just "1.e4".
 *
 * Returns null when nothing in the library covers even the first move
 * (extremely rare with the Lichess dataset, but possible for joke lines).
 */
export function identifyOpening(uci: string[]): {
  family: string;
  variation: string;
  name: string;
  eco: string;
} | null {
  if (uci.length === 0) return null;
  let best: OpeningLine | null = null;
  for (const line of OPENING_LINES) {
    if (line.uci.length === 0 || line.uci.length > uci.length) continue;
    let match = true;
    for (let i = 0; i < line.uci.length; i++) {
      if (line.uci[i] !== uci[i]) {
        match = false;
        break;
      }
    }
    if (!match) continue;
    if (!best || line.uci.length > best.uci.length) best = line;
  }
  if (!best) return null;
  return {
    family: best.family,
    variation: best.variation,
    name: best.name,
    eco: best.eco,
  };
}
