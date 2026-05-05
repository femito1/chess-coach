import { db, type Game, type Analysis, type AnalysisStatus } from './schema';
import { computeAccuracy } from '@/engine/analyzer';
import { classifyMove } from '@/engine/classify';
import { detectMotifs } from '@/engine/motifs';
import {
  baseSecondsFromTimeControl,
  deriveTimeSpent,
  detectPhase,
  extractClocks,
} from '@/engine/phase';

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

export async function getGame(id: string): Promise<Game | undefined> {
  return db.games.get(id);
}

export async function getAnalysis(gameId: string): Promise<Analysis | undefined> {
  return db.analyses.get(gameId);
}

export async function saveAnalysis(analysis: Analysis): Promise<void> {
  await db.analyses.put(analysis);
}

export async function setAnalysisStatus(
  gameId: string,
  status: AnalysisStatus,
  error?: string,
): Promise<void> {
  await db.games.update(gameId, { analysisStatus: status, analysisError: error });
}

export async function nextPendingGame(): Promise<Game | undefined> {
  return db.games.where('analysisStatus').equals('pending').first();
}

export async function countByStatus(): Promise<Record<AnalysisStatus, number>> {
  const all = await db.games.toArray();
  const counts: Record<AnalysisStatus, number> = {
    pending: 0,
    running: 0,
    done: 0,
    error: 0,
  };
  for (const g of all) counts[g.analysisStatus]++;
  return counts;
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
 * have. Cheap enough to run on every app boot.
 *
 * Returns the number of games whose classifications or accuracy changed.
 */
export async function recomputeClassificationsAndAccuracies(): Promise<number> {
  const done = await db.games.where('analysisStatus').equals('done').toArray();
  let updated = 0;
  for (const g of done) {
    const a = await db.analyses.get(g.id);
    if (!a || a.moves.length === 0) continue;

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
        JSON.stringify(motifs ?? []) !== JSON.stringify(m.motifs ?? [])
      ) {
        changed = true;
      }
      return next;
    });

    const accuracy = computeAccuracy(newMoves);
    const prev = g.accuracy;
    const accuracyChanged =
      !prev || prev.white !== accuracy.white || prev.black !== accuracy.black;

    if (changed || accuracyChanged) {
      await db.analyses.put({ ...a, moves: newMoves });
      await db.games.update(g.id, { accuracy });
      updated++;
    }
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
 */
export async function refreshOpeningMetadata(): Promise<number> {
  const games = await db.games.toArray();
  let updated = 0;
  const { reparseOpeningFromPgn } = await import('@/import/importer');
  for (const g of games) {
    const patch = reparseOpeningFromPgn(g.pgn);
    if (!patch) continue;
    const changed = patch.opening !== g.opening || patch.eco !== g.eco;
    if (changed) {
      await db.games.update(g.id, patch);
      updated++;
    }
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
