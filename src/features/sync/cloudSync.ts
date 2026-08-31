import type { SupabaseClient } from '@supabase/supabase-js';
import { db, type Analysis, type Game, type PuzzleAttempt } from '@/db/schema';
import { listAllGamesLight, listAnalysesLight } from '@/db/queries';
import { computeAccuracy, countUserBrilliancies } from '@/engine/analyzer';
import {
  BATCH_ANALYSES,
  BATCH_ATTEMPTS,
  BATCH_GAMES,
  chunk,
  diffAnalyses,
  diffAttempts,
  diffGames,
  toCloudAnalysis,
  toCloudAttempt,
  toCloudGame,
  type RemoteAnalysisMeta,
  type RemoteGameMeta,
} from './diff';

/**
 * Imperative shell around `diff.ts`: reads both manifests, runs the pure
 * reconciliation, then executes the resulting plan against Supabase and Dexie.
 *
 * Everything here is resumable. A sync that dies halfway leaves both sides
 * consistent-but-incomplete, and the next run re-diffs and finishes the job —
 * there is no partial-write bookkeeping to get wrong. That's the main payoff of
 * the manifest-diff design (see the header in `diff.ts`).
 *
 * Gating: writes are refused by RLS unless the account is in
 * `cloud_sync_allowlist` (see `supabase/cloud-sync.sql`). `isSyncEnabled` asks
 * that same table so the UI can avoid pointless failing requests, but it is a
 * convenience, not the security boundary — the database is.
 */

export interface SyncCounts {
  gamesPushed: number;
  gamesPulled: number;
  analysesPushed: number;
  analysesPulled: number;
  attemptsPushed: number;
  attemptsPulled: number;
  /** Games whose local `analysisStatus` a pulled analysis settled to `done`.
   *  Not a transfer count — it is how many games the local queue no longer has
   *  to re-analyze — so `countsTotal` deliberately leaves it out. */
  gamesSettled: number;
}

export interface SyncResult extends SyncCounts {
  /** Total bytes of analysis JSON uploaded, for the UI to report honestly on
   *  a first sync that may move tens of megabytes. */
  bytesPushed: number;
  durationMs: number;
}

export const emptyCounts = (): SyncCounts => ({
  gamesPushed: 0,
  gamesPulled: 0,
  analysesPushed: 0,
  analysesPulled: 0,
  attemptsPushed: 0,
  attemptsPulled: 0,
  gamesSettled: 0,
});

export function countsTotal(c: SyncCounts): number {
  return (
    c.gamesPushed +
    c.gamesPulled +
    c.analysesPushed +
    c.analysesPulled +
    c.attemptsPushed +
    c.attemptsPulled
  );
}

/** Progress ticks so a multi-minute first sync isn't a frozen spinner. */
export interface SyncProgress {
  phase: 'manifest' | 'games' | 'analyses' | 'attempts' | 'done';
  done: number;
  total: number;
}

export interface SyncOptions {
  supabase: SupabaseClient;
  userId: string;
  onProgress?: (p: SyncProgress) => void;
  /** Abort cooperatively (e.g. the component unmounted). */
  signal?: { aborted: boolean };
}

/**
 * Is this account allowed to sync?
 *
 * A `select` against the allowlist. RLS restricts it to the caller's own row,
 * so this returns at most one row and leaks nothing about other users. An
 * error (offline, misconfigured) is reported as `false` with the message, so
 * the UI can distinguish "not enrolled" from "couldn't tell".
 */
export async function isSyncEnabled(
  supabase: SupabaseClient,
  userId: string,
): Promise<{ enabled: boolean; error?: string }> {
  const { data, error } = await supabase
    .from('cloud_sync_allowlist')
    .select('user_id')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) return { enabled: false, error: error.message };
  return { enabled: Boolean(data) };
}

class Aborted extends Error {
  constructor() {
    super('sync aborted');
    this.name = 'Aborted';
  }
}

function checkAbort(signal?: { aborted: boolean }): void {
  if (signal?.aborted) throw new Aborted();
}

export function isAbort(err: unknown): boolean {
  return err instanceof Aborted || (err as Error)?.name === 'Aborted';
}

/**
 * Run one full sync pass.
 *
 * Order matters: games before analyses, because an analysis is useless without
 * its game and `diffAnalyses` deliberately skips analyses for games this device
 * doesn't have yet. Pulling games first means a fresh device converges in one
 * pass instead of needing a second.
 */
