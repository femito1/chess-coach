import { describe, expect, it } from 'vitest';
import type { AnalysisStatus, PuzzleAttempt } from '@/db/schema';
import {
  attemptDiffers,
  chunk,
  diffAnalyses,
  diffAttempts,
  diffGames,

  mergeAttempt,
  type LocalAnalysisMeta,
  type LocalGameMeta,
  type RemoteAnalysisMeta,
  type RemoteGameMeta,
} from './diff';

const g = (id: string, analysisStatus: AnalysisStatus): LocalGameMeta => ({
  id,
  analysisStatus,
});
const rg = (game_id: string, analysis_status: string): RemoteGameMeta => ({
  game_id,
  analysis_status,
});
const la = (
  gameId: string,
  depth: number,
  analyzedAt: number,
  engine?: string,
): LocalAnalysisMeta => ({ gameId, depth, analyzedAt, engine });
const ra = (
  game_id: string,
  depth: number,
  analyzed_at: number,
  engine?: string | null,
): RemoteAnalysisMeta => ({ game_id, depth, analyzed_at, engine });

const NNUE = 'stockfish-16-nnue';
const CLASSICAL = 'stockfish-16-classical';

function analysisArgs(
  local: LocalAnalysisMeta[],
  remote: RemoteAnalysisMeta[],
  games: Array<[string, AnalysisStatus]> = [],
) {
  const ids = new Set<string>([
    ...local.map((a) => a.gameId),
    ...remote.map((r) => r.game_id),
    ...games.map(([id]) => id),
  ]);
  const status = new Map<string, AnalysisStatus>(games);
  for (const id of ids) if (!status.has(id)) status.set(id, 'done');
  return { local, remote, localGameStatus: status, localGameIds: ids };
}

/* =======================================================================
 *  Games
 * =======================================================================
 */

describe('diffGames', () => {
  it('pushes local-only games', () => {
    expect(diffGames([g('a', 'done'), g('b', 'done')], [rg('a', 'done')])).toEqual({
      push: ['b'],
      pull: [],
    });
  });

  it('pulls remote-only games', () => {
    expect(diffGames([g('a', 'done')], [rg('a', 'done'), rg('b', 'done')])).toEqual({
      push: [],
      pull: ['b'],
    });
  });

  it('does nothing when both sides agree', () => {
    expect(diffGames([g('a', 'done')], [rg('a', 'done')])).toEqual({
      push: [],
      pull: [],
    });
    expect(diffGames([g('a', 'pending')], [rg('a', 'pending')])).toEqual({
      push: [],
      pull: [],
    });
  });

  it('pushes when only the local side is analyzed', () => {
    // The done row carries cached accuracy + brilliantCount that the pending
    // one doesn't, so it's the better copy.
    expect(diffGames([g('a', 'done')], [rg('a', 'pending')])).toEqual({
      push: ['a'],
      pull: [],
    });
  });

  it('does NOT pull over a deliberate local requeue', () => {
    // `pending`/`running` locally means the user asked for a re-analysis.
    // Pulling the cloud's `done` row would flip the status back, which in turn
    // makes `diffAnalyses` think the game is finished and lets the stale cloud
    // analysis return — undoing the requeue through the games phase.
    for (const status of ['pending', 'running'] as AnalysisStatus[]) {
      expect(diffGames([g('a', status)], [rg('a', 'done')]), status).toEqual({
        push: [],
        pull: [],
      });
    }
  });

  it('does pull when the local analysis errored', () => {
    // A failure, not an intent — the cloud may hold a copy from a device where
    // analysis actually worked.
    expect(diffGames([g('a', 'error')], [rg('a', 'done')])).toEqual({
      push: [],
      pull: ['a'],
    });
  });

  it('handles an empty local library (fresh device)', () => {
    const plan = diffGames([], [rg('a', 'done'), rg('b', 'done')]);
    expect(plan.pull.sort()).toEqual(['a', 'b']);
    expect(plan.push).toEqual([]);
  });

  it('handles an empty cloud (first ever sync)', () => {
    const plan = diffGames([g('a', 'done'), g('b', 'pending')], []);
    expect(plan.push.sort()).toEqual(['a', 'b']);
    expect(plan.pull).toEqual([]);
  });

  it('never lists the same id on both sides', () => {
    const plan = diffGames(
      [g('a', 'done'), g('b', 'pending'), g('c', 'done')],
      [rg('a', 'pending'), rg('b', 'done'), rg('d', 'done')],
    );
    for (const id of plan.push) expect(plan.pull).not.toContain(id);
  });
});

/* =======================================================================
 *  Analyses
 * =======================================================================
 */

