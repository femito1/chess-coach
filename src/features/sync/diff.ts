import type { Analysis, AnalysisStatus, Game, PuzzleAttempt } from '@/db/schema';

/**
 * Pure reconciliation logic for cloud sync.
 *
 * No I/O, no Supabase, no Dexie — `cloudSync.ts` is the imperative shell that
 * executes what these functions decide. Same split as
 * `profileBind.ts` / `useProfileSync.ts`, for the same reason: the policy is
 * where the subtle decisions live, so it should be exhaustively testable
 * without a network or a database.
 *
 * ── Why a manifest diff, not dirty flags ─────────────────────────────────
 *
 * The obvious design is a `dirty` flag per row, set on every write. That would
 * mean touching every call site that mutates a game or an analysis, and any
 * missed one silently stops syncing — a failure mode you discover months later
 * when a device is missing data.
 *
 * Instead each side reports a cheap *manifest* (ids plus a few decision
 * fields, no payloads) and we diff them. That is stateless, idempotent,
 * resumable after a failure mid-run, and self-healing: whatever state the two
 * sides are in, the next sync converges them. It costs one metadata round trip
 * per table, which for a 1 000-game library is tens of kilobytes.
 */

/* =======================================================================
 *  Remote manifest shapes (what `select` returns without the `data` blob)
 * =======================================================================
 */

export interface RemoteGameMeta {
  game_id: string;
  analysis_status: string;
}

export interface RemoteAnalysisMeta {
  game_id: string;
  depth: number;
  analyzed_at: number;
  /** `Analysis.engine`, e.g. `stockfish-16-nnue`. Older rows predate the field
   *  and arrive null/undefined; those are treated as classical, which is what
   *  they were. */
  engine?: string | null;
}

export interface RemoteAttemptMeta {
  puzzle_id: string;
  attempts: number;
  solved_clean: boolean;
  hint_used: boolean;
  last_attempted_at: number;
  rating: number;
}

/** Local game fields the diff reads. Satisfied by `GameLight` (no PGN), so
 *  building a manifest never hauls megabytes of PGN out of IndexedDB. */
export interface LocalGameMeta {
  id: string;
  analysisStatus: AnalysisStatus;
}

/** Local analysis fields the diff reads. Satisfied by `AnalysisLight`. */
export interface LocalAnalysisMeta {
  gameId: string;
  depth: number;
  analyzedAt: number;
  engine?: string;
}

export interface Plan {
  /** Ids to upload (local → cloud). */
  push: string[];
  /** Ids to download (cloud → local). */
  pull: string[];
}

const emptyPlan = (): Plan => ({ push: [], pull: [] });

/* =======================================================================
 *  Games
 * =======================================================================
 */

/**
 * Games are append-mostly and effectively immutable once imported: the PGN,
 * result and ratings never change. The mutable parts (`accuracy`,
 * `brilliantCount`, `userTimeSec`) are all *derived from the analysis* and are
 * recomputed locally by the boot passes, so they are not worth a conflict
 * rule — whichever side has them, the other will regenerate them.
 *
 * That leaves one asymmetry that does matter: whether the row has a finished
 * analysis. A game row that says `done` carries the cached accuracy and
 * brilliancy counts the Games table renders; one that says `pending` does not.
 * So when both sides have the game, the finished side generally wins.
 *
 * ── Except when the local side is deliberately mid-analysis ──────────────
 *
 * `pending` / `running` locally is not "worse information", it is a *user
 * intent*: `requeueGame` sets exactly that state to force a re-analysis. If we
 * pulled the cloud's `done` row over it, the game would flip back to `done`,
 * which then makes the local game look finished to `diffAnalyses` and lets the
 * old cloud analysis come back too — silently undoing the requeue via a path
 * that has nothing to do with analyses. (Found exactly this way: the analysis
 * requeue guard was correct and still unreachable, because the games phase had
 * already rewritten the status it keys off.)
 *
 * `error` is different and does pull: that is a failure, not an intent, and the
 * cloud may hold a good copy from a device where analysis succeeded.
 */
export function diffGames(
  local: readonly LocalGameMeta[],
  remote: readonly RemoteGameMeta[],
): Plan {
  const plan = emptyPlan();
  const remoteById = new Map(remote.map((r) => [r.game_id, r]));
  const localById = new Map(local.map((g) => [g.id, g]));

  for (const g of local) {
    const r = remoteById.get(g.id);
    if (!r) {
      plan.push.push(g.id);
      continue;
    }
    const localDone = g.analysisStatus === 'done';
    const remoteDone = r.analysis_status === 'done';
    const localInProgress =
      g.analysisStatus === 'pending' || g.analysisStatus === 'running';

    if (localDone && !remoteDone) plan.push.push(g.id);
    else if (remoteDone && !localDone && !localInProgress) plan.pull.push(g.id);
    // Both done, neither done, or a deliberate local requeue: leave it.
  }

  for (const r of remote) {
    if (!localById.has(r.game_id)) plan.pull.push(r.game_id);
  }

  return plan;
}

/* =======================================================================
 *  Analyses
 * =======================================================================
 */

