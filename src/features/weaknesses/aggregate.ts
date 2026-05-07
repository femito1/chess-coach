import type { Analysis, Game, Motif, MoveEval, Phase } from '@/db/schema';
import { MOTIF_ORDER } from '@/engine/motifs';

/**
 * Game shape consumed by the aggregator. Excludes `pgn` so callers can
 * pass either the full `Game` or the light projection (`GameLight`).
 * The aggregator never reads PGN — it only joins game metadata against
 * the `analyses` table.
 */
export type GameForAggregation = Omit<Game, 'pgn'>;

export interface MistakeRow {
  gameId: string;
  gameUrl?: string;
  gameDate: number;
  opponent: string;
  result: Game['result'];
  userColor: 'white' | 'black';
  opening?: string;
  eco?: string;
  ply: number;
  san: string;
  classification: MoveEval['classification'];
  motifs: Motif[];
  phase?: Phase;
  /** Remaining clock AFTER this move (seconds), for mover. */
  clockAfter?: number;
  /** Opponent's estimate of "time pressure" for the player: either the
   *  player's clock was < 20% of base, or < 15s absolute. */
  inTimeTrouble: boolean;
  winrateDrop: number;
  /** Accuracy (0-100). */
  moveAccuracy: number;
  bestMoveSan?: string;
}

export interface Aggregates {
  totalMistakes: number;
  byMotif: { motif: Motif; count: number; examples: MistakeRow[] }[];
  byPhase: Record<Phase, { count: number; avgDrop: number }>;
  byTimePressure: {
    inTrouble: { count: number; mistakes: number; rate: number };
    normal: { count: number; mistakes: number; rate: number };
  };
  byOpening: { opening: string; games: number; mistakes: number; avgAcc: number }[];
  byTimeClass: { timeClass: string; games: number; avgAcc: number }[];
  recurringSquares: { square: string; count: number }[];
}

const BLUNDERY = new Set<MoveEval['classification']>([
  'blunder',
  'mistake',
  'miss',
  'inaccuracy',
]);

function inTimeTroubleFor(m: MoveEval, baseSeconds: number | undefined): boolean {
  if (m.clockAfter == null) return false;
  if (m.clockAfter < 15) return true;
  if (baseSeconds && baseSeconds > 0 && m.clockAfter < baseSeconds * 0.2) return true;
  return false;
}