describe('diffAnalyses', () => {
  it('pushes local-only analyses', () => {
    const plan = diffAnalyses(analysisArgs([la('a', 16, 100)], []));
    expect(plan).toEqual({ push: ['a'], pull: [] });
  });

  it('pulls remote-only analyses when the game exists locally', () => {
    const plan = diffAnalyses(analysisArgs([], [ra('a', 16, 100)], [['a', 'done']]));
    expect(plan).toEqual({ push: [], pull: ['a'] });
  });

  it('prefers the deeper analysis regardless of age', () => {
    // Depth leads: a depth-20 analysis is strictly more informative, and a
    // shallow re-analysis on a second device must not clobber a deep one.
    expect(diffAnalyses(analysisArgs([la('a', 20, 100)], [ra('a', 16, 999)])).push).toEqual(
      ['a'],
    );
    expect(diffAnalyses(analysisArgs([la('a', 16, 999)], [ra('a', 20, 100)])).pull).toEqual(
      ['a'],
    );
  });

  it('falls back to recency at equal depth', () => {
    expect(diffAnalyses(analysisArgs([la('a', 16, 200)], [ra('a', 16, 100)])).push).toEqual(
      ['a'],
    );
    expect(diffAnalyses(analysisArgs([la('a', 16, 100)], [ra('a', 16, 200)])).pull).toEqual(
      ['a'],
    );
  });

  it('does nothing when both sides are identical', () => {
    expect(diffAnalyses(analysisArgs([la('a', 16, 100)], [ra('a', 16, 100)]))).toEqual({
      push: [],
      pull: [],
    });
  });

  describe('evaluator outranks depth', () => {
    // The bundled WASM build runs `Use NNUE` off, so every browser analysis is
    // classical — a materially weaker judge of quiet positions (measured: a rook
    // endgame at +0.53 classical vs +3.77 NNUE). A deeper classical search is
    // therefore NOT better than a shallower NNUE one, and ranking depth first
    // would let a laptop silently overwrite the server's stronger work.
    it('prefers NNUE over classical even at lower depth', () => {
      expect(
        diffAnalyses(analysisArgs([la('a', 12, 1, NNUE)], [ra('a', 24, 999, CLASSICAL)])),
      ).toEqual({ push: ['a'], pull: [] });
      expect(
        diffAnalyses(analysisArgs([la('a', 24, 999, CLASSICAL)], [ra('a', 12, 1, NNUE)])),
      ).toEqual({ push: [], pull: ['a'] });
    });

    it('treats a missing engine as classical', () => {
      // Rows written before the evaluator was recorded came from the classical
      // build; reading null as classical is the honest default, not a guess.
      expect(
        diffAnalyses(analysisArgs([la('a', 16, 1, NNUE)], [ra('a', 16, 999, null)])),
      ).toEqual({ push: ['a'], pull: [] });
      expect(
        diffAnalyses(analysisArgs([la('a', 16, 1)], [ra('a', 16, 2, NNUE)])),
      ).toEqual({ push: [], pull: ['a'] });
    });

    it('falls back to depth when both are NNUE', () => {
      expect(
        diffAnalyses(analysisArgs([la('a', 20, 1, NNUE)], [ra('a', 18, 999, NNUE)])),
      ).toEqual({ push: ['a'], pull: [] });
    });

    it('falls back to recency when evaluator and depth match', () => {
      expect(
        diffAnalyses(analysisArgs([la('a', 18, 500, NNUE)], [ra('a', 18, 100, NNUE)])),
      ).toEqual({ push: ['a'], pull: [] });
    });

    it('does nothing when both sides are the same NNUE analysis', () => {
      expect(
        diffAnalyses(analysisArgs([la('a', 18, 7, NNUE)], [ra('a', 18, 7, NNUE)])),
      ).toEqual({ push: [], pull: [] });
    });
  });

  describe('requeue guard', () => {
    it('does not resurrect an analysis for a game the user requeued', () => {
      // `requeueGame` deletes the local analysis and sets the game to pending.
      // Pulling here would silently undo that, every single sync.
      for (const status of ['pending', 'running'] as AnalysisStatus[]) {
        const plan = diffAnalyses(analysisArgs([], [ra('a', 16, 100)], [['a', status]]));
        expect(plan.pull, `status=${status}`).toEqual([]);
      }
    });

    it('resumes normal behaviour once the re-analysis lands', () => {
      // Fresh local analysis at the same depth but newer → pushes up.
      const plan = diffAnalyses(
        analysisArgs([la('a', 16, 500)], [ra('a', 16, 100)], [['a', 'done']]),
      );
      expect(plan.push).toEqual(['a']);
    });

    it('still pulls for a game in error state', () => {
      // `error` isn't a deliberate requeue — it's a failure, and the cloud may
      // hold a good analysis from a device where it worked.
      const plan = diffAnalyses(analysisArgs([], [ra('a', 16, 100)], [['a', 'error']]));
      expect(plan.pull).toEqual(['a']);
    });
  });

  it('skips a cloud analysis whose game this device has never imported', () => {
    // Would otherwise arrive orphaned. The game pulls first; its analysis
    // follows on the next pass.
    const plan = diffAnalyses({
      local: [],
      remote: [ra('ghost', 16, 100)],
      localGameStatus: new Map(),
      localGameIds: new Set(),
    });
    expect(plan.pull).toEqual([]);
  });

  it('handles a full first upload', () => {
    const local = [la('a', 16, 1), la('b', 16, 2), la('c', 20, 3)];
    const plan = diffAnalyses(analysisArgs(local, []));
    expect(plan.push.sort()).toEqual(['a', 'b', 'c']);
    expect(plan.pull).toEqual([]);
  });
});

