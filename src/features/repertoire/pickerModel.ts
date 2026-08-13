import type { OpeningLine } from '@/features/openings/library';
import {
  openingLineKey,
  personalRecordForLine,
  type PersonalLineRecord,
  type PersonalOpeningStats,
} from '@/features/openings/recommendations';
import {
  tiersForFamily,
  type LineDifficulty,
  type Tier,
} from '@/features/openings/difficulty';

/**
 * The unified drill-page line list.
 *
 * The practice page has always shown only lines already in the
 * repertoire (`enumerateLines`), so the one place you'd want to *discover*
 * a new line to learn — the library (`getVariations`) — lived on another
 * page. This model merges the two into one list per family, so from the
 * drill page you can see every line the library offers for the openings
 * you play, tiered Easy/Medium/Hard, with the ones already in your
 * repertoire marked as such.
 *
 * The merge is keyed by `openingLineKey`, and — crucially — a library
 * variation counts as "in the repertoire" when a repertoire leaf *extends*
 * it, not only when it matches exactly. Bulk-imported trees store full
 * leaves, so a shallow library variation is usually a prefix of a deeper
 * stored line; the same reasoning `curriculum.guidedLineIndices` uses.
 * When we need an index to actually drill, we point at the shortest
 * matching leaf, exactly as guided mode does.
 */
export interface PickerEntry {
  /** openingLineKey(uci) — stable identity across repertoire and library. */
  key: string;
  uci: string[];
  /** SAN for every ply, so a row can show the moves that distinguish it
   *  from a same-named sibling (see `sharesLabel`). */
  san: string[];
  family: string;
  variation: string;
  eco: string;
  plies: number;
  tier: Tier;
  forcedness: LineDifficulty['forcedness'];
  record: PersonalLineRecord | null;
  globalShare: number;
  globalGames: number;
  /** True when a repertoire leaf equals or extends this line. */
  inRepertoire: boolean;
  /** Index into the caller's repertoire-line array to drill for this
   *  entry (the shortest matching leaf), or null when not in the
   *  repertoire yet. */
  repertoireIndex: number | null;
  /** True when the matched leaf is this line EXACTLY, rather than a
   *  deeper leaf that merely extends it. Only then does drilling via the
   *  session test the same moves this entry describes — a bulk-imported
   *  tree stores full leaves, so a shallow library variation usually
   *  matches a much deeper line, and drilling that leaf would test moves
   *  the user was never shown. Callers drill inexact matches as a
   *  standalone line instead. */
  leafIsExact: boolean;
  /**
   * True when another entry in the SAME family carries the same
   * `variation` label — so the label alone cannot identify this row and
   * the UI must show the moves.
   *
   * This is the common case, not a corner one: the bundled ECO data names
   * a variation at several depths (Sicilian "Closed" ×8, Italian "Classical
   * Variation, Giuoco Pianissimo" ×14), and about half of those groups are
   * genuinely divergent branches rather than deeper cuts of one line. Rows
   * with a blank `variation` collide too, since they all render through the
   * same fallback label.
   */
  sharesLabel: boolean;
  /**
   * True for entries synthesized from a repertoire leaf that no library
   * line matches (custom or unidentified trees). They have no ECO and no
   * variation name, so the UI must NOT label them "mainline" — they're
   * whatever the user imported.
   */
  isCustom: boolean;
  /** Lowercased `family + variation + eco + san`, precomputed so the
   *  picker's search box can filter on every keystroke without rebuilding
   *  a haystack per row. The UI adds the rendered fallback label, which
   *  is i18n and therefore not the model's business. */
  searchText: string;
}

export interface PickerFamily {
  family: string;
  entries: PickerEntry[];
}

/** Lean shape of a repertoire leaf the model needs — the caller passes
 *  its decorated lines mapped down to this. Index is the position in the
 *  caller's own array, used to drive the existing drill session. */
export interface RepertoireLeaf {
  uci: string[];
  /** SAN for every ply of the leaf. Used for the entries that exist only
   *  in the repertoire, which have no library row to read moves from. */
  san: readonly string[];
  family: string;
}

export interface PickerModelInput {
  /** Repertoire leaves, in the caller's array order (index === drill index). */
  repertoireLeaves: readonly RepertoireLeaf[];
  /** Library variations for every family to display, keyed by family. The
   *  caller builds this from `getVariations(family)`. */
  libraryByFamily: ReadonlyMap<string, readonly OpeningLine[]>;
  personal: PersonalOpeningStats;
}

/** Does a repertoire leaf key equal or extend a library line key? */
function leafMatchesLine(leafKey: string, lineKey: string): boolean {
  return leafKey === lineKey || leafKey.startsWith(`${lineKey} `);
}

/**
 * SAN tokens from an `OpeningLine.pgn` string ("1. e4 c5 2. Nf3" →
 * ["e4", "c5", "Nf3"]).
 *
 * The bundled lines already carry their PGN, so reading SAN off the text is
 * both exact and free — replaying 380 Sicilian lines through chess.js to
 * recover the same strings would cost thousands of move() calls on every
 * picker rebuild. Verified against the whole bundle: for all 3690 rows the
 * token count equals `uci.length`, and castling is the only non-piece token
 * shape in there.
 *
 * Anything that looks like a move number ("12.", "12...") is dropped;
 * everything else passes through untouched, so an unexpected token shape
 * degrades to a slightly noisy ribbon rather than a wrong one.
 */
export function sanTokensFromPgn(pgn: string): string[] {
  return pgn
    .split(/\s+/)
    .filter((token) => token.length > 0 && !/^\d+\.+$/.test(token));
}

