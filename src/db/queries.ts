import { db, getSettings, updateSettings, type Game, type Analysis, type AnalysisStatus, type Motif } from './schema';
import { computeAccuracy, countUserBrilliancies } from '@/engine/analyzer';
import { classifyMove } from '@/engine/classify';
import { detectMotifs } from '@/engine/motifs';
import {
  baseSecondsFromTimeControl,
  deriveTimeSpent,
  detectPhase,
  extractClocks,
} from '@/engine/phase';

/**
 * Bump these any time the corresponding boot-time pass would produce
 * different output for existing rows. The pass stores the last version
 * it ran in `Settings.lastRecomputeVersion` /
 * `Settings.lastOpeningRefreshVersion`; on boot, if the stored version
 * matches the current one, we skip the pass entirely. That's the
 * single biggest startup-time win for libraries with hundreds-to-
 * thousands of analyzed games — a full classification recompute over
 * 1 k games can lock the main thread for many seconds.
 *
 * Bump rules:
 *   RECOMPUTE_VERSION   — bump when classifyMove / detectMotifs /
 *                         computeAccuracy / detectPhase / clock-derivation
 *                         logic changes its output for existing data.
 *
 *                         Do NOT bump this merely to stamp a new derived
 *                         field onto existing games. This pass re-runs
 *                         `classifyMove` + `detectMotifs` + `detectPhase`
 *                         over every move of every analyzed game, which
 *                         parses FENs through chess.js and is measured in
 *                         seconds-to-minutes on a large library. A field
 *                         that can be computed from data already stored in
 *                         `analyses` deserves its own cheap pass with its
 *                         own version stamp — see
 *                         `BRILLIANT_BACKFILL_VERSION`.
 *   OPENING_REFRESH_VERSION
 *                       — bump when reparseOpeningFromPgn changes its
 *                         output for existing PGNs (e.g. updated openings
 *                         dataset).
 */
export const RECOMPUTE_VERSION = 2;
export const OPENING_REFRESH_VERSION = 1;
/** Version stamp for the boot-time `backfillUserTimeStats` pass. Bump
 *  this any time `computeUserTimeStats` would produce different output
 *  for an existing PGN — e.g. a fix to how `%clk` increments are
 *  handled, or a change to the no-clock fallback heuristic. */
export const USER_TIME_BACKFILL_VERSION = 1;
/** Version stamp for the boot-time `backfillBrilliantCounts` pass. Cheap
 *  by construction — it only re-reads stored classifications — so bumping
 *  this is safe in a way that bumping `RECOMPUTE_VERSION` is not. Bump
 *  when `countUserBrilliancies` or the `brilliant` classification rule
 *  changes its output for existing analyses. */
export const BRILLIANT_BACKFILL_VERSION = 1;

/** Order-sensitive equality on two motif arrays. Cheap shortcut used
 *  by `recomputeClassificationsAndAccuracies` instead of a per-move
 *  `JSON.stringify` comparison (which on a 5,000-game library
 *  serialises millions of tiny arrays). */
function sameMotifs(a: Motif[] | undefined, b: Motif[] | undefined): boolean {
  const al = a?.length ?? 0;
  const bl = b?.length ?? 0;
  if (al !== bl) return false;
  if (al === 0) return true;
  for (let i = 0; i < al; i++) {
    if (a![i] !== b![i]) return false;
  }
  return true;
}

export async function upsertGame(game: Game): Promise<void> {
  const existing = await db.games.get(game.id);
  if (existing) {
    await db.games.update(game.id, {
      ...game,
      analysisStatus: existing.analysisStatus,
      analysisError: existing.analysisError,
    });
  } else {
    await db.games.put(game);
  }
}

export async function upsertGames(games: Game[]): Promise<{ added: number; skipped: number }> {
  let added = 0;
  let skipped = 0;
  await db.transaction('rw', db.games, async () => {
    for (const g of games) {
      const existing = await db.games.get(g.id);
      if (existing) {
        skipped++;
      } else {
        await db.games.put(g);
        added++;
      }
    }
  });
  return { added, skipped };
}

export async function listGames(): Promise<Game[]> {
  return db.games.orderBy('endTime').reverse().toArray();
}

