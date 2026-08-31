import { isNnueAnalysis } from './diff';

/**
 * Which games the off-laptop worker should (re-)analyze.
 *
 * Lives in `src/` rather than beside the worker for two reasons: it is pure
 * policy with no I/O, so it belongs in the unit tier, and importing it from a
 * test must not drag in the worker's `main()`.
 */
interface Candidate {
  gameId: string;
  reason: 'missing' | 'weaker-evaluator' | 'shallower' | 'forced';
}

/**
 * Decide which games need work.
 *
 * Mirrors the ranking in `src/features/sync/diff.ts`: an existing analysis is
 * good enough only if it uses an evaluator at least as strong AND a depth at
 * least as deep. Anything else is a candidate, which is what makes the
 * classical-to-NNUE upgrade a re-analysis of the whole library rather than a
 * special case.
 */
export function selectCandidates(args: {
  gameIds: string[];
  existing: Map<string, { depth: number; engine: string | null }>;
  depth: number;
  wantNnue: boolean;
  force: boolean;
}): Candidate[] {
  const { gameIds, existing, depth, wantNnue, force } = args;
  const out: Candidate[] = [];
  for (const id of gameIds) {
    const cur = existing.get(id);
    if (force) {
      out.push({ gameId: id, reason: 'forced' });
      continue;
    }
    if (!cur) {
      out.push({ gameId: id, reason: 'missing' });
      continue;
    }
    const curNnue = isNnueAnalysis(cur.engine);
    if (wantNnue && !curNnue) {
      out.push({ gameId: id, reason: 'weaker-evaluator' });
      continue;
    }
    // Don't downgrade: if the existing row is NNUE and we're asked for
    // classical, leave it alone.
    if (!wantNnue && curNnue) continue;
    if (cur.depth < depth) out.push({ gameId: id, reason: 'shallower' });
  }
  return out;
}