/* =======================================================================
 *  Puzzle attempts
 * =======================================================================
 */

const attempt = (over: Partial<PuzzleAttempt> = {}): PuzzleAttempt => ({
  puzzleId: 'p1',
  firstSeenAt: 1_000,
  lastAttemptedAt: 2_000,
  attempts: 1,
  solvedClean: false,
  hintUsed: false,
  rating: 1500,
  ...over,
});

describe('mergeAttempt', () => {
  it('keeps a clean solve from either side', () => {
    // Solved cleanly on the laptop, fumbled on the phone: the achievement
    // stands. Last-write-wins would erase it.
    const clean = attempt({ solvedClean: true, lastAttemptedAt: 1_000 });
    const messy = attempt({ solvedClean: false, lastAttemptedAt: 9_000 });
    expect(mergeAttempt(clean, messy).solvedClean).toBe(true);
    expect(mergeAttempt(messy, clean).solvedClean).toBe(true);
  });

  it('keeps hintUsed sticky from either side', () => {
    const hinted = attempt({ hintUsed: true, lastAttemptedAt: 1_000 });
    const unhinted = attempt({ hintUsed: false, lastAttemptedAt: 9_000 });
    expect(mergeAttempt(hinted, unhinted).hintUsed).toBe(true);
    expect(mergeAttempt(unhinted, hinted).hintUsed).toBe(true);
  });

  it('takes max attempts, not a sum', () => {
    // A sum would double-count the shared attempt and keep inflating on every
    // sync, which would make the merge non-idempotent.
    const merged = mergeAttempt(attempt({ attempts: 3 }), attempt({ attempts: 5 }));
    expect(merged.attempts).toBe(5);
  });

  it('takes the earliest firstSeenAt and the latest lastAttemptedAt', () => {
    const merged = mergeAttempt(
      attempt({ firstSeenAt: 500, lastAttemptedAt: 1_500 }),
      attempt({ firstSeenAt: 900, lastAttemptedAt: 8_000 }),
    );
    expect(merged.firstSeenAt).toBe(500);
    expect(merged.lastAttemptedAt).toBe(8_000);
  });

  it('takes rating and msTaken from the more recent side', () => {
    const older = attempt({ lastAttemptedAt: 1_000, rating: 1200, msTaken: 5_000 });
    const newer = attempt({ lastAttemptedAt: 9_000, rating: 1900, msTaken: 1_000 });
    expect(mergeAttempt(older, newer).rating).toBe(1900);
    expect(mergeAttempt(older, newer).msTaken).toBe(1_000);
  });

  it('keeps an msTaken that exists on only one side', () => {
    const withMs = attempt({ lastAttemptedAt: 1_000, msTaken: 4_242 });
    const without = attempt({ lastAttemptedAt: 9_000 });
    expect(mergeAttempt(without, withMs).msTaken).toBe(4_242);
  });

  it('is commutative', () => {
    // Both devices must compute the same merged row from the same pair, or
    // they would ping-pong writes forever.
    const a = attempt({
      attempts: 2,
      solvedClean: true,
      hintUsed: false,
      firstSeenAt: 100,
      lastAttemptedAt: 500,
      rating: 1400,
    });
    const b = attempt({
      attempts: 7,
      solvedClean: false,
      hintUsed: true,
      firstSeenAt: 50,
      lastAttemptedAt: 900,
      rating: 1600,
    });
    expect(mergeAttempt(a, b)).toEqual(mergeAttempt(b, a));
  });

  it('is idempotent', () => {
    const a = attempt({ attempts: 2, solvedClean: true, lastAttemptedAt: 500 });
    const b = attempt({ attempts: 7, hintUsed: true, lastAttemptedAt: 900 });
    const once = mergeAttempt(a, b);
    expect(mergeAttempt(once, once)).toEqual(once);
    expect(mergeAttempt(once, b)).toEqual(once);
    expect(mergeAttempt(once, a)).toEqual(once);
  });
});