/**
 * Game projection that omits the `pgn` field. Use this anywhere the
 * UI needs game metadata (id, opponent, rating, opening, accuracy,
 * timing) but doesn't need the move list itself.
 *
 * Why this exists: a typical PGN is ~2 KB; on a 1 k-game library that's
 * ~2 MB of *string* hauled out of IndexedDB into JS heap on every
 * `useLiveQuery` refire. The dashboard alone fires that read every 1.5 s
 * while the analyzer is running (a hot Dexie write firehose). Skipping
 * PGN cuts the per-refire allocation by ~95 % and is the single biggest
 * fix for the "page hangs for 20 s when reload-while-analyzing" symptom.
 *
 * The shape is `Omit<Game, 'pgn'>` so TypeScript catches any consumer
 * that tries to read `pgn` off a light row at compile time. Pages that
 * actually need PGN (review, repertoire-gap analysis) keep using
 * `getGame` / `listGames` / `db.games.toArray()`.
 */
export type GameLight = Omit<Game, 'pgn'>;

export async function listGamesLight(): Promise<GameLight[]> {
  // Dexie has no native "select-without-field" projection; the cheapest
  // way to drop one large field is to read the rows and strip it before
  // returning. The string is freed by the next GC.
  const rows = await db.games.orderBy('endTime').reverse().toArray();
  return rows.map(stripPgn);
}

/** Same projection but returns rows in arbitrary order — matches
 *  `db.games.toArray()`. Used by pages that don't care about ordering
 *  (Weaknesses, Settings) so the projection stays a one-liner there. */
export async function listAllGamesLight(): Promise<GameLight[]> {
  const rows = await db.games.toArray();
  return rows.map(stripPgn);
}

function stripPgn(g: Game): GameLight {
  // Object spread + delete is faster than `const { pgn, ...rest } = g`
  // on large arrays per V8's hidden-class semantics, but the difference
  // is negligible for the row counts we deal with here. Readability wins.
  const { pgn: _pgn, ...light } = g;
  void _pgn;
  return light;
}

export async function getGame(id: string): Promise<Game | undefined> {
  return db.games.get(id);
}

export async function getAnalysis(gameId: string): Promise<Analysis | undefined> {
  return db.analyses.get(gameId);
}

export async function saveAnalysis(analysis: Analysis): Promise<void> {
  await db.analyses.put(analysis);
}

/**
 * Analysis projection that omits the `moves` array. Use this anywhere
 * the UI needs to know "is this game analyzed", "at what depth", or
 * "how many moves did it have" but doesn't actually need to render or
 * walk every `MoveEval`.
 *
 * Why this exists: a typical game has 40–100 `MoveEval` rows, each
 * carrying multiple FENs (~100 chars), a UCI PV array, a `motifs`
 * array, and a dozen number fields. Stringified that's ~30 KB per
 * analysis on average; on a 1 k-game library a `db.analyses.toArray()`
 * pulls ~30 MB of object graph into JS heap on every refire. Most
 * call sites that hit `analyses` only want metadata and would much
 * rather pay ~200 bytes per row.
 *
 * The shape is `Omit<Analysis, 'moves'> & { moveCount }`. We add
 * `moveCount` because (a) it's the most-asked-for derived value off
 * the move list, (b) cheaply derivable on read (no schema bump
 * needed), and (c) lets the type system catch any consumer that
 * tries to read `.moves.length` off a light row at compile time.
 *
 * Pages that actually need the full move list (review, weaknesses,
 * puzzle generation, classification recompute) keep using
 * `getAnalysis` / `db.analyses.bulkGet`.
 *
 * NOTE: like `GameLight`, the projection is *post-fetch* — Dexie has
 * no native "select-without-field". That's still a meaningful win
 * because the heavy cost is the JS-heap allocation that survives the
 * function (the row's lifetime in memory), not the IDB read itself.
 * The dropped `moves` array is freed on the next GC.
 */
export type AnalysisLight = Omit<Analysis, 'moves'> & { moveCount: number };

function stripMoves(a: Analysis): AnalysisLight {
  const { moves, ...rest } = a;
  return { ...rest, moveCount: moves.length };
}

export async function getAnalysisLight(
  gameId: string,
): Promise<AnalysisLight | undefined> {
  const row = await db.analyses.get(gameId);
  return row ? stripMoves(row) : undefined;
}

