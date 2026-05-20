import { EngineWorker, type AnalysisResult } from './engine';

/**
 * Strength levels exposed to the user for free-play vs Stockfish.
 * Persisted in `Settings.freePlayStrength` and overridable per-session
 * on the play page itself.
 */
export type FreePlayStrength = 'max' | '2000' | '1600' | '1200';

export const FREE_PLAY_STRENGTHS: readonly FreePlayStrength[] = [
  'max',
  '2000',
  '1600',
  '1200',
] as const;

/**
 * Pure mapping from a strength level to the UCI options + search depth
 * we drive Stockfish with. Extracted so it can be unit-tested without a
 * worker.
 *
 * - `limitStrength=false` is Stockfish at full strength; `Skill Level`
 *   is ignored in that mode but we still set a sane value (20) so a
 *   later mode-flip into limit-strength has a deterministic baseline.
 * - "2000" / "1600" / "1200" use `UCI_LimitStrength=true` with a Skill
 *   Level mapped to roughly that Elo, plus a shallower search so the
 *   weaker engine doesn't accidentally find best moves anyway via
 *   raw depth. Stockfish's `UCI_Elo` parameter would be more direct
 *   but isn't exposed by every NNUE build; Skill Level + capped depth
 *   is the portable path.
 *
 * Unknown levels fall back to `'max'` so a corrupted Settings row or
 * an out-of-range cloud-sync value can't softlock the page.
 */
export function strengthToOptions(level: FreePlayStrength | string | undefined): {
  level: FreePlayStrength;
  limitStrength: boolean;
  skill: number;
  depth: number;
} {
  switch (level) {
    case '2000':
      return { level: '2000', limitStrength: true, skill: 15, depth: 10 };
    case '1600':
      return { level: '1600', limitStrength: true, skill: 10, depth: 8 };
    case '1200':
      return { level: '1200', limitStrength: true, skill: 5, depth: 6 };
    case 'max':
    default:
      return { level: 'max', limitStrength: false, skill: 20, depth: 14 };
  }
}

/**
 * Singleton free-play worker. Kept separate from the singleton review
 * `engine` so the live-eval consumer (which classifies the user's
 * move) doesn't fight the opponent move-search for the same worker.
 * Stockfish builds are single-threaded per worker; sharing one would
 * serialize "find user's eval" and "pick opponent reply" into a
 * noticeable stutter between every ply.
 */
const opponentEngine = new EngineWorker();

/** Track the last applied strength so we don't re-issue the option
 *  commands on every move (cheap, but pointless). */
let appliedLevel: FreePlayStrength | null = null;

async function applyStrength(level: FreePlayStrength): Promise<void> {
  if (appliedLevel === level) return;
  const opts = strengthToOptions(level);
  await opponentEngine.setOption('UCI_LimitStrength', opts.limitStrength);
  await opponentEngine.setOption('Skill Level', opts.skill);
  appliedLevel = level;
}

/**
 * Pick Stockfish's reply at the requested strength. Returns the UCI
 * (e.g. `e2e4`, `g7g8q`) or null if the position is terminal.
 *
 * Concurrent callers are serialised on a per-module promise chain.
 * When React StrictMode (dev only) double-mounts the effect that
 * drives the opponent loop, both invocations call `pickEngineMove` in
 * quick succession with the SAME fen and strength. If we let them
 * both hit `analyze` in parallel, one cancels the other on the
 * underlying singleton worker — and the cancelled one is the one
 * whose React effect token matches the latest mount, so its rejection
 * surfaces as a `cancelled` error and no Stockfish reply ever lands
 * on the board. By chaining calls so the second waits for the first
 * to settle, both invocations resolve cleanly to the same bestmove.
 * The first call's result is discarded by the React effect's stale-
 * token guard; the second commits onto the board. The added latency
 * is at most one duplicate search (~100-300ms at depth 14 with the
 * NNUE net warm), which is invisible to the user.
 */
let inflight: Promise<unknown> = Promise.resolve();

export async function pickEngineMove(
  fen: string,
  level: FreePlayStrength,
): Promise<string | null> {
  const opts = strengthToOptions(level);
  // Wait for any in-flight pickEngineMove to settle before issuing
  // ours. Errors in the prior call are swallowed here — the prior
  // call's caller already received them.
  const prior = inflight.catch(() => undefined);
  const next = (async () => {
    await prior;
    await applyStrength(opts.level);
    const res: AnalysisResult = await opponentEngine.analyze(fen, opts.depth);
    return res.bestMoveUci;
  })();
  inflight = next;
  return next;
}

/**
 * Best-effort idle teardown. Mirrors `terminateEngineIfIdle` for the
 * review-page worker — the runner unmount-hook calls this so leaving
 * the practice page frees the WASM heap. The worker rehydrates lazily
 * on the next `pickEngineMove` call.
 */
export function terminateFreePlayEngineIfIdle(): boolean {
  if (opponentEngine.isBusy()) return false;
  opponentEngine.terminate();
  appliedLevel = null;
  return true;
}
