import { describe, expect, it } from 'vitest';
import type {
  Analysis,
  AnalysisStatus,
  PuzzleAttempt,
  PuzzleAttemptEvent,
} from '@/db/schema';
import {
  MAX_ATTEMPT_HISTORY,
  attemptDiffers,
  chunk,
  diffAnalyses,
  diffAttempts,
  diffGames,
  mergeAttempt,
  rebaseAttemptWrite,
  toCloudAnalysis,
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
  recomputeVersion?: number,
): LocalAnalysisMeta => ({ gameId, depth, analyzedAt, engine, recomputeVersion });
const ra = (
  game_id: string,
  depth: number,
  analyzed_at: number,
  engine?: string | null,
  recompute_version?: number | null,
): RemoteAnalysisMeta => ({ game_id, depth, analyzed_at, engine, recompute_version });

const NNUE = 'stockfish-16-nnue';
const CLASSICAL = 'stockfish-16-classical';

function analysisArgs(
  local: LocalAnalysisMeta[],
  remote: RemoteAnalysisMeta[],
  games: Array<[string, AnalysisStatus]> = [],
  requeuedAt: Array<[string, number]> = [],
) {
  const ids = new Set<string>([
    ...local.map((a) => a.gameId),
    ...remote.map((r) => r.game_id),
    ...games.map(([id]) => id),
  ]);
  const status = new Map<string, AnalysisStatus>(games);
  for (const id of ids) if (!status.has(id)) status.set(id, 'done');
  return {
    local,
    remote,
    localGameStatus: status,
    localGameIds: ids,
    localRequeuedAt: new Map<string, number>(requeuedAt),
  };
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

  describe('rules vintage breaks a tie the clock cannot see', () => {
    // `recomputeVersion` records which classification rules produced a row's
    // derived fields. Rewriting those fields deliberately leaves `analyzedAt`
    // alone — the search really did happen when it says — so without this rung
    // a freshly-stamped local row and an un-stamped cloud row tie forever, the
    // cloud keeps rows of unknown vintage, and every restore reclassifies the
    // whole library. That is the half-hour freeze this rung exists to prevent.
    it('pushes a stamped row over an unstamped one at equal depth and age', () => {
      expect(
        diffAnalyses(analysisArgs([la('a', 16, 100, NNUE, 2)], [ra('a', 16, 100, NNUE, null)])),
      ).toEqual({ push: ['a'], pull: [] });
    });

    it('pulls the stamped side when the cloud is the fresher one', () => {
      expect(
        diffAnalyses(analysisArgs([la('a', 16, 100, NNUE, undefined)], [ra('a', 16, 100, NNUE, 2)])),
      ).toEqual({ push: [], pull: ['a'] });
    });

    it('reaches a fixed point once both sides agree', () => {
      // The property the whole design rests on: no perpetual re-pushing.
      expect(
        diffAnalyses(analysisArgs([la('a', 16, 100, NNUE, 2)], [ra('a', 16, 100, NNUE, 2)])),
      ).toEqual({ push: [], pull: [] });
    });

    it('ranks below evaluator and depth, not above them', () => {
      // A newer rules vintage is the same search read under current rules, not
      // a better search. It must never outrank NNUE...
      expect(
        diffAnalyses(analysisArgs([la('a', 16, 100, CLASSICAL, 9)], [ra('a', 16, 100, NNUE, 0)])),
      ).toEqual({ push: [], pull: ['a'] });
      // ...nor depth.
      expect(
        diffAnalyses(analysisArgs([la('a', 12, 100, NNUE, 9)], [ra('a', 20, 100, NNUE, 0)])),
      ).toEqual({ push: [], pull: ['a'] });
    });

    it('still prefers recency when the vintage matches', () => {
      expect(
        diffAnalyses(analysisArgs([la('a', 16, 200, NNUE, 2)], [ra('a', 16, 100, NNUE, 2)])),
      ).toEqual({ push: ['a'], pull: [] });
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
      // `requeueGame` deletes the local analysis, sets the game to pending, and
      // stamps `requeuedAt`. Pulling the row they just threw away would silently
      // undo that, every single sync. The remote analysis here predates the
      // requeue, which is what identifies it as that row.
      for (const status of ['pending', 'running'] as AnalysisStatus[]) {
        const plan = diffAnalyses(
          analysisArgs([], [ra('a', 16, 100)], [['a', status]], [['a', 200]]),
        );
        expect(plan.pull, `status=${status}`).toEqual([]);
      }
    });

    it('PULLS a pending game that was never analyzed here', () => {
      // The regression that broke the off-laptop worker in practice.
      //
      // Before `requeuedAt` existed, the guard keyed on status alone. But a game
      // that has simply never been analyzed on this device is ALSO `pending`, and
      // that is the normal case once a server analyzes games the laptop never
      // touched: 1 785 games analyzed in the cloud, every one of them `pending`
      // locally, and sync refused to pull a single analysis while the laptop
      // ground through re-analyzing all of them itself.
      //
      // No `requeuedAt` stamp means it was never requeued, so there is nothing to
      // protect and the cloud analysis is pure gain.
      for (const status of ['pending', 'running'] as AnalysisStatus[]) {
        const plan = diffAnalyses(
          analysisArgs([], [ra('fresh', 18, 100, NNUE)], [['fresh', status]]),
        );
        expect(plan.pull, `status=${status}`).toEqual(['fresh']);
      }
    });

    it('pulls an analysis produced AFTER the requeue', () => {
      // Requeued at 200, then the server analyzed it at 900. That is new work,
      // not the row the user discarded — exactly what they asked for, done better
      // elsewhere. Suppressing it would strand the game pending forever on a
      // device whose queue is idle.
      const plan = diffAnalyses(
        analysisArgs([], [ra('a', 18, 900, NNUE)], [['a', 'pending']], [['a', 200]]),
      );
      expect(plan.pull).toEqual(['a']);
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
      localRequeuedAt: new Map(),
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

  describe('history and content', () => {
    const ev = (at: number, outcome: PuzzleAttemptEvent['outcome'] = 'clean') => ({
      at,
      outcome,
    });

    it('unions histories, keeping the shared attempt once, in time order', () => {
      // Both devices hold the attempt made before the last sync (t=100);
      // each then attempted once more on its own.
      const phone = attempt({ attempts: 2, history: [ev(100, 'mistake'), ev(300)] });
      const laptop = attempt({ attempts: 2, history: [ev(100, 'mistake'), ev(200, 'hint')] });
      const merged = mergeAttempt(phone, laptop);
      expect(merged.history).toEqual([ev(100, 'mistake'), ev(200, 'hint'), ev(300)]);
      // `attempts` can't lag the history it summarises.
      expect(merged.attempts).toBe(3);
    });

    it('caps history to the first attempt plus the newest MAX_ATTEMPT_HISTORY - 1', () => {
      // The first attempt is what the rating and first-try stats read; a
      // plain newest-N cap re-keyed them to attempt #2.
      const a = attempt({
        attempts: MAX_ATTEMPT_HISTORY,
        history: Array.from({ length: MAX_ATTEMPT_HISTORY }, (_, i) => ev(i * 2, i === 0 ? 'mistake' : 'clean')),
      });
      const b = attempt({
        attempts: MAX_ATTEMPT_HISTORY,
        history: Array.from({ length: MAX_ATTEMPT_HISTORY }, (_, i) => ev(i * 2 + 1)),
      });
      const merged = mergeAttempt(a, b);
      expect(merged).toEqual(mergeAttempt(b, a));
      expect(merged.history).toHaveLength(MAX_ATTEMPT_HISTORY);
      const total = 2 * MAX_ATTEMPT_HISTORY;
      expect(merged.history!.map((e) => e.at)).toEqual([
        0,
        ...Array.from({ length: MAX_ATTEMPT_HISTORY - 1 }, (_, i) => total - MAX_ATTEMPT_HISTORY + 1 + i),
      ]);
      expect(merged.history![0].outcome).toBe('mistake');
      expect(merged.attempts).toBeGreaterThanOrEqual(merged.history!.length);
      expect(mergeAttempt(merged, a)).toEqual(merged);
      expect(mergeAttempt(merged, b)).toEqual(merged);
    });

    it('keeps a legacy side’s first attempt when the other side has a history', () => {
      // Missed on the phone before `history` existed; retried cleanly on a
      // device that recorded only the retry. Dropping the legacy side's
      // synthesized first attempt would make the retry a clean first try.
      const legacy = attempt({ firstSeenAt: 100, lastAttemptedAt: 100, attempts: 1 });
      const recorded = attempt({
        firstSeenAt: 500,
        lastAttemptedAt: 500,
        attempts: 1,
        history: [ev(500)],
      });
      const merged = mergeAttempt(legacy, recorded);
      expect(merged.history).toEqual([ev(100, 'mistake'), ev(500)]);
      expect(merged.attempts).toBe(2);
      expect(mergeAttempt(recorded, legacy)).toEqual(merged);
      expect(mergeAttempt(merged, legacy)).toEqual(merged);
      expect(mergeAttempt(attempt(), attempt()).history).toBeUndefined();
    });

    it('does not duplicate a legacy first attempt the other side already seeded', () => {
      // `recordAttempt` seeds a legacy row's history from the same synthesis,
      // so the retry's row and the untouched legacy copy share that event.
      const legacy = attempt({ firstSeenAt: 100, lastAttemptedAt: 100, attempts: 1 });
      const retried = attempt({
        firstSeenAt: 100,
        lastAttemptedAt: 500,
        attempts: 2,
        history: [ev(100, 'mistake'), ev(500)],
      });
      expect(mergeAttempt(legacy, retried).history).toEqual(retried.history);
      expect(attemptDiffers(retried, mergeAttempt(legacy, retried))).toBe(false);
    });

    it('keeps puzzle content that only one side has', () => {
      const content = { fen: '8/8/8/8/8/8/8/K6k w - - 0 1', solution: ['a1a2'], themes: ['fork'] };
      // The newer row lacks content (a legacy row touched on another device);
      // content is immutable, so the older side's copy must survive.
      const old = attempt({ lastAttemptedAt: 1_000, ...content });
      const fresh = attempt({ lastAttemptedAt: 9_000 });
      for (const merged of [mergeAttempt(old, fresh), mergeAttempt(fresh, old)]) {
        expect(merged.fen).toBe(content.fen);
        expect(merged.solution).toEqual(content.solution);
        expect(merged.themes).toEqual(content.themes);
      }
    });

    it('is commutative and idempotent including history and content', () => {
      const a = attempt({
        attempts: 2,
        lastAttemptedAt: 500,
        history: [ev(100, 'mistake'), ev(500)],
        fen: '8/8/8/8/8/8/8/K6k w - - 0 1',
        solution: ['a1a2'],
        themes: ['pin'],
      });
      const b = attempt({ attempts: 3, lastAttemptedAt: 900, history: [ev(100, 'mistake'), ev(700, 'hint'), ev(900)] });
      const ab = mergeAttempt(a, b);
      expect(ab).toEqual(mergeAttempt(b, a));
      expect(mergeAttempt(ab, a)).toEqual(ab);
      expect(mergeAttempt(ab, b)).toEqual(ab);
    });
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

  it('notices a change in only the history or the content', () => {
    const base = attempt({ history: [{ at: 1_000, outcome: 'mistake' }] });
    expect(
      attemptDiffers(base, { ...base, history: [...base.history!, { at: 2_000, outcome: 'clean' }] }),
    ).toBe(true);
    expect(attemptDiffers(base, { ...base, history: [{ at: 1_000, outcome: 'hint' }] })).toBe(true);
    expect(attemptDiffers(base, { ...base, fen: '8/8/8/8/8/8/8/K6k w - - 0 1' })).toBe(true);
    // A structurally equal copy is not a change.
    expect(attemptDiffers(base, { ...base, history: [{ at: 1_000, outcome: 'mistake' }] })).toBe(false);
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

describe('rebaseAttemptWrite', () => {
  // The read the plan came from, the cloud's row, and the planned local write.
  const read = attempt({
    attempts: 1,
    lastAttemptedAt: 2_000,
    history: [{ at: 2_000, outcome: 'mistake' }],
  });
  const remote = attempt({
    hintUsed: true,
    attempts: 2,
    lastAttemptedAt: 3_000,
    history: [{ at: 3_000, outcome: 'hint' }, { at: 1_500, outcome: 'mistake' }],
  });
  const [planned] = diffAttempts([read], [remote]).writeLocal;

  it('is the planned row when nothing raced', () => {
    expect(rebaseAttemptWrite(read, planned)).toEqual(planned);
    expect(rebaseAttemptWrite(undefined, planned)).toEqual(planned);
  });

  it('keeps an attempt recorded between the read and the write', () => {
    // A clean solve committed while the manifest was in flight.
    const current: PuzzleAttempt = {
      ...read,
      attempts: 2,
      solvedClean: true,
      lastAttemptedAt: 4_000,
      rating: 1510,
      history: [...read.history!, { at: 4_000, outcome: 'clean' }],
    };
    const written = rebaseAttemptWrite(current, planned);
    expect(planned.solvedClean, 'the stale plan would have erased it').toBe(false);
    expect(written.solvedClean).toBe(true);
    expect(written.lastAttemptedAt).toBe(4_000);
    expect(written.rating).toBe(1510);
    expect(written.history?.map((e) => e.at)).toEqual([1_500, 2_000, 3_000, 4_000]);
    // …and the remote's contribution is still there.
    expect(written.hintUsed).toBe(true);
    expect(written.attempts).toBe(4);
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

/* =======================================================================
 *  toCloudAnalysis — the pushed row must carry every field the manifest reads
 * =======================================================================
 */

describe('toCloudAnalysis', () => {
  const analysis: Analysis = {
    gameId: 'g1',
    depth: 18,
    analyzedAt: 900,
    engine: 'stockfish-16-nnue',
    moves: [],
  };

  it('writes the evaluator into its own column', () => {
    expect(toCloudAnalysis('u1', analysis).engine).toBe('stockfish-16-nnue');
  });

  it('writes the rules vintage into its own column, null when unknown', () => {
    expect(toCloudAnalysis('u1', { ...analysis, recomputeVersion: 2 }).recompute_version)
      .toBe(2);
    // Explicitly null rather than omitted: the column has to be *written*, or
    // an upsert leaves whatever was there and the manifest reads a stale value.
    expect(toCloudAnalysis('u1', analysis).recompute_version).toBeNull();
  });

  it('round-trips a stamped row as a fixed point too', () => {
    // The failure this guards is silent and permanent: drop
    // `recompute_version` from the pushed row and a stamped local analysis
    // reads back as vintage 0, so it outranks the cloud copy on every single
    // sync and re-pushes the entire library forever.
    const stamped: Analysis = { ...analysis, recomputeVersion: 2 };
    const row = toCloudAnalysis('u1', stamped);
    const plan = diffAnalyses({
      local: [
        {
          gameId: 'g1',
          depth: 18,
          analyzedAt: 900,
          engine: 'stockfish-16-nnue',
          recomputeVersion: 2,
        },
      ],
      remote: [
        {
          game_id: row.game_id,
          depth: row.depth,
          analyzed_at: row.analyzed_at,
          engine: row.engine,
          recompute_version: row.recompute_version,
        },
      ],
      localGameStatus: new Map([['g1', 'done' as AnalysisStatus]]),
      localGameIds: new Set(['g1']),
      localRequeuedAt: new Map(),
    });
    expect(plan).toEqual({ push: [], pull: [] });
  });

  it('round-trips through diffAnalyses as a fixed point', () => {
    // The manifest reads the `engine` COLUMN, never the payload, and the
    // evaluator ranks above depth. Drop the column and this very row reads
    // back as classical: the diff would re-push every analysis on every sync.
    const row = toCloudAnalysis('u1', analysis);
    const plan = diffAnalyses({
      local: [{ gameId: 'g1', depth: 18, analyzedAt: 900, engine: 'stockfish-16-nnue' }],
      remote: [{ game_id: row.game_id, depth: row.depth, analyzed_at: row.analyzed_at, engine: row.engine }],
      localGameStatus: new Map([['g1', 'done' as AnalysisStatus]]),
      localGameIds: new Set(['g1']),
      localRequeuedAt: new Map(),
    });
    expect(plan).toEqual({ push: [], pull: [] });
  });
});
