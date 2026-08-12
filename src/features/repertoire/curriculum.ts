import type { RepertoireLineStats } from '@/db/schema';
import type { RankedOpeningLine } from '@/features/openings/recommendations';
import { openingLineKey } from '@/features/openings/recommendations';
import type { RepertoireLine } from './store';

export const GUIDED_STARTER_SIZE = 5;
export const GUIDED_EXPANSION_SIZE = 2;

export function isLineMastered(
  stats: Pick<RepertoireLineStats, 'perfectCompletions' | 'completions'> | undefined,
): boolean {
  return Boolean(
    stats &&
    (stats.perfectCompletions >= 1 || stats.completions >= 2),
  );
}

export function initialActiveLineKeys(
  ranked: readonly RankedOpeningLine[],
  limit = GUIDED_STARTER_SIZE,
): string[] {
  return ranked
    .slice(0, Math.max(0, limit))
    .map((entry) => openingLineKey(entry.line.uci));
}

/**
 * An active library line may be a prefix of an already-bulk-imported leaf.
 * Pick the shortest matching leaf so legacy "everything imported" trees can
 * enter guided mode without deleting nodes or losing training history.
 */
export function guidedLineIndices(
  lines: readonly RepertoireLine[],
  activeLineKeys: readonly string[],
): number[] {
  const selected = new Set<number>();
  for (const activeKey of activeLineKeys) {
    let bestIndex = -1;
    let bestLength = Infinity;
    for (let index = 0; index < lines.length; index++) {
      const lineKey = openingLineKey(lines[index].uci);
      if (lineKey !== activeKey && !lineKey.startsWith(`${activeKey} `)) continue;
      if (lines[index].uci.length < bestLength) {
        bestIndex = index;
        bestLength = lines[index].uci.length;
      }
    }
    if (bestIndex >= 0) selected.add(bestIndex);
  }
  return [...selected].sort((a, b) => a - b);
}

/**
 * `guidedLineIndices`, but never empty when the repertoire has lines.
 *
 * Active keys come from the *library* recommendations, and a key only
 * matches a repertoire line that equals or **extends** it. So a sparse
 * repertoire whose lines are SHALLOWER than the recommendations matches
 * nothing: seed just the 5-ply Italian mainline and the top-5 recommended
 * lines are all 6+ ply continuations of it, leaving the drill page with an
 * empty session and no board — nothing to practise, on a page whose whole
 * job is practising. (Which lines rank top-5 shifts with every opening-data
 * refresh, so this is latent rather than rare.)
 *
 * When nothing matches, fall back to the lines the repertoire actually
 * has, capped at the guided starter size so "guided" still means a small
 * focused set.
 */
export function drillableGuidedIndices(
  lines: readonly RepertoireLine[],
  activeLineKeys: readonly string[],
  limit = GUIDED_STARTER_SIZE,
): number[] {
  const matched = guidedLineIndices(lines, activeLineKeys);
  if (matched.length > 0) return matched;
  return lines.slice(0, Math.max(0, limit)).map((_, index) => index);
}

export function areGuidedLinesMastered(
  lines: readonly RepertoireLine[],
  selectedIndices: readonly number[],
  stats: ReadonlyMap<string, RepertoireLineStats>,
): boolean {
  if (selectedIndices.length === 0) return false;
  return selectedIndices.every((index) =>
    isLineMastered(stats.get(openingLineKey(lines[index].uci))),
  );
}

export function nextRecommendedLines(
  ranked: readonly RankedOpeningLine[],
  activeLineKeys: readonly string[],
  limit = GUIDED_EXPANSION_SIZE,
): RankedOpeningLine[] {
  const active = new Set(activeLineKeys);
  return ranked
    .filter((entry) => !active.has(openingLineKey(entry.line.uci)))
    .slice(0, Math.max(0, limit));
}

export function appendActiveLineKeys(
  current: readonly string[],
  additions: readonly string[],
): string[] {
  return [...new Set([...current, ...additions])];
}