export async function bulkGetAnalysisLight(
  gameIds: string[],
): Promise<AnalysisLight[]> {
  if (gameIds.length === 0) return [];
  const rows = await db.analyses.bulkGet(gameIds);
  const out: AnalysisLight[] = [];
  for (const a of rows) if (a) out.push(stripMoves(a));
  return out;
}

export async function listAnalysesLight(): Promise<AnalysisLight[]> {
  const rows = await db.analyses.toArray();
  return rows.map(stripMoves);
}

/** Exported for unit-testing the shape contract. Not for production
 *  use — call `getAnalysisLight` / `bulkGetAnalysisLight` /
 *  `listAnalysesLight` instead so the IDB read stays in one place. */
export const __stripMovesForTests = stripMoves;

export async function setAnalysisStatus(
  gameId: string,
  status: AnalysisStatus,
  error?: string,
): Promise<void> {
  await db.games.update(gameId, { analysisStatus: status, analysisError: error });
}

export async function nextPendingGame(): Promise<Game | undefined> {
  // Newest games first. Users care about analyses for the games they
  // *just* played far more than ancient archive backfill, so when the
  // queue is processing a fresh import we want the most recent endTime
  // to come off the queue first. We walk the `endTime` index in reverse
  // (descending) using a Dexie cursor and stop on the first row with
  // `analysisStatus === 'pending'` — short-circuits after a single row
  // in steady state and never materialises the whole pending set in JS.
  let found: Game | undefined;
  await db.games
    .orderBy('endTime')
    .reverse()
    .filter((g) => g.analysisStatus === 'pending')
    .limit(1)
    .each((g) => {
      found = g;
    });
  return found;
}

export async function countByStatus(): Promise<Record<AnalysisStatus, number>> {
  // `analysisStatus` is indexed (schema.ts) so per-status counts go
  // through Dexie's `count()` rather than pulling every Game (with its
  // multi-KB PGN string) into JS memory just to bump four counters.
  // On a 5,000-game library this drops peak RAM for the dashboard from
  // tens of MB down to ~kB.
  const [pending, running, done, errored] = await Promise.all([
    db.games.where('analysisStatus').equals('pending').count(),
    db.games.where('analysisStatus').equals('running').count(),
    db.games.where('analysisStatus').equals('done').count(),
    db.games.where('analysisStatus').equals('error').count(),
  ]);
  return { pending, running, done, error: errored };
}

export async function resetRunningToPending(): Promise<void> {
  const running = await db.games.where('analysisStatus').equals('running').toArray();
  await db.transaction('rw', db.games, async () => {
    for (const g of running) {
      await db.games.update(g.id, { analysisStatus: 'pending' });
    }
  });
}

/**
 * Errors produced by older code paths (before the engine was fixed) leave games
 * stuck at `error` with messages like "worker error" or "Stockfish factory not found".
 * Reset those on every boot so the user doesn't have to manually retry.
 */
const STALE_ERROR_PATTERNS = [
  /stockfish factory not found/i,
  /^worker error$/i,
  /failed to load/i,
  /Stockfish worker failed to start/i,
];

export async function requeueStaleErrors(): Promise<number> {
  const errored = await db.games.where('analysisStatus').equals('error').toArray();
  let requeued = 0;
  await db.transaction('rw', db.games, db.analyses, async () => {
    for (const g of errored) {
      if (g.analysisError && STALE_ERROR_PATTERNS.some((p) => p.test(g.analysisError!))) {
        await db.games.update(g.id, {
          analysisStatus: 'pending',
          analysisError: undefined,
        });
        await db.analyses.delete(g.id);
        requeued++;
      }
    }
  });
  return requeued;
}

/**
 * Re-run `classifyMove` on every stored analysis using the current
 * bucketing rules, and refresh the cached `accuracy` on each game. Does
 * NOT re-run Stockfish — it's just a re-interpretation of data we already
 * have.
 *
 * Returns the number of games whose classifications or accuracy changed.
 *
 * Performance notes:
 *  - We process in CHUNKS via `bulkGet`. Doing one transaction per game
 *    on a 5k-library means ~10k separate IDB roundtrips at app boot,
 *    which thrashes the main thread and (because every `update` fires
 *    `useLiveQuery` re-renders) makes the whole UI feel sluggish until
 *    the pass finishes.
 *  - We `bulkPut` writes too, in the same chunked rhythm.
 *  - A short `setTimeout(0)` yield between chunks keeps the UI thread
 *    responsive — the recompute is best-effort housekeeping, not a
 *    user-facing operation, so we'd rather it take 30s without blocking
 *    than 5s while freezing the page.
 */
