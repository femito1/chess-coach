import type { Analysis, Game, Motif, MoveEval, Phase } from '@/db/schema';
import { MOTIF_ORDER } from '@/engine/motifs';

/**
 * Extracts the user's own mistakes from analyzed games.
 *
 * This module used to live at `src/features/weaknesses/aggregate.ts` and
 * back the Weaknesses page. That page is gone — it was a read-only report
 * that told you "you miss forks" and then left you to do something about
 * it. The *diagnosis* was the valuable half, so it moved here: it is now
 * the input to the Puzzles page's Recommended tab, which turns "you miss
 * forks" into a queue of fork puzzles at your level (`recommend.ts`).
 *
 * Two entry points, with different consumers:
 *
 *  - `buildMistakes` — the flat `MistakeRow[]`. Load-bearing: Recommended
 *    scores motifs off it.
 *  - `aggregateMistakes` — the roll-up the old page rendered. No UI reads
 *    it today; it's kept because it's the readable seam that
 *    `scripts/test/integration/phase2.mjs` uses to assert the analyzer
 *    actually writes motifs, phases and clocks into `Analysis`, and
 *    because a "your weaknesses at a glance" summary is a plausible
 *    addition to the Recommended tab.
 *
 * `MistakeRow` was trimmed to what is actually read when that page went — see
 * its own comment for the rule on adding a field back.
 */

/**
 * Game shape consumed by the aggregator. Excludes `pgn` so callers can
 * pass either the full `Game` or the light projection (`GameLight`).
 * The aggregator never reads PGN — it only joins game metadata against
 * the `analyses` table.
 */
export type GameForAggregation = Omit<Game, 'pgn'>;

/**
 * One mistake the user made, in one game.
 *
 * Carries what its consumers read, plus what identifies it, and nothing else.
 * It used to carry a great deal else — `fenBefore`, `evalCpBefore`,
 * `bestMoveUci`, `bestMoveSan`, `san`, `uci` — to draw inline mini-boards on the
 * Weaknesses page. That page is gone; its diagnosis half became the Recommended
 * tab, which scores motifs and never looks at a board. Nothing has read those
 * fields since.
 *
 * They were not merely untidy. These rows deliberately **outlive** the analyses
 * they are folded out of (`mistakeRowsForGame`), and each of those fields was a
 * string held off a move list that would otherwise be garbage — multiplied by
 * every mistake in the library. `fenBefore` alone was ~70 characters per row.
 *
 * The unread game-derived fields (`gameUrl`, `opponent`, `result`, `userColor`)
 * went too, for tidiness rather than for bytes: they were reference copies of
 * strings the caller's own game rows already keep alive, so holding them cost
 * ~nothing. But unread is unread, and each is one `gameId` lookup away.
 * `opening` and `eco` are game-derived in exactly the same way and stay only
 * because `aggregateMistakes` genuinely reads them.
 *
 * **The rule for adding one back:** a field belongs here when a consumer reads
 * it — not when a consumer might. If a "weaknesses at a glance" summary ever
 * wants the played move again, widen this and the fold in the same change;
 * `mistakeRowsForGame` has the `MoveEval` in hand, so it is one line each.
 */
export interface MistakeRow {
  /** Identity, with `ply`: which game, which move. Everything else about the
   *  game is a lookup away, which is why nothing else about it is here. */
  gameId: string;
  ply: number;
  /** When the game was played. `scoreMotifs` decays a motif's weight by the
   *  age of the mistake, so this is load-bearing for ranking, not display. */
  gameDate: number;
  /** Read by `aggregateMistakes` to bucket mistakes by opening. */
  opening?: string;
  eco?: string;
  /** What the mistake *was*, in the vocabulary Recommended turns into puzzle
   *  themes. The reason the whole pipeline exists. */
  motifs: Motif[];
  phase?: Phase;
  /** Whether the player was short of time. The mover's raw `clockAfter` is not
   *  kept beside it: this is the only form anything reads, and keeping both
   *  invites them to disagree. */
  inTimeTrouble: boolean;
  /** Winrate lost by the move, 0–1. Severity, for both scorers. */
  winrateDrop: number;
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
 * The user's own mistakes in ONE analyzed game.
 *
 * Split out of `buildMistakes` so a caller can *stream*. Every game's analysis
 * is consumed independently here — nothing in a row depends on another game —
 * so a reader walking a Dexie cursor can fold one analysis into rows and let
 * the move list go, instead of holding every analysis in the library at once.
 * That is what the Recommended tab does; see ARCHITECTURE.md § Memory on
 * mobile for why holding them was a problem.
 *
 * Deliberately pure, and this module must stay that way: it has no Dexie
 * import, which is what lets `recommend.test.ts` and friends run in the unit
 * tier (`vitest.config.ts` forbids Dexie there). The cursor lives in
 * `db/queries.ts` — `forEachAnalysis` — and calls this.
 */
export function mistakeRowsForGame(
  g: GameForAggregation,
  a: Analysis,
): MistakeRow[] {
  const rows: MistakeRow[] = [];
  const base = baseOf(g.timeControl);
  for (const m of a.moves) {
    const moverColor = m.ply % 2 === 1 ? 'white' : 'black';
    if (moverColor !== g.userColor) continue;
    if (!BLUNDERY.has(m.classification)) continue;
    const drop = Math.max(0, m.winrateBefore - m.winrateAfter);
    rows.push({
      gameId: g.id,
      ply: m.ply,
      gameDate: g.endTime,
      opening: g.opening,
      eco: g.eco,
      motifs: m.motifs ?? [],
      phase: m.phase,
      inTimeTrouble: inTimeTroubleFor(m, base),
      winrateDrop: drop,
    });
  }
  return rows;
}

/**
 * Build the flat list of MistakeRows across all analyzed games where the
 * user was the mover. Downstream stats all derive from this list.
 *
 * Takes every analysis up front, so it is only appropriate where the caller
 * already holds them — `aggregateMistakes` and its tests. A reader coming from
 * the database should stream `mistakeRowsForGame` instead.
 */
export function buildMistakes(
  games: ReadonlyArray<GameForAggregation>,
  analyses: Map<string, Analysis>,
): MistakeRow[] {
  const rows: MistakeRow[] = [];
  for (const g of games) {
    const a = analyses.get(g.id);
    if (!a) continue;
    // A loop rather than `push(...rows)`: spreading is an argument list, and
    // this one is bounded only by how badly the user played.
    for (const r of mistakeRowsForGame(g, a)) rows.push(r);
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

  return {
    totalMistakes: rows.length,
    byMotif,
    byPhase,
    byTimePressure,
    byOpening,
    byTimeClass,
  };
}
