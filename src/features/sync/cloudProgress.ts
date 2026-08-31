import type { SupabaseClient } from '@supabase/supabase-js';
import { isNnueAnalysis } from './diff';

/**
 * How far the cloud library has been analyzed — counts only.
 *
 * ── Why this exists ──────────────────────────────────────────────────────
 *
 * The server-side worker (`scripts/worker/`) re-analyzes the whole library with
 * NNUE on a real CPU, and it can run for hours. Until now the only way to watch
 * it was to tail its stdout, which means the progress of a job the user started
 * is invisible from the app that consumes its output. The Settings sync card is
 * where the user already looks for "what does the cloud know", so the readout
 * goes there.
 *
 * ── Why counts, and nothing but counts ───────────────────────────────────
 *
 * A progress bar needs three integers. Fetching rows to derive them would move
 * megabytes to render a fraction, and this card polls — so it would move them
 * repeatedly. PostgREST can answer with a bare count and no body at all
 * (`select('*', { count: 'exact', head: true })` sends `HEAD` with
 * `Prefer: count=exact` and reads the total off the `Content-Range` header), so
 * one refresh is three requests of a few hundred bytes each regardless of
 * library size. `data` is never touched; if you find yourself adding `.select`
 * columns here, you have lost the property that makes polling affordable.
 *
 * RLS scopes every table to the caller's own rows, and we filter on `user_id`
 * anyway so the count is right even if that ever loosens.
 */

/** Raw totals as the database reports them. */
export interface CloudCounts {
  /** Rows in `cloud_games` for this user. */
  games: number;
  /** Rows in `cloud_analyses` for this user. */
  analyses: number;
  /** Of those, how many came from the NNUE evaluator. */
  nnueAnalyses: number;
}

export interface CloudProgressSummary extends CloudCounts {
  /** Analyses still on the weaker classical evaluator. */
  classicalAnalyses: number;
  /** Analyzed share of the library, 0–100, clamped and integral. */
  percent: number;
  /** Every game analyzed. Stops the poll — see `useCloudProgress`. */
  complete: boolean;
  /** Every analysis is NNUE. The worker's actual finish line: a library can be
   *  100 % analyzed and still be full of classical evals awaiting re-analysis. */
  allNnue: boolean;
  /** Nothing in the cloud yet, so there is no progress to report. */
  empty: boolean;
}

/**
 * Pure derivation of everything the card renders.
 *
 * Defensive about `analyses > games`, which is a real state rather than a bug:
 * the cloud never deletes (no DELETE policy, see `supabase/cloud-sync.sql`), so
 * an analysis can outlive the game row's local counterpart and a requeued game
 * can briefly leave the ratio above 1. Clamping keeps the bar inside its track
 * instead of overflowing it.
 */
export function summarizeCloudProgress(counts: CloudCounts): CloudProgressSummary {
  const games = Math.max(0, counts.games);
  const analyses = Math.max(0, counts.analyses);
  const nnueAnalyses = Math.max(0, Math.min(analyses, counts.nnueAnalyses));
  const percent = games === 0 ? 0 : Math.min(100, Math.round((analyses / games) * 100));
  return {
    games,
    analyses,
    nnueAnalyses,
    classicalAnalyses: analyses - nnueAnalyses,
    percent,
    // `games === 0` is deliberately NOT complete: an empty cloud has nothing to
    // report, and calling it "done" would both read wrong and stop the poll
    // before the first upload ever lands.
    complete: games > 0 && analyses >= games,
    allNnue: analyses > 0 && nnueAnalyses === analyses,
    empty: games === 0 && analyses === 0,
  };
}

/**
 * PostgREST pattern that matches every NNUE `engine` value.
 *
 * Kept as a `like` against the same substring `isNnueAnalysis` tests for, so the
 * database's idea of "NNUE" cannot drift from the app's. Asserted below.
 */
export const NNUE_ENGINE_PATTERN = '%nnue%';

// Cheap coherence guard: if someone renames the evaluator ids such that
// `isNnueAnalysis` stops keying on `nnue`, this pattern would silently count
// zero and the card would report an all-classical library forever.
if (!isNnueAnalysis('stockfish-16-nnue') || isNnueAnalysis('stockfish-16-classical')) {
  throw new Error(
    'cloudProgress: NNUE_ENGINE_PATTERN is out of step with isNnueAnalysis()',
  );
}

/** One count query. Returns null if the table could not be counted. */
async function countRows(
  supabase: SupabaseClient,
  table: string,
  userId: string,
  refine?: (q: CountQuery) => CountQuery,
): Promise<number | null> {
  // `head: true` is what makes this free: no rows are serialised, only the
  // `Content-Range` total comes back.
  let q = supabase
    .from(table)
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId) as unknown as CountQuery;
  if (refine) q = refine(q);
  const { count, error } = await q;
  if (error) return null;
  return count ?? 0;
}

/** The slice of the PostgREST builder we use. Narrowed by hand because the
 *  generated types don't survive the `head: true` overload cleanly. */
interface CountQuery
  extends PromiseLike<{ count: number | null; error: { message: string } | null }> {
  like(column: string, pattern: string): CountQuery;
}

/**
 * Fetch all three counts concurrently.
 *
 * Never throws: a failure (offline, table missing, RLS refusal) surfaces as
 * `{ error }` so the card can stay quiet rather than turning a cosmetic readout
 * into a page error. Cloud sync is mounted app-wide, so noisy failure here would
 * be noisy everywhere.
 */
export async function fetchCloudCounts(
  supabase: SupabaseClient,
  userId: string,
): Promise<{ counts: CloudCounts | null; error?: string }> {
  try {
    const [games, analyses, nnueAnalyses] = await Promise.all([
      countRows(supabase, 'cloud_games', userId),
      countRows(supabase, 'cloud_analyses', userId),
      countRows(supabase, 'cloud_analyses', userId, (q) =>
        q.like('engine', NNUE_ENGINE_PATTERN),
      ),
    ]);
    if (games === null || analyses === null || nnueAnalyses === null) {
      return { counts: null, error: 'count query failed' };
    }
    return { counts: { games, analyses, nnueAnalyses } };
  } catch (err) {
    return { counts: null, error: err instanceof Error ? err.message : String(err) };
  }
}