/**
 * Analyses are the expensive artifact — the whole point of syncing — so the
 * rule is "keep the best one".
 *
 * Best means NNUE over classical first, then deeper, then more recent. See
 * `isBetter` for why the evaluator outranks depth. Depth beats recency because a
 * depth-20 analysis is more informative than a depth-16 one regardless of when
 * each was produced, and because `engineDepth` is user-configurable; if recency
 * led, a shallow re-analysis on a phone would clobber a deep one from a
 * desktop.
 *
 * ── The requeue guard ────────────────────────────────────────────────────
 *
 * `requeueGame` deliberately DELETES the local analysis and sets the game back
 * to `pending` so the engine redoes it. To a naive diff that looks exactly
 * like "the cloud has an analysis this device is missing", and the next sync
 * would download the very row the user just threw away — silently undoing the
 * requeue, every time.
 *
 * So a pull is suppressed while the local game is `pending` or `running`. Once
 * the re-analysis finishes, the local row exists again and the normal
 * depth/recency comparison takes over and pushes it up.
 */
export function diffAnalyses(args: {
  local: readonly LocalAnalysisMeta[];
  remote: readonly RemoteAnalysisMeta[];
  /** Local analysis status per game id, for the requeue guard. */
  localGameStatus: ReadonlyMap<string, AnalysisStatus>;
  /** Game ids present locally. A cloud analysis for a game this device has
   *  never imported is skipped — the game itself pulls first, and the next
   *  sync picks up its analysis. Keeps an analysis from arriving orphaned. */
  localGameIds: ReadonlySet<string>;
}): Plan {
  const { local, remote, localGameStatus, localGameIds } = args;
  const plan = emptyPlan();
  const remoteById = new Map(remote.map((r) => [r.game_id, r]));
  const localById = new Map(local.map((a) => [a.gameId, a]));

  for (const a of local) {
    const r = remoteById.get(a.gameId);
    if (!r) {
      plan.push.push(a.gameId);
      continue;
    }
    if (isBetter(a, r)) plan.push.push(a.gameId);
    else if (isBetter(r, a)) plan.pull.push(a.gameId);
  }

  for (const r of remote) {
    if (localById.has(r.game_id)) continue;
    if (!localGameIds.has(r.game_id)) continue;
    const status = localGameStatus.get(r.game_id);
    if (status === 'pending' || status === 'running') continue; // requeue guard
    plan.pull.push(r.game_id);
  }

  return plan;
}

interface Ranked {
  depth: number;
  at: number;
  nnue: boolean;
}

/**
 * Does this analysis come from the NNUE evaluator?
 *
 * Absent or unrecognised means classical. That is the honest default: every
 * analysis produced before the evaluator was recorded came from the bundled
 * WASM build, which runs `Use NNUE` off.
 */
export function isNnueAnalysis(engine: string | null | undefined): boolean {
  return typeof engine === 'string' && engine.includes('nnue');
}

function rank(x: LocalAnalysisMeta | RemoteAnalysisMeta): Ranked {
  return 'gameId' in x
    ? { depth: x.depth, at: x.analyzedAt, nnue: isNnueAnalysis(x.engine) }
    : { depth: x.depth, at: x.analyzed_at, nnue: isNnueAnalysis(x.engine) };
}

/**
 * Strictly better: NNUE beats classical, then deeper, then newer.
 *
 * Evaluator leads depth, and that ordering is deliberate. A classical analysis
 * at depth 20 is not better than an NNUE one at depth 18 — it is a weaker judge
 * searching further, and it is wrong about exactly the positions that matter
 * for coaching. Measured on a rook endgame: classical +0.53 ("equal") versus
 * NNUE +3.77 ("winning"). Ranking depth first would let a laptop's classical
 * re-analysis silently overwrite a server's NNUE work.
 */
function isBetter(
  a: LocalAnalysisMeta | RemoteAnalysisMeta,
  b: LocalAnalysisMeta | RemoteAnalysisMeta,
): boolean {
  const x = rank(a);
  const y = rank(b);
  if (x.nnue !== y.nnue) return x.nnue;
  if (x.depth !== y.depth) return x.depth > y.depth;
  return x.at > y.at;
}

/* =======================================================================
 *  Puzzle attempts
 * =======================================================================
 */

/**
 * Attempts are the one table where last-write-wins would actually lose data.
 *
 * Games and analyses are single-producer per row — one device analyses a game
 * and that's the truth. Attempts are genuinely concurrent: you can solve
 * puzzle A on your phone and puzzle B on your laptop in the same hour, and if
 * a whole-table timestamp decided the winner, one device's session would
 * vanish. Even for the SAME puzzle, "solved cleanly on the laptop, fumbled on
 * the phone" should not erase the clean solve.
 *
 * So attempts merge field-by-field, and the merge is commutative and
 * idempotent — both sides compute the same result from the same inputs, which
 * is what lets each push its merged row without a coordination round:
 *
 *   attempts        max      — a count of events that happened on both devices
 *   solvedClean     OR       — sticky-once-true, matching `recordAttempt`
 *   hintUsed        OR       — a disclosure can't be un-seen (same reason)
 *   firstSeenAt     min      — earliest sighting anywhere
 *   lastAttemptedAt max      — latest activity anywhere
 *   msTaken, rating          — taken from whichever row is more recent
 *
 * `max` for `attempts` rather than a sum: a sum would double-count the attempt
 * that produced both rows, and would keep inflating on every sync (not
 * idempotent). Max under-counts when two devices each attempt independently,
 * which is the safer error for a number only used to display history.
 */