function baseOf(tc: string | undefined): number | undefined {
  if (!tc) return undefined;
  const main = tc.split('+')[0];
  const n = Number(main);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Build the flat list of MistakeRows across all analyzed games where the
 * user was the mover. Downstream stats all derive from this list.
 */
export function buildMistakes(
  games: ReadonlyArray<GameForAggregation>,
  analyses: Map<string, Analysis>,
): MistakeRow[] {
  const rows: MistakeRow[] = [];
  for (const g of games) {
    const a = analyses.get(g.id);
    if (!a) continue;
    const base = baseOf(g.timeControl);
    for (const m of a.moves) {
      const moverColor = m.ply % 2 === 1 ? 'white' : 'black';
      if (moverColor !== g.userColor) continue;
      if (!BLUNDERY.has(m.classification)) continue;
      const drop = Math.max(0, m.winrateBefore - m.winrateAfter);
      rows.push({
        gameId: g.id,
        gameUrl: g.url,
        gameDate: g.endTime,
        opponent: g.opponent,
        result: g.result,
        userColor: g.userColor,
        opening: g.opening,
        eco: g.eco,
        ply: m.ply,
        san: m.san,
        classification: m.classification,
        motifs: m.motifs ?? [],
        phase: m.phase,
        clockAfter: m.clockAfter,
        inTimeTrouble: inTimeTroubleFor(m, base),
        winrateDrop: drop,
        moveAccuracy: 100 - drop * 100,
        bestMoveSan: m.bestMoveSan,
      });
    }
  }
  return rows;
}

export function aggregateMistakes(
  games: ReadonlyArray<GameForAggregation>,
  analyses: Map<string, Analysis>,
): Aggregates {
  const rows = buildMistakes(games, analyses);

  // --- by motif --------------------------------------------------------
  const motifCounts = new Map<Motif, MistakeRow[]>();
  for (const r of rows) {
    for (const motif of r.motifs) {
      if (!motifCounts.has(motif)) motifCounts.set(motif, []);
      motifCounts.get(motif)!.push(r);
    }
  }
  const byMotif = MOTIF_ORDER
    .filter((m) => motifCounts.has(m))
    .map((m) => ({
      motif: m,
      count: motifCounts.get(m)!.length,
      examples: [...motifCounts.get(m)!]
        .sort((a, b) => b.winrateDrop - a.winrateDrop)
        .slice(0, 5),
    }));

  // --- by phase --------------------------------------------------------
  const byPhase: Aggregates['byPhase'] = {
    opening: { count: 0, avgDrop: 0 },
    middlegame: { count: 0, avgDrop: 0 },
    endgame: { count: 0, avgDrop: 0 },
  };
  const phaseDropSum: Record<Phase, number> = { opening: 0, middlegame: 0, endgame: 0 };
  for (const r of rows) {
    const p = r.phase ?? 'middlegame';
    byPhase[p].count++;
    phaseDropSum[p] += r.winrateDrop;
  }
  (Object.keys(byPhase) as Phase[]).forEach((p) => {
    const n = byPhase[p].count;
    byPhase[p].avgDrop = n > 0 ? phaseDropSum[p] / n : 0;
  });

  // --- by time-pressure -----------------------------------------------
  // Counts how often each state produces a mistake. "count" = total moves
  // by user in that state; we need analyses-full-moves to compute rate.
  let totalUserMovesInTrouble = 0;
  let totalUserMovesNormal = 0;
  for (const g of games) {
    const a = analyses.get(g.id);
    if (!a) continue;
    const base = baseOf(g.timeControl);
    for (const m of a.moves) {
      const moverColor = m.ply % 2 === 1 ? 'white' : 'black';
      if (moverColor !== g.userColor) continue;
      if (inTimeTroubleFor(m, base)) totalUserMovesInTrouble++;
      else totalUserMovesNormal++;
    }
  }
  const mistakesInTrouble = rows.filter((r) => r.inTimeTrouble).length;
  const mistakesNormal = rows.filter((r) => !r.inTimeTrouble).length;
  const byTimePressure: Aggregates['byTimePressure'] = {
    inTrouble: {
      count: totalUserMovesInTrouble,
      mistakes: mistakesInTrouble,
      rate:
        totalUserMovesInTrouble > 0 ? mistakesInTrouble / totalUserMovesInTrouble : 0,
    },
    normal: {
      count: totalUserMovesNormal,
      mistakes: mistakesNormal,
      rate: totalUserMovesNormal > 0 ? mistakesNormal / totalUserMovesNormal : 0,
    },
  };

  // --- by opening ------------------------------------------------------
  const openingAgg = new Map<
    string,
    { games: Set<string>; mistakes: number; accSum: number; accCount: number }
  >();
  for (const g of games) {
    const a = analyses.get(g.id);
    if (!a) continue;
    const key = g.opening ?? (g.eco ?? 'Unknown');
    if (!openingAgg.has(key)) {
      openingAgg.set(key, { games: new Set(), mistakes: 0, accSum: 0, accCount: 0 });
    }
    const e = openingAgg.get(key)!;
    e.games.add(g.id);
    if (g.accuracy) {
      const acc = g.userColor === 'white' ? g.accuracy.white : g.accuracy.black;
      e.accSum += acc;
      e.accCount++;
    }
  }
  for (const r of rows) {
    const key = r.opening ?? (r.eco ?? 'Unknown');
    if (!openingAgg.has(key)) {
      openingAgg.set(key, { games: new Set(), mistakes: 0, accSum: 0, accCount: 0 });
    }
    openingAgg.get(key)!.mistakes++;
  }
  const byOpening = Array.from(openingAgg.entries())
    .map(([opening, v]) => ({
      opening,
      games: v.games.size,
      mistakes: v.mistakes,
      avgAcc: v.accCount > 0 ? v.accSum / v.accCount : 0,
    }))
    .filter((x) => x.games >= 2)
    .sort((a, b) => a.avgAcc - b.avgAcc);

  // --- by time class ---------------------------------------------------
  const tcAgg = new Map<string, { games: number; accSum: number; accCount: number }>();
  for (const g of games) {
    if (!g.accuracy) continue;
    const key = g.timeClass ?? g.timeControl;
    if (!tcAgg.has(key)) tcAgg.set(key, { games: 0, accSum: 0, accCount: 0 });
    const e = tcAgg.get(key)!;
    e.games++;
    const acc = g.userColor === 'white' ? g.accuracy.white : g.accuracy.black;
    e.accSum += acc;
    e.accCount++;
  }
  const byTimeClass = Array.from(tcAgg.entries())
    .map(([timeClass, v]) => ({
      timeClass,
      games: v.games,
      avgAcc: v.accCount > 0 ? v.accSum / v.accCount : 0,
    }))
    .sort((a, b) => a.avgAcc - b.avgAcc);

  // --- recurring squares ----------------------------------------------
  // The destination square of a blunder is a surprisingly strong signal
  // for "pieces keep dying here" patterns (e.g. you always hang on f7).
  const squareCounts = new Map<string, number>();
  for (const r of rows) {
    if (r.classification !== 'blunder') continue;
    const to = r.san.match(/([a-h][1-8])/g)?.slice(-1)[0];
    if (!to) continue;
    squareCounts.set(to, (squareCounts.get(to) ?? 0) + 1);
  }
  const recurringSquares = Array.from(squareCounts.entries())
    .map(([square, count]) => ({ square, count }))
    .filter((s) => s.count >= 2)
    .sort((a, b) => b.count - a.count);

  return {
    totalMistakes: rows.length,
    byMotif,
    byPhase,
    byTimePressure,
    byOpening,
    byTimeClass,
    recurringSquares,
  };
}
