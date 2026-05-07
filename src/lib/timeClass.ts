import type {
  Game,
  TimeClass,
  TimeClassFilter,
  TimeClassSelection,
} from '@/db/schema';
import { TIME_CLASS_ORDER } from '@/db/schema';

/**
 * Single-value variant kept for callers that still treat the filter as
 * "one bucket or all". Returns `true` when the game's `timeClass`
 * matches the requested filter, treating an unknown/missing class as
 * "other" (only matches when filter === 'all').
 *
 * New code should prefer `gameMatchesSelection` which takes a
 * multi-select array, matching the chip filter UI.
 */
export function gameMatchesFilter(
  game: Pick<Game, 'timeClass'>,
  filter: TimeClassFilter,
): boolean {
  if (filter === 'all') return true;
  return game.timeClass === filter;
}

/**
 * Multi-select variant: a game matches when its `timeClass` is in
 * `selection`. An EMPTY selection is treated as "no filter" (all
 * games match) — that's what an unticked chip-bar means in the UI.
 *
 * The empty-array semantics matter because `Settings.timeClassFilter`
 * persists as `[]` to mean "all time controls", and we want the same
 * semantics across every page that reads it.
 *
 * The `'__none__'` sentinel (see `TimeClassChips`) means "user
 * explicitly deselected every chip" — it matches no games. We
 * represent it as a single-element array containing a non-existent
 * class so the persisted shape stays `TimeClass[]` (no schema bump
 * needed) and `gameMatchesSelection` short-circuits to `false`.
 */
export function gameMatchesSelection(
  game: Pick<Game, 'timeClass'>,
  selection: TimeClassSelection,
): boolean {
  if (selection.length === 1 && (selection[0] as string) === '__none__') {
    return false;
  }
  if (selection.length === 0) return true;
  if (!game.timeClass) return false;
  return selection.includes(game.timeClass as TimeClass);
}

/**
 * The set of time-classes actually represented in the user's library,
 * ordered the way we show them in UI (rapid first).
 */
export function availableTimeClasses(games: Pick<Game, 'timeClass'>[]): TimeClass[] {
  const set = new Set<string>();
  for (const g of games) if (g.timeClass) set.add(g.timeClass);
  return TIME_CLASS_ORDER.filter((tc) => set.has(tc));
}

/**
 * Single-bucket label. Used for old single-value sites + as the
 * per-chip label.
 */
export function labelFor(filter: TimeClassFilter): string {
  if (filter === 'all') return 'All time controls';
  const labels: Record<TimeClass, string> = {
    rapid: 'Rapid',
    blitz: 'Blitz',
    bullet: 'Bullet',
    daily: 'Daily',
    classical: 'Classical',
  };
  return labels[filter];
}

/**
 * Human label for a multi-select chip filter, used in summary lines
 * like "Patterns across 124 analyzed rapid + blitz games...".
 *
 *   []                     → "All time controls"
 *   ['rapid']              → "Rapid"
 *   ['rapid','blitz']      → "Rapid + Blitz"
 *   ['rapid','blitz',...]  → "Rapid + Blitz + …"
 */
export function labelForSelection(selection: TimeClassSelection): string {
  if (selection.length === 0) return 'All time controls';
  // Render in canonical order so ordering is stable regardless of
  // which order the user clicked the chips.
  const ordered = TIME_CLASS_ORDER.filter((tc) => selection.includes(tc));
  return ordered.map(labelFor).join(' + ');
}

/** True when this selection means "match every game". */
export function isAllTimeClasses(selection: TimeClassSelection): boolean {
  return selection.length === 0;
}

/**
 * Toggle a time-class in/out of the selection. Pure — used by the chip
 * bar's onClick. Always returns a fresh array so React state updates
 * are detected.
 *
 * The "you can't deselect every chip" rule is intentionally NOT
 * enforced here; the empty array is a valid state meaning "all time
 * controls". The chip UI surfaces an "All" toggle that flips between
 * `[]` and the historical default explicitly.
 */
export function toggleTimeClass(
  selection: TimeClassSelection,
  tc: TimeClass,
): TimeClassSelection {
  if (selection.includes(tc)) {
    return selection.filter((x) => x !== tc);
  }
  // Preserve canonical order on add so callers don't have to.
  return TIME_CLASS_ORDER.filter((x) => x === tc || selection.includes(x));
}