/** Smaller chunks = shorter main-thread freezes between yields. 60
 *  games ≈ a few hundred per-move classify+motif calls per chunk, which
 *  on mid-tier hardware is comfortably under a 16 ms frame budget. */
const RECOMPUTE_CHUNK = 60;

/** Yield to the browser. Prefers `requestIdleCallback` so the work only
 *  runs when the UI thread has slack (post-paint, post-input). Falls
 *  back to a 0-ms `setTimeout` in environments that lack rIC (older
 *  Safari, Node-side test runs). */
function yieldToBrowser(): Promise<void> {
  return new Promise<void>((resolve) => {
    const ric = (
      globalThis as unknown as {
        requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
      }
    ).requestIdleCallback;
    if (typeof ric === 'function') {
      ric(() => resolve(), { timeout: 200 });
    } else {
      setTimeout(resolve, 0);
    }
  });
}

export async function recomputeClassificationsAndAccuracies(opts?: {
  force?: boolean;
}): Promise<number> {
  // Skip-version fast path: by far the most common case is "we already
  // ran this recompute version against this DB". On a 1 k-game library
  // that fast path returns in single-digit milliseconds instead of the
  // multi-second pass that used to fire on every boot.
  //
  // `>=`, not `===`, so a *rolled-back* version can't re-trigger the
  // expensive pass. The v3 build (2026-08-07) bumped this to stamp a
  // cheap counting field and was reverted to v2; with an equality check,
  // every DB that briefly saw v3 would run the full re-classification
  // one final time on the next load — re-freezing exactly the users the
  // rollback is meant to rescue. A DB carrying a newer stamp has by
  // definition already been through at least as new a rule set.
  if (!opts?.force) {
    const settings = await getSettings();
    const stamped = settings.lastRecomputeVersion;
    if (stamped != null && stamped >= RECOMPUTE_VERSION) return 0;
  }

  const doneIds = (await db.games
    .where('analysisStatus')
    .equals('done')
    .primaryKeys()) as string[];
  let updated = 0;

  for (let start = 0; start < doneIds.length; start += RECOMPUTE_CHUNK) {
    const chunkIds = doneIds.slice(start, start + RECOMPUTE_CHUNK);
    const games = await db.games.bulkGet(chunkIds);
    const analyses = await db.analyses.bulkGet(chunkIds);

    const analysisPatches: Analysis[] = [];
    const gamePatches: Array<{
      id: string;
      accuracy: { white: number; black: number };
      brilliantCount: number;
    }> = [];

    for (let i = 0; i < chunkIds.length; i++) {
      const g = games[i];
      const a = analyses[i];
      if (!g || !a || a.moves.length === 0) continue;

      const hasOpening = Boolean(g.eco || g.opening);
      const clocks = extractClocks(g.pgn);
      const base = baseSecondsFromTimeControl(g.timeControl);
      const timeSpent = deriveTimeSpent(clocks, base);

      let changed = false;
      const newMoves = a.moves.map((m, idx) => {
        const isBest = Boolean(m.bestMoveUci && m.uci && m.bestMoveUci === m.uci);
        const prevUci = idx > 0 ? a.moves[idx - 1].uci : undefined;
        const prevMoveToSquare = prevUci ? prevUci.slice(2, 4) : undefined;
        const cls = classifyMove({
          moverWinrateBefore: m.winrateBefore,
          moverWinrateAfter: m.winrateAfter,
          isBest,
          ply: m.ply,
          inBookPhase: hasOpening,
          fenBefore: m.fenBefore,
          fenAfter: m.fenAfter,
          playedUci: m.uci ?? '',
          prevMoveToSquare,
        });

        const phase = m.phase ?? detectPhase(m.fenBefore);
        const clockAfter = m.clockAfter ?? clocks[idx];
        const timeSpentVal = m.timeSpent ?? timeSpent[idx];

        // Motifs: (re)compute for non-best moves. Older analyses may not
        // have PV stored, in which case we fall back to just the best-move
        // for the "missed" branch checks; still catches hanging/fork/etc
        // on the played move.
        let motifs = m.motifs;
        const shouldTag =
          cls === 'blunder' || cls === 'mistake' || cls === 'miss' || cls === 'inaccuracy';
        if (shouldTag) {
          motifs = detectMotifs({
            fenBefore: m.fenBefore,
            fenAfter: m.fenAfter,
            playedUci: m.uci ?? '',
            bestUci: m.bestMoveUci,
            bestPvUci: m.bestPvUci,
            winrateBefore: m.winrateBefore,
            winrateAfter: m.winrateAfter,
            mateInBefore: m.mateInBefore,
            mateInAfter: m.mateInAfter,
          });
        } else {
          motifs = undefined;
        }

        const next = {
          ...m,
          classification: cls,
          phase,
          clockAfter,
          timeSpent: timeSpentVal,
          motifs,
        };
        if (
          cls !== m.classification ||
          phase !== m.phase ||
          clockAfter !== m.clockAfter ||
          timeSpentVal !== m.timeSpent ||
          !sameMotifs(motifs, m.motifs)
        ) {
          changed = true;
        }
        return next;
      });

      const accuracy = computeAccuracy(newMoves);
      const prev = g.accuracy;
      const accuracyChanged =
        !prev || prev.white !== accuracy.white || prev.black !== accuracy.black;

      // `brilliantCount` is refreshed here too, but only as a rider on a
      // pass that was already going to run — it must never be the
      // *reason* this pass runs (see the RECOMPUTE_VERSION bump rules).
      // Since we just re-derived every classification, the freshly
      // computed count is the authoritative one.
      const brilliantCount = countUserBrilliancies(newMoves, g.userColor);
      const brilliantChanged = g.brilliantCount !== brilliantCount;

      if (changed || accuracyChanged || brilliantChanged) {
        analysisPatches.push({ ...a, moves: newMoves });
        gamePatches.push({ id: g.id, accuracy, brilliantCount });
        updated++;
      }
    }

    if (analysisPatches.length > 0) {
      // One transaction per chunk, two bulk writes inside it. This is
      // ~RECOMPUTE_CHUNK× fewer transactions than the per-game version
      // and — crucially — fires `useLiveQuery` re-renders once per chunk
      // instead of once per game, so the UI doesn't thrash while boot
      // housekeeping runs.
      await db.transaction('rw', db.analyses, db.games, async () => {
        await db.analyses.bulkPut(analysisPatches);
        // Dexie has no `bulkUpdate`; the equivalent is a `bulkPut` of
        // the merged rows. We have the original `games[i]` rows in
        // memory so this is a single round trip rather than N updates.
        const gamesById = new Map<string, Game>();
        for (const gg of games) if (gg) gamesById.set(gg.id, gg);
        const merged: Game[] = gamePatches.map((p) => ({
          ...gamesById.get(p.id)!,
          accuracy: p.accuracy,
          brilliantCount: p.brilliantCount,
        }));
        await db.games.bulkPut(merged);
      });
    }

    // Yield to the browser so the UI thread doesn't freeze for the
    // full duration of the recompute on large libraries.
    await yieldToBrowser();
  }

  // Mark this DB as having run the current recompute version, so the
  // next boot (and the one after that, until rules change) skips the
  // whole pass. We deliberately only stamp the version when there were
  // games to consider — otherwise an empty-DB boot followed by an
  // import would silently skip the pass forever (the pass is checked
  // by version, not by row count).
  if (doneIds.length > 0) {
    await updateSettings({ lastRecomputeVersion: RECOMPUTE_VERSION });
  }

  return updated;
}

