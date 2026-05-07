import type { Game } from '@/db/schema';
import {
  baseSecondsFromTimeControl,
  extractClocks,
  deriveTimeSpent,
} from '@/engine/phase';

/**
 * Game shape consumed by `ratingTrend` / `accuracyTrend` /
 * `winRateByOpening`. Excludes `pgn` so callers can pass either the
 * full `Game` row or the lightweight projection
 * (`GameLight` from `db/queries.ts`) without a cast. None of these
 * functions touch the move list, so removing the field from the type
 * is purely a documentation + safety win.
 */
export type GameForCharts = Omit<Game, 'pgn'>;

/**
 * Split an opening name into its family prefix (everything before the
 * first colon). Matches the split used by the openings library, so the
 * bar chart family names line up with the library and repertoire picker.
 */
export function openingFamily(name: string | undefined): string {
  if (!name) return 'Unknown';
  const idx = name.indexOf(':');
  return (idx < 0 ? name : name.slice(0, idx)).trim() || 'Unknown';
}

export interface RatingPoint {
  /** Epoch ms. */
  t: number;
  /** User's rating after this game. */
  rating: number;
  /** Chess.com time class — we render one series per class. */
  timeClass: string;
}

export function ratingTrend(games: ReadonlyArray<GameForCharts>): RatingPoint[] {
  const out: RatingPoint[] = [];
  for (const g of games) {
    if (!g.userRating || !g.endTime) continue;
    out.push({
      t: g.endTime * (g.endTime < 1e12 ? 1000 : 1), // tolerate sec vs ms
      rating: g.userRating,
      timeClass: g.timeClass ?? 'other',
    });
  }
  return out.sort((a, b) => a.t - b.t);
}

export interface AccuracyPoint {
  t: number;
  accuracy: number;
  /** Rolling 20-game mean centered on t; undefined until we have enough. */
  rolling?: number;
  result: Game['result'];
  timeClass: string;
}

/**
 * Per-game accuracy series sorted by end time. If `timeClassFilter` is
 * provided and not 'all', games of other time classes are dropped before
 * the rolling-mean is computed (so the rolling line follows only that
 * mode's data, not a contaminated mix).
 */
export function accuracyTrend(
  games: ReadonlyArray<GameForCharts>,
  timeClassFilter: string = 'all',
): AccuracyPoint[] {
  const pts = games
    .filter((g) => g.accuracy && g.endTime)
    .filter((g) => timeClassFilter === 'all' || (g.timeClass ?? 'other') === timeClassFilter)
    .map((g) => ({
      t: g.endTime * (g.endTime < 1e12 ? 1000 : 1),
      accuracy:
        g.userColor === 'white' ? g.accuracy!.white : g.accuracy!.black,
      result: g.result,
      timeClass: g.timeClass ?? 'other',
    }))
    .sort((a, b) => a.t - b.t);

  // Rolling mean over the last 20 games.
  const window = 20;
  const out: AccuracyPoint[] = [];
  const buf: number[] = [];
  for (const p of pts) {
    buf.push(p.accuracy);
    if (buf.length > window) buf.shift();
    const rolling =
      buf.length >= Math.min(5, window)
        ? buf.reduce((a, b) => a + b, 0) / buf.length
        : undefined;
    out.push({ ...p, rolling });
  }
  return out;
}

export interface OpeningBar {
  family: string;
  games: number;
  wins: number;
  draws: number;
  losses: number;
  winRate: number;
}

/**
 * Game shape for `totalSecondsPlayed`. Accepts both the full `Game`
 * (with PGN) and the lightweight projection (`GameLight`, no PGN). When
 * `pgn` is absent we rely entirely on the cached `userTimeSec` /
 * `userPlyCount` fields populated at analysis time; that's the steady-
 * state path on the dashboard.
 */
export type GameForTimeStats = Pick<
  Game,
  | 'timeClass'
  | 'timeControl'
  | 'userColor'
  | 'userTimeSec'
  | 'userPlyCount'
> & { pgn?: string };

/**
 * Compute the user's seconds played + ply count for a single game.
 * Pure, side-effect-free, exported so the analyzer can stamp these onto
 * the `Game` row at analysis-completion time and the boot-time
 * backfill can populate them for legacy rows. Returns `undefined` for
 * `userTimeSec` when the game has no usable signal (so the cache
 * faithfully represents "we tried and got nothing" rather than
 * conflating with "never computed").
 *
 * The strategy mirrors what `totalSecondsPlayed` used to do inline:
 *   1. Daily / correspondence are excluded entirely.
 *   2. Prefer `%clk` from the PGN when present.
 *   3. Fall back to a base-time heuristic (half base + per-move offset,
 *      capped at 2× base) for clockless rapid/blitz/bullet games.
 */
