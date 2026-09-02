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
import { looksLikePhone } from '@/engine/device';

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
/**
 * Stamps `Analysis.recomputeVersion` on rows that predate the field, using the
 * DB's own `lastRecomputeVersion` as the claim. Its own pass with its own gate,
 * per the rule that a cheap derived field must never be the reason the
 * expensive reclassification runs.
 */
export const RECOMPUTE_STAMP_BACKFILL_VERSION = 1;

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

/** Minimal structural shape of the things we cursor over — a Dexie `Table`
 *  or `Collection`. Structural so this file needn't import Dexie's generics. */
type EachSource<Row> = { each(cb: (row: Row) => void): PromiseLike<void> };

/**
 * Read a whole table through a cursor, projecting each row as it arrives.
 *
 * The obvious spelling — `await source.toArray()` then `.map(project)` — holds
 * the entire table **twice** at its peak: every full row, because `toArray`
 * resolves all of them before `map` runs, plus the stripped copy being built
 * alongside. That defeats the whole purpose of a projection whose reason for
 * existing is to *not* hold every PGN or every move list, and it is what made
 * these list functions the two largest memory sinks on the iPhone Safari killed
 * (ARCHITECTURE.md § Memory on mobile).
 *
 * A cursor visits one row at a time and the full row is garbage the moment
 * `project` returns, so the peak is one full row plus the light array the
 * caller actually asked for. Same rows, same order, same output as the
 * `toArray().map()` form — only the peak differs. Dexie has still no native
 * "select-without-field" projection, so the field is dropped in JS either way;
 * what changed is how many rows are alive when it happens.
 */
async function streamLight<Row, Light>(
  source: EachSource<Row>,
  project: (row: Row) => Light,
): Promise<Light[]> {
  const out: Light[] = [];
  await source.each((row) => {
    out.push(project(row));
  });
  return out;
}

export async function listGamesLight(): Promise<GameLight[]> {
  return streamLight(db.games.orderBy('endTime').reverse(), stripPgn);
}

/** Same projection but returns rows in arbitrary order — matches
 *  `db.games.toArray()`. Used by callers that don't care about ordering
 *  (the Puzzles page, cloud sync) so the projection stays a one-liner there.
 *
 *  Both this and `listGamesLight` are unbounded: they return a row per game in
 *  the library. The light shape is what makes that affordable, not free — a
 *  caller that only needs an aggregate should ask for the aggregate instead
 *  (`countByStatus`, `listTimeClasses`) and read no rows at all. */
export async function listAllGamesLight(): Promise<GameLight[]> {
  return streamLight(db.games.toCollection(), stripPgn);
}

/**
 * The distinct `timeClass` values present in the library.
 *
 * Answered from the `timeClass` index alone — `uniqueKeys` walks index entries,
 * so this reads **no rows at all**, and its cost is the number of distinct
 * classes (five-ish) rather than the number of games. The chip bars that pick a
 * time-control filter want exactly this, and the Settings page used to get it
 * by pulling every game in the library every 1.5 s while the analyzer wrote to
 * the same table.
 *
 * Games with no `timeClass` are absent from the index and so absent here, which
 * matches `availableTimeClasses` skipping falsy values.
 */
export async function listTimeClasses(): Promise<string[]> {
  const keys = await db.games.orderBy('timeClass').uniqueKeys();
  return keys.map((k) => String(k));
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
  // Stamp the rules vintage. The analyzer computes `classification`, `motifs`
  // and `phase` with the very same `classifyMove` / `detectMotifs` /
  // `detectPhase` the recompute pass uses (see `engine/analyzer.ts`), so a row
  // it just produced is by definition current and the pass has nothing to add.
  // Only this path may stamp: cloud *pulls* write `db.analyses` directly and
  // must preserve whatever vintage the other device recorded.
  await db.analyses.put({ ...analysis, recomputeVersion: RECOMPUTE_VERSION });
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
 *
 * Which makes *how many* rows are awaiting that GC at once the thing
 * that matters, and it is a property of the reader, not of this type.
 * Every reader here goes through a cursor for that reason — see
 * `streamLight`. A new one must not reintroduce `toArray().map()`.
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
  // A cursor, for the same reason as `streamLight`: `bulkGet` resolves an array
  // holding every requested row in full, so a 60-id call holds 60 move lists —
  // ~2 MB — for as long as it takes to strip them. The cursor holds one.
  //
  // `anyOf` walks the primary-key index in key order rather than argument
  // order, so rows land in a map and are re-emitted in the caller's order.
  // Contract is unchanged from the `bulkGet` form: input order, ids with no row
  // dropped, a repeated id repeated in the output.
  const byId = new Map<string, AnalysisLight>();
  await db.analyses
    .where(':id')
    .anyOf(gameIds)
    .each((a) => {
      byId.set(a.gameId, stripMoves(a));
    });
  const out: AnalysisLight[] = [];
  for (const id of gameIds) {
    const row = byId.get(id);
    if (row) out.push(row);
  }
  return out;
}