/**
 * Backwards-compat alias. Older code and tests may import this name.
 */
export const recomputeAllAccuracies = recomputeClassificationsAndAccuracies;

/**
 * Re-extract opening/eco from each game's stored PGN, then save. Useful after
 * a bug fix in the importer. Requires no Stockfish.
 *
 * Same chunked / bulk-write strategy as `recomputeClassificationsAndAccuracies`
 * to avoid thousands of independent IDB transactions thrashing the main
 * thread at boot. See the comments there for the rationale.
 */
export async function refreshOpeningMetadata(opts?: {
  force?: boolean;
}): Promise<number> {
  if (!opts?.force) {
    const settings = await getSettings();
    // `>=` for the same rollback-safety reason as
    // `recomputeClassificationsAndAccuracies`.
    const stamped = settings.lastOpeningRefreshVersion;
    if (stamped != null && stamped >= OPENING_REFRESH_VERSION) return 0;
  }

  const ids = (await db.games.toCollection().primaryKeys()) as string[];
  let updated = 0;
  const { reparseOpeningFromPgn } = await import('@/import/importer');

  for (let start = 0; start < ids.length; start += RECOMPUTE_CHUNK) {
    const chunkIds = ids.slice(start, start + RECOMPUTE_CHUNK);
    const games = await db.games.bulkGet(chunkIds);

    const merged: Game[] = [];
    for (const g of games) {
      if (!g) continue;
      const patch = reparseOpeningFromPgn(g.pgn);
      if (!patch) continue;
      if (patch.opening === g.opening && patch.eco === g.eco) continue;
      merged.push({ ...g, ...patch });
      updated++;
    }

    if (merged.length > 0) {
      await db.games.bulkPut(merged);
    }

    await yieldToBrowser();
  }

  // Same reasoning as `recomputeClassificationsAndAccuracies`: don't
  // stamp the version on an empty DB, otherwise a later import would
  // skip this pass.
  if (ids.length > 0) {
    await updateSettings({ lastOpeningRefreshVersion: OPENING_REFRESH_VERSION });
  }
  return updated;
}

