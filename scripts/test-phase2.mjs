// Phase-2 smoke test: pushes a PGN with %clk through the full analyzer,
// verifies motifs/phase/clocks land in the Analysis record, and exercises
// the aggregator + puzzle generator + repertoire store.
//
// Requires: dev server running on URL (default http://localhost:5173/).

import { chromium } from 'playwright';

const URL = process.env.URL || 'http://localhost:5173/';
const PGN = `[Event "Test"]
[Site "?"]
[Date "2024.01.01"]
[Round "?"]
[White "me"]
[Black "opp"]
[Result "1-0"]
[TimeControl "180"]
[ECO "C20"]
[Opening "King's Pawn"]

1. e4 {[%clk 0:03:00]} e5 {[%clk 0:03:00]} 2. Qh5 {[%clk 0:02:55]} Nc6 {[%clk 0:02:52]} 3. Bc4 {[%clk 0:02:50]} Nf6 {[%clk 0:02:40]} 4. Qxf7# {[%clk 0:02:47]} 1-0
`;

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
const page = await context.newPage();

const logs = [];
page.on('console', (msg) => logs.push(`[${msg.type()}] ${msg.text()}`));
page.on('pageerror', (err) =>
  logs.push(`[pageerror] ${err.message}\n${err.stack}`),
);

console.log(`→ Loading ${URL}`);
await page.goto(URL, { waitUntil: 'networkidle' });

const result = await page.evaluate(async (pgn) => {
  const log = [];
  try {
    const { db } = await import('/src/db/schema.ts');
    const { analyzeGamePgn, computeAccuracy } = await import('/src/engine/analyzer.ts');
    const { aggregateMistakes } = await import(
      '/src/features/weaknesses/aggregate.ts'
    );
    const { selectPuzzleCandidates, buildPuzzle } = await import(
      '/src/features/puzzles/generate.ts'
    );
    const {
      createRepertoire,
      addMove,
      childrenOf,
    } = await import('/src/features/repertoire/store.ts');
    const { detectPhase, extractClocks } = await import('/src/engine/phase.ts');

    // Sanity: phase/clock pure functions.
    log.push(`phase(start)=${detectPhase('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1')}`);
    const clocks = extractClocks(pgn);
    log.push(`clocks.length=${clocks.length}`);

    // Clear DB first so repeated runs don't pile up.
    await db.transaction(
      'rw',
      db.games,
      db.analyses,
      db.puzzles,
      db.repertoires,
      db.repertoireNodes,
      db.repertoireCards,
      async () => {
        await db.games.clear();
        await db.analyses.clear();
        await db.puzzles.clear();
        await db.repertoires.clear();
        await db.repertoireNodes.clear();
        await db.repertoireCards.clear();
      },
    );

    const gameId = 'phase2-test';
    const game = {
      id: gameId,
      url: 'https://example.com/phase2',
      source: 'chesscom',
      username: 'opp',
      userColor: 'black', // opp plays Black and walks into mate
      opponent: 'me',
      result: 'loss',
      timeControl: '180',
      timeClass: 'blitz',
      endTime: Date.now(),
      opening: "King's Pawn",
      eco: 'C20',
      pgn,
      importedAt: Date.now(),
      analysisStatus: 'pending',
    };
    await db.games.put(game);

    const analysis = await analyzeGamePgn(gameId, pgn, 12, undefined, undefined, {
      hasOpening: true,
      timeControl: '180',
    });
    await db.analyses.put(analysis);
    const accuracy = computeAccuracy(analysis.moves);
    await db.games.update(gameId, { accuracy, analysisStatus: 'done' });

    const motifSamples = analysis.moves
      .filter((m) => m.motifs && m.motifs.length > 0)
      .map((m) => ({ ply: m.ply, san: m.san, motifs: m.motifs, phase: m.phase }));
    log.push(`analysis moves=${analysis.moves.length}`);
    log.push(`moves with motifs=${motifSamples.length}`);
    log.push(`first-move phase=${analysis.moves[0]?.phase}`);
    log.push(`first-move clockAfter=${analysis.moves[0]?.clockAfter}`);

    // Aggregator.
    const games = await db.games.toArray();
    const analyses = new Map((await db.analyses.toArray()).map((a) => [a.gameId, a]));
    const agg = aggregateMistakes(games, analyses);

    // Puzzle generation.
    const cands = selectPuzzleCandidates(game, analysis, 100);
    const puzzles = cands
      .map((c) => buildPuzzle(game, analysis, c.ply, c.motifs))
      .filter(Boolean);
    for (const p of puzzles) await db.puzzles.put(p);

    // Repertoire round-trip.
    const rep = await createRepertoire({ name: 'Test rep', color: 'white' });
    const startFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    const added = await addMove(rep.id, startFen, 'e2e4');
    const kids = await childrenOf(rep.id, startFen);

    return {
      ok: true,
      movesCount: analysis.moves.length,
      motifSamples: motifSamples.slice(0, 3),
      phases: analysis.moves.map((m) => m.phase),
      clocksStored: analysis.moves.map((m) => m.clockAfter),
      aggregate: {
        totalMistakes: agg.totalMistakes,
        byMotif: agg.byMotif.map((m) => ({ motif: m.motif, count: m.count })),
        byPhase: {
          opening: agg.byPhase.opening.count,
          middlegame: agg.byPhase.middlegame.count,
          endgame: agg.byPhase.endgame.count,
        },
      },
      puzzleCount: puzzles.length,
      puzzleSample: puzzles[0]
        ? {
            fen: puzzles[0].fen,
            solutionSan: puzzles[0].solutionSan,
            motifs: puzzles[0].motifs,
          }
        : null,
      repertoire: {
        id: rep.id,
        rootChildren: kids.map((k) => k.moveSan),
        addedChildFen: added?.fen,
      },
      log,
    };
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e), stack: e?.stack, log };
  }
}, PGN);

console.log('\n=== Result ===');
console.log(JSON.stringify(result, null, 2));

if (!result?.ok) {
  console.log('\n=== Console ===');
  for (const l of logs) console.log(l);
}

await browser.close();
process.exit(result?.ok ? 0 : 1);
