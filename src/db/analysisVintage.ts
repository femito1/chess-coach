import type { Analysis } from './schema';

/**
 * The classification rules vintage, and the identity of a stored search.
 *
 * Lives apart from `queries.ts` because the off-laptop worker needs both and
 * must not pull in Dexie (type-only imports from `schema` are erased). The bump
 * rules for `RECOMPUTE_VERSION` are documented beside the other version stamps
 * in `queries.ts`, which re-exports it.
 */
export const RECOMPUTE_VERSION = 3;

/**
 * Is `now` the same engine search as `read`?
 *
 * The recompute pass reads a row, spends a while reclassifying it with yields
 * in between, then writes it back. Anything that replaced the row in that
 * window — a requeue's fresh analysis, a cloud pull of a better one — is a
 * different search, and writing the stale row's re-derivation over it would
 * silently revert it. `analyzedAt` + `engine` + `depth` identify the search;
 * the derived fields are exactly what the pass rewrites, so they cannot be part
 * of the identity. A missing row (a requeue deleted it) is never the same.
 */
export function isSameSearch(
  read: Pick<Analysis, 'analyzedAt' | 'engine' | 'depth'>,
  now: Pick<Analysis, 'analyzedAt' | 'engine' | 'depth'> | undefined,
): boolean {
  return (
    now !== undefined &&
    now.analyzedAt === read.analyzedAt &&
    now.engine === read.engine &&
    now.depth === read.depth
  );
}