export type RequeueScope = 'all' | 'month' | 'week' | 'day' | 'latest';

/**
 * Mark games as pending again so they get re-analyzed with the current engine
 * settings. Scope picks the set of games to re-queue.
 */
export async function requeueGamesByScope(scope: RequeueScope): Promise<number> {
  const now = Date.now();
  const DAY = 86400_000;
  const games = await db.games.toArray();
  let target: Game[] = [];
  if (scope === 'all') {
    target = games;
  } else if (scope === 'month') {
    target = games.filter((g) => now - g.endTime < 31 * DAY);
  } else if (scope === 'week') {
    target = games.filter((g) => now - g.endTime < 7 * DAY);
  } else if (scope === 'day') {
    target = games.filter((g) => now - g.endTime < DAY);
  } else if (scope === 'latest') {
    const sorted = [...games].sort((a, b) => b.endTime - a.endTime);
    target = sorted.slice(0, 1);
  }
  await db.transaction('rw', db.games, db.analyses, async () => {
    for (const g of target) {
      await db.games.update(g.id, {
        analysisStatus: 'pending',
        analysisError: undefined,
      });
      await db.analyses.delete(g.id);
    }
  });
  return target.length;
}

export async function requeueAllErrors(): Promise<number> {
  const errored = await db.games.where('analysisStatus').equals('error').toArray();
  await db.transaction('rw', db.games, db.analyses, async () => {
    for (const g of errored) {
      await db.games.update(g.id, {
        analysisStatus: 'pending',
        analysisError: undefined,
      });
      await db.analyses.delete(g.id);
    }
  });
  return errored.length;
}

export async function requeueGame(gameId: string): Promise<void> {
  await db.games.update(gameId, { analysisStatus: 'pending', analysisError: undefined });
  await db.analyses.delete(gameId);
}

/**
 * One-shot backfill of `Game.userTimeSec` + `Game.userPlyCount` for
 * games analyzed before v9 shipped. Without these cached fields, the
 * dashboard's "Hours played" tile re-parses every PGN on every render,
 * which on a 1 k-game library means ~2 MB of regex work per render
 * while the analyzer is firing per-move writes — the dominant cause of
 * the "page hangs for 20 s" symptom.
 *
 * Same pattern as `recomputeClassificationsAndAccuracies`:
 *   - version-stamped (warm boots short-circuit immediately),
 *   - chunked through `bulkGet` + `bulkPut`,
 *   - yields between chunks so the UI thread stays responsive,
 *   - empty-DB runs are deliberately *not* stamped (so a later import
 *     still gets a real pass).
 *
 * Operates over *every* game (not just `done`) because `userTimeSec`
 * is purely PGN-derived — it doesn't depend on engine analysis. That
 * means newly-imported pending games also get the cache populated, so
 * the "Hours played" tile is accurate for unanalyzed games too.
 */
