import type { Game } from '@/db/schema';

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
}

export function accuracyTrend(games: Game[]): AccuracyPoint[] {
  const pts = games
    .filter((g) => g.accuracy && g.endTime)
    .map((g) => ({
      t: g.endTime * (g.endTime < 1e12 ? 1000 : 1),
      accuracy:
        g.userColor === 'white' ? g.accuracy!.white : g.accuracy!.black,
      result: g.result,
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