export function mergeAttempt(
  local: PuzzleAttempt,
  remote: PuzzleAttempt,
): PuzzleAttempt {
  const newer = remote.lastAttemptedAt > local.lastAttemptedAt ? remote : local;
  const merged: PuzzleAttempt = {
    puzzleId: local.puzzleId,
    firstSeenAt: Math.min(local.firstSeenAt, remote.firstSeenAt),
    lastAttemptedAt: Math.max(local.lastAttemptedAt, remote.lastAttemptedAt),
    attempts: Math.max(local.attempts, remote.attempts),
    solvedClean: local.solvedClean || remote.solvedClean,
    hintUsed: local.hintUsed || remote.hintUsed,
    rating: newer.rating,
  };
  const ms = newer.msTaken ?? local.msTaken ?? remote.msTaken;
  if (ms !== undefined) merged.msTaken = ms;
  return merged;
}

/** True when a merge would change `row` — i.e. that side needs writing. */
export function attemptDiffers(row: PuzzleAttempt, merged: PuzzleAttempt): boolean {
  return (
    row.attempts !== merged.attempts ||
    row.solvedClean !== merged.solvedClean ||
    row.hintUsed !== merged.hintUsed ||
    row.firstSeenAt !== merged.firstSeenAt ||
    row.lastAttemptedAt !== merged.lastAttemptedAt ||
    row.rating !== merged.rating ||
    row.msTaken !== merged.msTaken
  );
}

export interface AttemptPlan {
  /** Merged rows to write locally. */
  writeLocal: PuzzleAttempt[];
  /** Merged rows to upload. */
  push: PuzzleAttempt[];
}

/**
 * Reconcile attempts. Unlike games/analyses this returns whole rows rather
 * than ids, because the merged value is computed here and both sides may need
 * a *different* row than either started with.
 */
export function diffAttempts(
  local: readonly PuzzleAttempt[],
  remote: readonly PuzzleAttempt[],
): AttemptPlan {
  const out: AttemptPlan = { writeLocal: [], push: [] };
  const localById = new Map(local.map((a) => [a.puzzleId, a]));
  const remoteById = new Map(remote.map((a) => [a.puzzleId, a]));

  for (const l of local) {
    const r = remoteById.get(l.puzzleId);
    if (!r) {
      out.push.push(l);
      continue;
    }
    const merged = mergeAttempt(l, r);
    if (attemptDiffers(l, merged)) out.writeLocal.push(merged);
    if (attemptDiffers(r, merged)) out.push.push(merged);
  }

  for (const r of remote) {
    if (!localById.has(r.puzzleId)) out.writeLocal.push(r);
  }

  return out;
}

/* =======================================================================
 *  Row (de)serialization
 * =======================================================================
 */

export interface CloudGameRow {
  user_id: string;
  game_id: string;
  analysis_status: string;
  end_time: number;
  data: Game;
}

export interface CloudAnalysisRow {
  user_id: string;
  game_id: string;
  depth: number;
  analyzed_at: number;
  move_count: number;
  data: Analysis;
}

export interface CloudAttemptRow {
  user_id: string;
  puzzle_id: string;
  attempts: number;
  solved_clean: boolean;
  hint_used: boolean;
  last_attempted_at: number;
  rating: number;
  data: PuzzleAttempt;
}

export function toCloudGame(userId: string, g: Game): CloudGameRow {
  return {
    user_id: userId,
    game_id: g.id,
    analysis_status: g.analysisStatus,
    end_time: g.endTime,
    data: g,
  };
}

export function toCloudAnalysis(userId: string, a: Analysis): CloudAnalysisRow {
  return {
    user_id: userId,
    game_id: a.gameId,
    depth: a.depth,
    analyzed_at: a.analyzedAt,
    move_count: a.moves.length,
    data: a,
  };
}

export function toCloudAttempt(userId: string, p: PuzzleAttempt): CloudAttemptRow {
  return {
    user_id: userId,
    puzzle_id: p.puzzleId,
    attempts: p.attempts,
    solved_clean: p.solvedClean,
    hint_used: p.hintUsed,
    last_attempted_at: p.lastAttemptedAt,
    rating: p.rating,
    data: p,
  };
}

/**
 * Batch sizes, tuned to payload rather than row count.
 *
 * Analyses dominate: ~30 KB each, so 20 per request is ~600 KB — comfortably
 * inside PostgREST limits while still amortising the round trip. Games carry a
 * ~2 KB PGN, attempts a few hundred bytes, so both can go much larger.
 */
export const BATCH_GAMES = 150;
export const BATCH_ANALYSES = 20;
export const BATCH_ATTEMPTS = 500;

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