describe('attemptDiffers', () => {
  it('is false for an unchanged row', () => {
    const a = attempt();
    expect(attemptDiffers(a, mergeAttempt(a, a))).toBe(false);
  });

  it('notices every merged field', () => {
    const base = attempt();
    expect(attemptDiffers(base, { ...base, attempts: 9 })).toBe(true);
    expect(attemptDiffers(base, { ...base, solvedClean: true })).toBe(true);
    expect(attemptDiffers(base, { ...base, hintUsed: true })).toBe(true);
    expect(attemptDiffers(base, { ...base, firstSeenAt: 1 })).toBe(true);
    expect(attemptDiffers(base, { ...base, lastAttemptedAt: 1 })).toBe(true);
    expect(attemptDiffers(base, { ...base, rating: 1 })).toBe(true);
    expect(attemptDiffers(base, { ...base, msTaken: 1 })).toBe(true);
  });
});

describe('diffAttempts', () => {
  it('pushes local-only attempts', () => {
    const plan = diffAttempts([attempt({ puzzleId: 'p1' })], []);
    expect(plan.push.map((a) => a.puzzleId)).toEqual(['p1']);
    expect(plan.writeLocal).toEqual([]);
  });

  it('pulls remote-only attempts', () => {
    const plan = diffAttempts([], [attempt({ puzzleId: 'p2' })]);
    expect(plan.writeLocal.map((a) => a.puzzleId)).toEqual(['p2']);
    expect(plan.push).toEqual([]);
  });

  it('does nothing when both sides already agree', () => {
    const a = attempt();
    expect(diffAttempts([a], [{ ...a }])).toEqual({ writeLocal: [], push: [] });
  });

  it('writes the merge to both sides when each holds something new', () => {
    const local = attempt({ solvedClean: true, lastAttemptedAt: 1_000, attempts: 1 });
    const remote = attempt({ hintUsed: true, lastAttemptedAt: 2_000, attempts: 4 });
    const plan = diffAttempts([local], [remote]);
    expect(plan.writeLocal).toHaveLength(1);
    expect(plan.push).toHaveLength(1);
    // Both sides converge on the same row.
    expect(plan.writeLocal[0]).toEqual(plan.push[0]);
    expect(plan.push[0].solvedClean).toBe(true);
    expect(plan.push[0].hintUsed).toBe(true);
    expect(plan.push[0].attempts).toBe(4);
  });

  it('only writes the side that is actually behind', () => {
    // Local already has everything the merge produces → nothing to write back.
    const local = attempt({ attempts: 9, solvedClean: true, hintUsed: true });
    const remote = attempt({ attempts: 1, solvedClean: false, hintUsed: false });
    const plan = diffAttempts([local], [remote]);
    expect(plan.writeLocal).toEqual([]);
    expect(plan.push).toHaveLength(1);
  });

  it('merges disjoint per-device progress without losing either', () => {
    // The concurrency case attempts exist for: different puzzles solved on
    // different devices in the same session.
    const plan = diffAttempts(
      [attempt({ puzzleId: 'phone1' }), attempt({ puzzleId: 'shared' })],
      [attempt({ puzzleId: 'laptop1' }), attempt({ puzzleId: 'shared' })],
    );
    expect(plan.push.map((a) => a.puzzleId)).toEqual(['phone1']);
    expect(plan.writeLocal.map((a) => a.puzzleId)).toEqual(['laptop1']);
  });

  it('converges after one round trip', () => {
    // Apply the plan to both sides, re-diff, and expect nothing left to do.
    let local = [attempt({ solvedClean: true, lastAttemptedAt: 1_000 })];
    let remote = [attempt({ hintUsed: true, lastAttemptedAt: 2_000, attempts: 3 })];
    const plan = diffAttempts(local, remote);
    const apply = (rows: PuzzleAttempt[], updates: PuzzleAttempt[]) => {
      const byId = new Map(rows.map((r) => [r.puzzleId, r]));
      for (const u of updates) byId.set(u.puzzleId, u);
      return [...byId.values()];
    };
    local = apply(local, plan.writeLocal);
    remote = apply(remote, plan.push);
    expect(diffAttempts(local, remote)).toEqual({ writeLocal: [], push: [] });
  });

  it('handles both sides empty', () => {
    expect(diffAttempts([], [])).toEqual({ writeLocal: [], push: [] });
  });
});

/* =======================================================================
 *  chunk
 * =======================================================================
 */

describe('chunk', () => {
  it('splits into batches of at most `size`', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('returns one batch when everything fits', () => {
    expect(chunk([1, 2], 10)).toEqual([[1, 2]]);
  });

  it('returns nothing for an empty input', () => {
    expect(chunk([], 10)).toEqual([]);
  });

  it('covers every item exactly once', () => {
    const items = Array.from({ length: 97 }, (_, i) => i);
    expect(chunk(items, 20).flat()).toEqual(items);
  });
});
