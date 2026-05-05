import type { Game } from '@/db/schema';
import {
  baseSecondsFromTimeControl,
  extractClocks,
  deriveTimeSpent,
} from '@/engine/phase';

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

export function ratingTrend(games: Game[]): RatingPoint[] {
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
  games: Game[],
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
 * Estimate the total seconds the user has spent playing across the
 * given games. Strategy, in order of preference:
 *
 *   1. If the PGN has `%clk` annotations, derive per-move time spent and
 *      sum it. This is the most accurate — it's the actual wall-clock
 *      time the user spent on the board, not the time control budget.
 *   2. Otherwise, fall back to a rough estimate: half the base time
 *      control, capped at twice the base time. Caps avoid daily / 24h
 *      games inflating the total to absurd numbers when the player
 *      actually only spent a few minutes thinking.
 *   3. Games with no usable signal are skipped.
 *
 * Returns total seconds. Daily / correspondence games are excluded
 * regardless of clock availability (their `timeControl` is e.g. "1/86400"
 * meaning "one move per day", which is meaningless for time-played).
 */
export function totalSecondsPlayed(games: Game[]): number {
  let totalSec = 0;
  for (const g of games) {
    if (g.timeClass === 'daily') continue;

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
      // We only care about the user's own time, not the opponent's.
      const userSum = g.userColor === 'white' ? sumW : sumB;
      if (userSum > 0) {
        totalSec += userSum;
        continue;
      }
    }

    // Fallback heuristic when there are no clocks.
    if (typeof base === 'number' && base > 0 && base < 2 * 60 * 60) {
      // Half the base + a tiny per-move offset capped at 2× base.
      const ply = countPlyFromPgn(g.pgn);
      const userPly = Math.ceil(ply / 2);
      const guess = Math.min(base * 2, base * 0.5 + userPly * 2);
      totalSec += guess;
    }
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

export function winRateByOpening(games: Game[], topN = 10): OpeningBar[] {
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