export async function listAnalysesLight(): Promise<AnalysisLight[]> {
  return streamLight(db.analyses.toCollection(), stripMoves);
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
/**
 * Chunk size on a phone-shaped device.
 *
 * The chunk is also the unit of *memory*: a chunk being reprocessed holds its
 * move lists twice over, once as read and once as rebuilt, until the write at
 * the end of the chunk. That is bounded work either way — unlike the whole-table
 * sinks — but it is bounded at a size chosen for a laptop, and on a phone it
 * lands on top of the engine and cloud sync because nothing serialises the
 * three (ARCHITECTURE.md § Memory on mobile).
 *
 * Thirds it. Correctness does not depend on the number: the cursor records the
 * last id of whatever chunk just finished and resumption seeks past it, so a
 * device that changes its answer between boots — or between this and the next
 * release — resumes correctly, just at a different granularity. The cost is
 * 3× as many settings writes and transactions, which is immaterial against a
 * pass that reclassifies every move of every game.
 */
const RECOMPUTE_CHUNK_PHONE = 20;

/** The chunk size for this device. Read per call rather than at module load so
 *  a test can drive both paths and so nothing depends on import order. */
function recomputeChunkSize(): number {
  return looksLikePhone() ? RECOMPUTE_CHUNK_PHONE : RECOMPUTE_CHUNK;
}
/** Games between yields *within* a chunk. Chosen so the main thread is handed
 *  back several times per chunk without multiplying transactions. */
const RECOMPUTE_YIELD_EVERY = 10;

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
  const settings = await getSettings();
  if (!opts?.force) {
    const stamped = settings.lastRecomputeVersion;
    if (stamped != null && stamped >= RECOMPUTE_VERSION) return 0;
  }

  // Sorted, so "everything up to the cursor" is a well-defined prefix that
  // survives a reload. `primaryKeys()` off an index is already ordered, but
  // the resume contract shouldn't rest on that being true forever.
  const doneIds = (
    (await db.games
      .where('analysisStatus')
      .equals('done')
      .primaryKeys()) as string[]
  ).sort();

  // Resume an interrupted pass. The cursor is only honoured for the version
  // that wrote it: after a rules change the old prefix was classified under
  // the old rules and has to be redone. `force` means "redo everything", so it
  // ignores the cursor too.
  //
  // A game that arrives *after* a partial run and sorts before the cursor is
  // skipped — but that is already true without resumption, because `doneIds`
  // is snapshotted here and the completion stamp then suppresses later boots.
  // Freshly analyzed games get their classification from the analyzer anyway;
  // this pass only exists to re-derive *old* rows under new rules.
  const resumeFrom =
    !opts?.force && settings.recomputeCursorVersion === RECOMPUTE_VERSION
      ? settings.recomputeCursor
      : undefined;
  const firstIndex = resumeFrom
    ? doneIds.findIndex((id) => id > resumeFrom)
    : 0;
  // `findIndex` returns -1 when the cursor is at or past the last id, i.e. the
  // previous run got everything and only the final stamp was lost.
  const startIndex = firstIndex === -1 ? doneIds.length : firstIndex;

  let updated = 0;

  const chunkSize = recomputeChunkSize();

  for (let start = startIndex; start < doneIds.length; start += chunkSize) {
    const chunkIds = doneIds.slice(start, start + chunkSize);

    // Which rows actually need reprocessing. A row already stamped with this
    // version has derived fields from these exact rules, so recomputing it
    // would spend `classifyMove` + `detectMotifs` over every move only to
    // arrive back where it started. This is what makes a cloud restore cheap:
    // pulled rows arrive stamped by the device that produced them.
    //
    // The decision needs two fields — the vintage stamp, and whether there are
    // any moves at all — so it is taken on the LIGHT projection. Reading full
    // rows to answer it meant holding every move list in the chunk for as long
    // as the chunk ran, and on the case this gate exists for (a restored
    // library, every row already current) that was the pass's entire cost:
    // materialise 60 move lists, conclude there is nothing to do, drop them,
    // repeat to the end of the library. `bulkGetAnalysisLight` streams, so the
    // peak here is one row. It also drops ids with no analysis row, which is
    // the `!a` arm of the old filter.
    const chunkLight = await bulkGetAnalysisLight(chunkIds);
    const todoIds: string[] = [];
    for (const a of chunkLight) {
      if (a.moveCount === 0) continue;
      if (!opts?.force && (a.recomputeVersion ?? 0) >= RECOMPUTE_VERSION) continue;
      todoIds.push(a.gameId);
    }

    if (todoIds.length === 0) {
      // Nothing to do here, but still record progress: a reload should not
      // have to re-examine this stretch either.
      await updateSettings({
        recomputeCursor: chunkIds[chunkIds.length - 1],
        recomputeCursorVersion: RECOMPUTE_VERSION,
      });
      continue;
    }

    // Full rows for exactly the ids being reprocessed — the analyses for their
    // move lists, the games for the PGN their clocks come out of. `Game` carries
    // that PGN, so on a restored library where everything is already current
    // this is the difference between reading every PGN off disk and reading
    // none; the same now goes for the move lists above it.
    const analyses = await db.analyses.bulkGet(todoIds);
    const games = await db.games.bulkGet(todoIds);

    const analysisPatches: Analysis[] = [];
    const gamePatches: Array<{
      id: string;
      accuracy: { white: number; black: number };
      brilliantCount: number;
    }> = [];

    for (let i = 0; i < analyses.length; i++) {
      // Yield inside the chunk, not just between chunks. Reclassifying a
      // full chunk is a few thousand `classifyMove` + `detectMotifs` calls of
      // uninterrupted main-thread work, which is what makes the app feel wedged
      // rather than merely slow. This loop is pure CPU with no transaction open,
      // so yielding here is free — the chunk's single transaction still batches
      // every one of its writes, so `useLiveQuery` re-render counts are
      // unchanged.
      if (i > 0 && i % RECOMPUTE_YIELD_EVERY === 0) await yieldToBrowser();

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

      // Write whenever anything changed *or* the row still lacks this
      // version's stamp — which, given the filter above, is every row that
      // reaches here. Stamping the no-change case matters more than it looks:
      // a restored library recomputes to *identical* values, so a
      // changed-only write would leave every one of those rows unstamped, and
      // the next restore would re-derive the whole library again. Recording
      // "these rules have been applied" is the point, not the diff.
      const needsStamp = (a.recomputeVersion ?? 0) < RECOMPUTE_VERSION;
      if (changed || accuracyChanged || brilliantChanged || needsStamp) {
        analysisPatches.push({
          ...a,
          moves: newMoves,
          recomputeVersion: RECOMPUTE_VERSION,
        });
        gamePatches.push({ id: g.id, accuracy, brilliantCount });
        updated++;
      }
    }

    if (analysisPatches.length > 0) {
      // One transaction per chunk, two bulk writes inside it. This is
      // ~a chunk's worth fewer transactions than the per-game version
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

    // Record how far we got, so a reload resumes here instead of starting
    // over. One small settings write per 60 games, against a chunk that just
    // wrote up to 60 analyses and 60 games — immaterial next to the work it
    // protects.
    await updateSettings({
      recomputeCursor: chunkIds[chunkIds.length - 1],
      recomputeCursorVersion: RECOMPUTE_VERSION,
    });

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
    await updateSettings({
      lastRecomputeVersion: RECOMPUTE_VERSION,
      // The run is over; a stale cursor would only be a trap for the next
      // version bump, which must start from the beginning.
      recomputeCursor: undefined,
      recomputeCursorVersion: undefined,
    });
  }

  return updated;
}

/**
 * Backwards-compat alias. Older code and tests may import this name.
 */
export const recomputeAllAccuracies = recomputeClassificationsAndAccuracies;

/**
 * Record which rules vintage the existing analyses were derived under.
 *
 * `Analysis.recomputeVersion` is new, so every row written before it exists
 * looks like "unknown vintage" and would be reprocessed. But a DB that carries
 * `lastRecomputeVersion` has *already* been through that pass at that version —
 * the claim is right there in settings, it simply was never recorded per row.
 * Copying it across costs one read and one write per chunk and no
 * classification work at all.
 *
 * Why bother, when the global stamp already suppresses the pass locally: the
 * per-row stamp is what travels. It rides along in the analysis blob to the
 * cloud, so a future restore onto a wiped device arrives with rows that say
 * "already current" and skips a reclassification of the entire library — the
 * failure that blocked a real library for half an hour.
 *
 * Claims nothing when the DB has no `lastRecomputeVersion`: there is no basis,
 * and the reclassification pass will stamp those rows itself.
 */
export async function backfillRecomputeVersion(): Promise<number> {
  const settings = await getSettings();
  if (
    (settings.lastRecomputeStampBackfillVersion ?? 0) >=
    RECOMPUTE_STAMP_BACKFILL_VERSION
  ) {
    return 0;
  }
  const claim = settings.lastRecomputeVersion;
  if (claim == null) return 0;

  const ids = (await db.analyses.toCollection().primaryKeys()) as string[];
  let updated = 0;

  for (let start = 0; start < ids.length; start += RECOMPUTE_CHUNK) {
    const chunkIds = ids.slice(start, start + RECOMPUTE_CHUNK);
    const rows = await db.analyses.bulkGet(chunkIds);
    const patches: Analysis[] = [];
    for (const a of rows) {
      if (!a) continue;
      if ((a.recomputeVersion ?? 0) >= claim) continue;
      patches.push({ ...a, recomputeVersion: claim });
      updated++;
    }
    if (patches.length > 0) await db.analyses.bulkPut(patches);
    await yieldToBrowser();
  }

  // Same rule as passes 3-5: an empty DB must not mark the work done, or the
  // rows that arrive afterwards never get stamped.
  if (ids.length > 0) {
    await updateSettings({
      lastRecomputeStampBackfillVersion: RECOMPUTE_STAMP_BACKFILL_VERSION,
    });
  }
  return updated;
}

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
        // Deliberate, user-initiated "redo these", so it earns the sync requeue
        // guard. Deliberately NOT stamped by `resetRunningToPending` (crash
        // recovery), `requeueStaleErrors` or `requeueAllErrors`: those want a
        // working analysis, and a cloud copy is exactly that, so suppressing the
        // pull there would be a loss rather than a protection.
        requeuedAt: now,
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
  // `requeuedAt` is what lets cloud sync distinguish this from a game that was
  // simply never analyzed — without it the sync guard blocks every pull. Stamped
  // BEFORE deleting the analysis so a sync racing this can never see the game
  // pending with no stamp.
  await db.games.update(gameId, {
    analysisStatus: 'pending',
    analysisError: undefined,
    requeuedAt: Date.now(),
  });
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

  const chunkSize = recomputeChunkSize();

  for (let start = 0; start < doneIds.length; start += chunkSize) {
    const chunkIds = doneIds.slice(start, start + chunkSize);

    // Two fields are read off each game and one is written, so the PGN this row
    // carries is pure overhead — and `bulkGet` would hold a chunk's worth of
    // them. Cursor the primary-key index instead and keep only the two fields.
    // (ARCHITECTURE.md § Memory on mobile, sink 4: "the PGN is paid for and
    // never touched".)
    const colors = new Map<string, Game['userColor']>();
    const stored = new Map<string, number | undefined>();
    await db.games
      .where(':id')
      .anyOf(chunkIds)
      .each((g) => {
        colors.set(g.id, g.userColor);
        stored.set(g.id, g.brilliantCount);
      });

    // The move lists are the thing being counted, so those are genuinely
    // needed — but one at a time, not a chunk at a time. A cursor frees each
    // list as soon as its count is taken.
    const updates: Array<{ key: string; changes: { brilliantCount: number } }> = [];
    await db.analyses
      .where(':id')
      .anyOf(chunkIds)
      .each((a) => {
        // No game row for this analysis: the `!g` arm of the old filter. Read
        // through `has`, not a falsy check, because `userColor` is a real value
        // whose absence would otherwise be indistinguishable from a missing row.
        if (!colors.has(a.gameId)) return;
        const brilliantCount = countUserBrilliancies(a.moves, colors.get(a.gameId)!);
        // `undefined !== 0` on the first run, so a game with no
        // brilliancies still gets stamped once and compares equal
        // thereafter. That's what keeps this idempotent and what lets the
        // badge distinguish "none found" from "never counted".
        if (stored.get(a.gameId) === brilliantCount) return;
        updates.push({ key: a.gameId, changes: { brilliantCount } });
        updated++;
      });

    if (updates.length > 0) {
      // `bulkUpdate`, not a `bulkPut` of merged rows. Patching one field means
      // the row's PGN never has to be held to be written back — and it closes a
      // real hazard rather than only a memory one: this pass runs at boot
      // alongside the analyzer, which writes `analysisStatus` to these same
      // rows, and putting back a whole row read seconds earlier would revert
      // whatever landed in between.
      await db.games.bulkUpdate(updates);
    }

    await yieldToBrowser();
  }

  // Only stamp when there was something to consider. Stamping on an empty DB
  // marks the work done before the data arrives, so a first boot followed by an
  // import silently skips the backfill forever — the pass is gated by version,
  // not by row count. Passes 3, 4 and 5 already hold this rule; this one didn't,
  // which ARCHITECTURE.md flagged as a latent bug for exactly the
  // fresh-install-then-import path that cloud restore now makes routine.
  if (doneIds.length > 0) {
    await updateSettings({
      lastBrilliantBackfillVersion: BRILLIANT_BACKFILL_VERSION,
    });
  }
  return updated;
}
