import type { Game, TimeClass, TimeClassFilter } from '@/db/schema';
import { TIME_CLASS_ORDER } from '@/db/schema';

/**
 * Return `true` iff a game matches the user's time-class filter. An
 * unknown/missing timeClass is treated as "other" and only included
 * when filter === 'all'.
 */
export function gameMatchesFilter(
  game: Pick<Game, 'timeClass'>,
  filter: TimeClassFilter,
): boolean {
  if (filter === 'all') return true;
  return game.timeClass === filter;
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