export async function runCloudSync(opts: SyncOptions): Promise<SyncResult> {
  const { supabase, userId, onProgress, signal } = opts;
  const startedAt = Date.now();
  const counts = emptyCounts();
  let bytesPushed = 0;

  onProgress?.({ phase: 'manifest', done: 0, total: 0 });

  // ---- manifests (metadata only — no `data` blobs) ----------------------
  const [remoteGames, remoteAnalyses, remoteAttempts] = await Promise.all([
    fetchAll<RemoteGameMeta>(supabase, 'cloud_games', 'game_id, analysis_status', userId),
    fetchAll<RemoteAnalysisMeta>(
      supabase,
      'cloud_analyses',
      'game_id, depth, analyzed_at, engine',
      userId,
    ),
    // `data` (the whole PuzzleAttempt), not the metadata columns.
    //
    // Reconstructing an attempt from the metadata columns loses `firstSeenAt`
    // and `msTaken`, and that broke two things at once: a restored device got
    // `firstSeenAt` overwritten with `lastAttemptedAt`, and — because the
    // reconstructed row never equalled the merge — every sync re-pushed every
    // attempt forever, so the whole thing was not idempotent. Attempts are a
    // few hundred bytes each, so fetching the real row is the honest trade:
    // a 5 000-puzzle history is ~1 MB, once per sync, and always exact.
    fetchAll<{ data: PuzzleAttempt }>(
      supabase,
      'cloud_puzzle_attempts',
      'puzzle_id, data',
      userId,
    ),
  ]);
  checkAbort(signal);

  const localGames = await listAllGamesLight();
  const gamePlan = diffGames(localGames, remoteGames);

  // ---- games -------------------------------------------------------------
  const gameTotal = gamePlan.push.length + gamePlan.pull.length;
  let gameDone = 0;
  const tickGames = () =>
    onProgress?.({ phase: 'games', done: ++gameDone, total: gameTotal });

  for (const ids of chunk(gamePlan.push, BATCH_GAMES)) {
    checkAbort(signal);
    // Full rows here (PGN included) — the light projection omits it.
    const rows = (await db.games.bulkGet(ids)).filter((g): g is Game => Boolean(g));
    if (rows.length === 0) continue;
    const payload = rows.map((g) => toCloudGame(userId, g));
    const { error } = await supabase
      .from('cloud_games')
      .upsert(payload, { onConflict: 'user_id,game_id' });
    if (error) throw new Error(`push games: ${describe(error)}`);
    counts.gamesPushed += rows.length;
    for (const _ of rows) tickGames();
  }

  for (const ids of chunk(gamePlan.pull, BATCH_GAMES)) {
    checkAbort(signal);
    const { data, error } = await supabase
      .from('cloud_games')
      .select('data')
      .eq('user_id', userId)
      .in('game_id', ids);
    if (error) throw new Error(`pull games: ${describe(error)}`);
    const rows = (data ?? []).map((r) => (r as { data: Game }).data);
    if (rows.length > 0) await db.games.bulkPut(rows);
    counts.gamesPulled += rows.length;
    for (const _ of rows) tickGames();
  }

  // ---- analyses ----------------------------------------------------------
  //
  // The analysis plan is computed HERE, after the games phase, not alongside
  // the game plan. `diffAnalyses` skips any cloud analysis whose game is
  // missing locally (so an analysis can't land orphaned) — and on a fresh
  // device every game is missing until the phase above has run. Diffing up
  // front therefore skipped *every* analysis, and a restored device came back
  // with its games but none of the expensive Stockfish work. Caught by
  // `cloud-sync.mjs` asserting the restored analysis is byte-identical.
  //
  // Re-reading the light projection costs one IndexedDB scan and makes the
  // "converges in a single pass" claim actually true.
  const gamesAfterPull = await listAllGamesLight();
  const localAnalyses = await listAnalysesLight();
  const analysisPlan = diffAnalyses({
    local: localAnalyses,
    remote: remoteAnalyses,
    localGameStatus: new Map(gamesAfterPull.map((g) => [g.id, g.analysisStatus])),
    localGameIds: new Set(gamesAfterPull.map((g) => g.id)),
    localRequeuedAt: new Map(gamesAfterPull.map((g) => [g.id, g.requeuedAt])),
  });

  const analysisTotal = analysisPlan.push.length + analysisPlan.pull.length;
  let analysisDone = 0;
  const tickAnalyses = () =>
    onProgress?.({ phase: 'analyses', done: ++analysisDone, total: analysisTotal });

  for (const ids of chunk(analysisPlan.push, BATCH_ANALYSES)) {
    checkAbort(signal);
    const rows = (await db.analyses.bulkGet(ids)).filter((a): a is Analysis =>
      Boolean(a),
    );
    if (rows.length === 0) continue;
    const payload = rows.map((a) => toCloudAnalysis(userId, a));
    bytesPushed += payload.reduce((n, p) => n + JSON.stringify(p.data).length, 0);
    const { error } = await supabase
      .from('cloud_analyses')
      .upsert(payload, { onConflict: 'user_id,game_id' });
    if (error) throw new Error(`push analyses: ${describe(error)}`);
    counts.analysesPushed += rows.length;
    for (const _ of rows) tickAnalyses();
  }

  // Games whose local status still says they need analysing, so a pulled analysis
  // can settle them. Read once rather than per chunk.
  const statusBefore = new Map(gamesAfterPull.map((g) => [g.id, g.analysisStatus]));
  const colorById = new Map(gamesAfterPull.map((g) => [g.id, g.userColor]));

  for (const ids of chunk(analysisPlan.pull, BATCH_ANALYSES)) {
    checkAbort(signal);
    const { data, error } = await supabase
      .from('cloud_analyses')
      .select('data')
      .eq('user_id', userId)
      .in('game_id', ids);
    if (error) throw new Error(`pull analyses: ${describe(error)}`);
    const rows = (data ?? []).map((r) => (r as { data: Analysis }).data);
    if (rows.length > 0) await db.analyses.bulkPut(rows);

    // ---- settle the game rows the analyses just answered -----------------
    //
    // Writing the analysis alone is not enough, and the gap was invisible: the
    // game stays `pending`, so the local queue analyses it AGAIN — spending
    // hours reproducing work that just arrived, and clobbering a depth-18 NNUE
    // analysis with a shallower local one, which the next sync then has to pull
    // back. Two full round trips to converge on what we already had.
    //
    // `accuracy` and `brilliantCount` are recomputed here rather than read from
    // `cloud_games` because that row is only pulled when the game itself is a
    // pull candidate, which it usually is not — the local copy is fine. They are
    // derived from the analysis we just stored, by the same functions the queue
    // uses, so the dashboard tiles agree either way.
    const settle = rows.filter((a) => {
      const st = statusBefore.get(a.gameId);
      return st !== undefined && st !== 'done';
    });
    if (settle.length > 0) {
      await db.transaction('rw', db.games, async () => {
        for (const a of settle) {
          const color = colorById.get(a.gameId);
          await db.games.update(a.gameId, {
            analysisStatus: 'done',
            analysisError: undefined,
            accuracy: computeAccuracy(a.moves),
            ...(color ? { brilliantCount: countUserBrilliancies(a.moves, color) } : {}),
          });
          statusBefore.set(a.gameId, 'done');
        }
      });
      counts.gamesSettled += settle.length;
    }

    counts.analysesPulled += rows.length;
    for (const _ of rows) tickAnalyses();
  }

  // ---- puzzle attempts ---------------------------------------------------
  const localAttempts = await db.puzzleAttempts.toArray();
  const attemptPlan = diffAttempts(
    localAttempts,
    remoteAttempts.map((r) => r.data),
  );

  const attemptTotal = attemptPlan.push.length + attemptPlan.writeLocal.length;
  let attemptDone = 0;
  const tickAttempts = () =>
    onProgress?.({ phase: 'attempts', done: ++attemptDone, total: attemptTotal });

  if (attemptPlan.writeLocal.length > 0) {
    await db.puzzleAttempts.bulkPut(attemptPlan.writeLocal);
    counts.attemptsPulled += attemptPlan.writeLocal.length;
    for (const _ of attemptPlan.writeLocal) tickAttempts();
  }

  for (const rows of chunk(attemptPlan.push, BATCH_ATTEMPTS)) {
    checkAbort(signal);
    const payload = rows.map((p) => toCloudAttempt(userId, p));
    const { error } = await supabase
      .from('cloud_puzzle_attempts')
      .upsert(payload, { onConflict: 'user_id,puzzle_id' });
    if (error) throw new Error(`push attempts: ${describe(error)}`);
    counts.attemptsPushed += rows.length;
    for (const _ of rows) tickAttempts();
  }

  onProgress?.({ phase: 'done', done: 1, total: 1 });
  return { ...counts, bytesPushed, durationMs: Date.now() - startedAt };
}

/**
 * Page through a table. PostgREST caps a response at 1 000 rows by default, so
 * a library past that size would silently sync only its first thousand — the
 * kind of bug that looks like "some games didn't sync" and is miserable to
 * track down. Explicit ranges instead.
 */
const PAGE = 1000;

async function fetchAll<T>(
  supabase: SupabaseClient,
  table: string,
  columns: string,
  userId: string,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from(table)
      .select(columns)
      .eq('user_id', userId)
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`${table} manifest: ${describe(error)}`);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
}

/**
 * Turn a Supabase error into something actionable.
 *
 * The failure a user will actually hit is an RLS refusal, which arrives as a
 * bare "new row violates row-level security policy" with no hint about why.
 * Naming the likely cause here saves a long debugging detour.
 */
function describe(error: { message: string; code?: string }): string {
  const rls =
    /row-level security/i.test(error.message) || error.code === '42501';
  if (rls) {
    return (
      `${error.message} — this account is not in cloud_sync_allowlist. ` +
      `Run supabase/cloud-sync.sql (step 5) to enrol it.`
    );
  }
  if (error.code === '42P01') {
    return `${error.message} — the cloud tables don't exist yet. Run supabase/cloud-sync.sql.`;
  }
  return error.message;
}