/**
 * Build the per-family unified list. Pure over its inputs (no dataset or
 * Dexie access), so it is unit-testable with synthetic data.
 *
 * Families are ordered by first appearance in `libraryByFamily`'s
 * insertion order, then any families that exist only in the repertoire
 * (custom/unidentified lines) appended. Within a family, in-repertoire
 * entries come first, then library-only, each block ordered by ply then
 * name so canonical lines lead.
 */
export function buildPickerModel(input: PickerModelInput): PickerFamily[] {
  const { repertoireLeaves, libraryByFamily, personal } = input;

  // Index leaves by key, and keep them sorted by depth so "shortest
  // matching leaf" is a simple find.
  const leavesByDepth = repertoireLeaves
    .map((leaf, index) => ({ leaf, index, key: openingLineKey(leaf.uci) }))
    .sort((a, b) => a.leaf.uci.length - b.leaf.uci.length);

  /** The shortest repertoire leaf equal-to/extending a library line, with
   *  whether that leaf is the line itself. Null when no leaf matches. */
  function drillTargetFor(
    lineKey: string,
  ): { index: number; exact: boolean } | null {
    for (const { key, index } of leavesByDepth) {
      if (leafMatchesLine(key, lineKey)) {
        return { index, exact: key === lineKey };
      }
    }
    return null;
  }

  const families: PickerFamily[] = [];
  const claimedLeafIndices = new Set<number>();

  for (const [family, lines] of libraryByFamily) {
    const tiers = tiersForFamily(lines, personal);
    const entries: PickerEntry[] = lines.map((line) => {
      const key = openingLineKey(line.uci);
      const diff = tiers.get(key)!;
      const target = drillTargetFor(key);
      const repertoireIndex = target?.index ?? null;
      if (repertoireIndex != null) claimedLeafIndices.add(repertoireIndex);
      const san = sanTokensFromPgn(line.pgn);
      return {
        key,
        uci: [...line.uci],
        san,
        family: line.family,
        variation: line.variation,
        eco: line.eco,
        plies: line.uci.length,
        tier: diff.tier,
        forcedness: diff.forcedness,
        record: diff.record,
        globalShare: line.globalShare,
        globalGames: line.globalGames,
        inRepertoire: repertoireIndex != null,
        repertoireIndex,
        leafIsExact: target?.exact ?? false,
        sharesLabel: false, // filled in by `markSharedLabels` below
        isCustom: false,
        searchText: searchTextFor(line.family, line.variation, line.eco, san),
      };
    });
    entries.sort(sortEntries);
    families.push({ family, entries });
  }

  // Repertoire leaves not represented by any library line (custom trees,
  // unidentified openings). Group by their own family, tier on depth alone
  // via the small-family fallback, and mark them in-repertoire.
  const orphanByFamily = new Map<string, RepertoireLeaf[]>();
  leavesByDepth.forEach(({ leaf, index }) => {
    if (claimedLeafIndices.has(index)) return;
    const arr = orphanByFamily.get(leaf.family) ?? [];
    arr.push(leaf);
    orphanByFamily.set(leaf.family, arr);
  });
  for (const [family, leaves] of orphanByFamily) {
    // Synthesize minimal OpeningLines so tiering is at least depth-aware.
    const synthetic: OpeningLine[] = leaves.map((leaf) => ({
      eco: '',
      name: family,
      family,
      variation: '',
      uci: [...leaf.uci],
      pgn: '',
      globalGames: 0,
      globalShare: 0,
    }));
    const tiers = tiersForFamily(synthetic, personal);
    const entries: PickerEntry[] = leaves.map((leaf) => {
      const key = openingLineKey(leaf.uci);
      const diff = tiers.get(key)!;
      const san = [...leaf.san];
      return {
        key,
        uci: [...leaf.uci],
        san,
        family,
        variation: '',
        eco: '',
        plies: leaf.uci.length,
        tier: diff.tier,
        forcedness: null,
        record: personalRecordForLine(personal, leaf.uci),
        globalShare: 0,
        globalGames: 0,
        inRepertoire: true,
        // These entries ARE repertoire leaves, so the drill target is the
        // line itself by construction.
        repertoireIndex: repertoireLeaves.findIndex(
          (l) => openingLineKey(l.uci) === key,
        ),
        leafIsExact: true,
        sharesLabel: false, // filled in by `markSharedLabels` below
        isCustom: true,
        searchText: searchTextFor(family, '', '', san),
      };
    });
    entries.sort(sortEntries);
    const existing = families.find((f) => f.family === family);
    if (existing) existing.entries.push(...entries);
    else families.push({ family, entries });
  }

  // Last, so the pass sees each family's final entry list — orphans are
  // appended above and collide with each other under the same blank label.
  for (const fam of families) markSharedLabels(fam.entries);

  return families;
}

/** In-repertoire first, then by ply, then by name — canonical lines lead. */
function sortEntries(a: PickerEntry, b: PickerEntry): number {
  if (a.inRepertoire !== b.inRepertoire) return a.inRepertoire ? -1 : 1;
  if (a.plies !== b.plies) return a.plies - b.plies;
  return a.variation.localeCompare(b.variation);
}

function searchTextFor(
  family: string,
  variation: string,
  eco: string,
  san: readonly string[],
): string {
  return [family, variation, eco, san.join(' ')].join(' ').toLowerCase();
}

/**
 * Flag every entry whose `variation` label is not unique within its family,
 * mutating in place. Grouped case-insensitively on the trimmed label so
 * "Main Line" and "Main line" — both present in the bundle — count as the
 * collision a reader would see.
 */
function markSharedLabels(entries: PickerEntry[]): void {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const label = entry.variation.trim().toLowerCase();
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  for (const entry of entries) {
    const label = entry.variation.trim().toLowerCase();
    entry.sharesLabel = (counts.get(label) ?? 0) > 1;
  }
}