export function computeUserTimeStats(g: {
  timeClass?: string;
  timeControl: string;
  userColor: 'white' | 'black';
  pgn: string;
}): { userTimeSec: number | undefined; userPlyCount: number } {
  const ply = countPlyFromPgn(g.pgn);

  if (g.timeClass === 'daily') {
    return { userTimeSec: undefined, userPlyCount: ply };
  }

  const clocks = extractClocks(g.pgn);
  const base = baseSecondsFromTimeControl(g.timeControl);

  if (clocks.length > 0) {
    const spent = deriveTimeSpent(clocks, base);
    let sumW = 0;
    let sumB = 0;
    for (let i = 0; i < spent.length; i++) {
      const s = spent[i];
      if (typeof s !== 'number' || !Number.isFinite(s) || s < 0) continue;
      if (i % 2 === 0) sumW += s;
      else sumB += s;
    }
    const userSum = g.userColor === 'white' ? sumW : sumB;
    if (userSum > 0) {
      return { userTimeSec: userSum, userPlyCount: ply };
    }
  }

  if (typeof base === 'number' && base > 0 && base < 2 * 60 * 60) {
    const userPly = Math.ceil(ply / 2);
    const guess = Math.min(base * 2, base * 0.5 + userPly * 2);
    return { userTimeSec: guess, userPlyCount: ply };
  }

  return { userTimeSec: undefined, userPlyCount: ply };
}

/**
 * Estimate the total seconds the user has spent playing across the
 * given games.
 *
 * Hot path: read the cached `userTimeSec` field if present (populated by
 * the analyzer / boot-time backfill). Slow path: fall back to parsing
 * `%clk` from the PGN — this only fires for unanalyzed games, the
 * one-shot grace window between v9 deploy and the backfill completing,
 * and tests that pass synthetic data without the cached fields. The
 * fallback is intentionally identical to the original implementation so
 * displayed numbers are unchanged before/after caching.
 *
 * Daily / correspondence games are excluded regardless of clock
 * availability (their `timeControl` of "1/86400" doesn't reflect actual
 * think time).
 */
export function totalSecondsPlayed(games: ReadonlyArray<GameForTimeStats>): number {
  let totalSec = 0;
  for (const g of games) {
    if (g.timeClass === 'daily') continue;

    // Hot path: cached value populated at analysis time. We treat
    // `userTimeSec === undefined` differently from `userTimeSec === 0`:
    //   - `undefined` means "we never tried to compute" (pre-backfill)
    //     OR "we tried and got no usable signal" (no clocks + no base).
    //     For pre-backfill rows we'd ideally fall through to the PGN
    //     path; for genuine-no-signal rows we just want to skip. We
    //     distinguish by checking PGN availability: if PGN is absent
    //     the row came from a light projection, so we *can't* fall
    //     through and we just skip — matching the v9 steady state.
    //   - `0` would only happen if a game genuinely had zero seconds
    //     of think time (impossible in practice; treat as skip).
    if (typeof g.userTimeSec === 'number') {
      if (g.userTimeSec > 0) totalSec += g.userTimeSec;
      continue;
    }
    if (!g.pgn) {
      // Light projection without a cached value — pre-backfill row.
      // Skip; the backfill will populate it shortly. Better to under-
      // count for one boot than to pull every PGN onto the dashboard.
      continue;
    }

    const stats = computeUserTimeStats({
      timeClass: g.timeClass,
      timeControl: g.timeControl,
      userColor: g.userColor,
      pgn: g.pgn,
    });
    if (typeof stats.userTimeSec === 'number') totalSec += stats.userTimeSec;
  }
  return totalSec;
}

/** Cheap upper-bound count of plies in a PGN — counts move number tokens
 *  + 1 black ply per number. Doesn't require chess.js so it stays light
 *  on the dashboard. Returns 0 when the PGN can't be parsed. */
function countPlyFromPgn(pgn: string): number {
  if (!pgn) return 0;
  // Strip header tags + comments + variations to keep the regex simple.
  const stripped = pgn
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\{[^}]*\}/g, '')
    .replace(/\([^)]*\)/g, '');
  const matches = stripped.match(/\b\d+\.+\s*\S+(\s+\S+)?/g);
  if (!matches) return 0;
  let n = 0;
  for (const m of matches) {
    n += m.split(/\s+/).filter(Boolean).length - 1; // minus the "12." token
  }
  return Math.max(n, 0);
}

export function winRateByOpening(
  games: ReadonlyArray<GameForCharts>,
  topN = 10,
): OpeningBar[] {
  const map = new Map<string, OpeningBar>();
  for (const g of games) {
    const f = openingFamily(g.opening);
    const agg = map.get(f) ?? {
      family: f,
      games: 0,
      wins: 0,
      draws: 0,
      losses: 0,
      winRate: 0,
    };
    agg.games++;
    if (g.result === 'win') agg.wins++;
    else if (g.result === 'loss') agg.losses++;
    else if (g.result === 'draw') agg.draws++;
    map.set(f, agg);
  }
  const arr = Array.from(map.values());
  for (const a of arr) {
    // Treat draws as half a point so small-sample openings with many draws
    // aren't reported as 0% or 100%.
    a.winRate = a.games > 0 ? (a.wins + 0.5 * a.draws) / a.games : 0;
  }
  return arr
    .sort((a, b) => b.games - a.games)
    .slice(0, topN)
    .sort((a, b) => b.winRate - a.winRate);
}