export async function backfillUserTimeStats(opts?: {
  force?: boolean;
}): Promise<number> {
  if (!opts?.force) {
    const settings = await getSettings();
    const stamped = settings.lastUserTimeBackfillVersion;
    if (stamped != null && stamped >= USER_TIME_BACKFILL_VERSION) return 0;
  }

  // Lazy-imported to avoid a cycle: progress.ts → schema.ts → queries.ts.
  const { computeUserTimeStats } = await import('@/features/dashboard/progress');

  const ids = (await db.games.toCollection().primaryKeys()) as string[];
  let updated = 0;

  for (let start = 0; start < ids.length; start += RECOMPUTE_CHUNK) {
    const chunkIds = ids.slice(start, start + RECOMPUTE_CHUNK);
    const games = await db.games.bulkGet(chunkIds);

    const merged: Game[] = [];
    for (const g of games) {
      if (!g) continue;
      // Skip rows that are already at the current version's output.
      // We can't tell apart "computed and got undefined" from "never
      // computed" by looking at the row alone — but the version stamp
      // on Settings is the global signal, so once it's stamped the
      // per-row check doesn't matter. For the *first* run on an
      // existing DB, every row is potentially stale, so we always
      // recompute and only skip writing when nothing changed.
      const stats = computeUserTimeStats({
        timeClass: g.timeClass,
        timeControl: g.timeControl,
        userColor: g.userColor,
        pgn: g.pgn,
      });
      if (
        stats.userTimeSec === g.userTimeSec &&
        stats.userPlyCount === g.userPlyCount
      ) {
        continue;
      }
      merged.push({
        ...g,
        userTimeSec: stats.userTimeSec,
        userPlyCount: stats.userPlyCount,
      });
      updated++;
    }

    if (merged.length > 0) {
      await db.games.bulkPut(merged);
    }

    await yieldToBrowser();
  }

  if (ids.length > 0) {
    await updateSettings({
      lastUserTimeBackfillVersion: USER_TIME_BACKFILL_VERSION,
    });
  }
  return updated;
}

/**
 * Stamp `Game.brilliantCount` onto games analyzed before that field
 * existed.
 *
 * Deliberately its own pass rather than a `RECOMPUTE_VERSION` bump. The
 * count is derivable from classifications *already stored* in `analyses`,
 * so this reads them as-is — no `classifyMove`, no `detectMotifs`, no
 * chess.js FEN parsing, and no writes to the `analyses` table at all.
 * That's the difference between a pass measured in milliseconds and the
 * full re-classification, which walks every move of every game and locks
 * the main thread for seconds-to-minutes on a large library.
 *
 * (Shipping this as a RECOMPUTE_VERSION bump is exactly the mistake that
 * froze the app on 2026-08-07: a cheap counting field dragged the whole
 * re-classification along with it.)
 *
 * Skips games with no analysis row — an unanalyzed game has no
 * classifications to count, and leaving `brilliantCount` undefined is the
 * correct "not known yet" state. The queue stamps it at analysis time.
 */
export async function backfillBrilliantCounts(opts?: {
  force?: boolean;
}): Promise<number> {
  if (!opts?.force) {
    const settings = await getSettings();
    const stamped = settings.lastBrilliantBackfillVersion;
    if (stamped != null && stamped >= BRILLIANT_BACKFILL_VERSION) return 0;
  }

  const doneIds = (await db.games
    .where('analysisStatus')
    .equals('done')
    .primaryKeys()) as string[];
  let updated = 0;

  for (let start = 0; start < doneIds.length; start += RECOMPUTE_CHUNK) {
    const chunkIds = doneIds.slice(start, start + RECOMPUTE_CHUNK);
    const games = await db.games.bulkGet(chunkIds);
    const analyses = await db.analyses.bulkGet(chunkIds);

    const merged: Game[] = [];
    for (let i = 0; i < chunkIds.length; i++) {
      const g = games[i];
      const a = analyses[i];
      if (!g || !a) continue;
      const brilliantCount = countUserBrilliancies(a.moves, g.userColor);
      // `undefined !== 0` on the first run, so a game with no
      // brilliancies still gets stamped once and compares equal
      // thereafter. That's what keeps this idempotent and what lets the
      // badge distinguish "none found" from "never counted".
      if (g.brilliantCount === brilliantCount) continue;
      merged.push({ ...g, brilliantCount });
      updated++;
    }

    if (merged.length > 0) {
      await db.games.bulkPut(merged);
    }

    await yieldToBrowser();
  }

  await updateSettings({
    lastBrilliantBackfillVersion: BRILLIANT_BACKFILL_VERSION,
  });
  return updated;
}
