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

/**
 * Games whose cloud analysis is already good enough but whose game row was
 * never marked `done` — they need the row settled, not a re-analysis.
 *
 * The worker writes two rows per game, analysis first and summary second, and
 * PostgREST gives it no transaction across them. A run killed between the two
 * (the 55-minute task timeout is the routine way) left the analysis present and
 * the game `pending`, and `selectCandidates` then skipped the game forever
 * because an adequate analysis existed. A device that already had the game
 * pending was fine — a pulled analysis settles it locally — but every other
 * reader of `cloud_games` saw an unanalyzed game. Settling costs one analysis
 * fetch and no engine time, so it is done for every such game on every run.
 *
 * A candidate is excluded: it is about to be re-analyzed, which settles it.
 */
export function selectUnsettled(args: {
  games: ReadonlyArray<{ game_id: string; analysis_status: string | null }>;
  existing: ReadonlyMap<string, unknown>;
  candidates: readonly Candidate[];
}): string[] {
  const queued = new Set(args.candidates.map((c) => c.gameId));
  return args.games
    .filter(
      (g) =>
        g.analysis_status !== 'done' &&
        args.existing.has(g.game_id) &&
        !queued.has(g.game_id),
    )
    .map((g) => g.game_id);
}

