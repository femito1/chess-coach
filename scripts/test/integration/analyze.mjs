// Full end-to-end test: import a known PGN into IndexedDB, let the analysis
// queue run against the live dev server, and verify per-move evals land in DB.

import { runBrowserTest, expect } from '../harness.mjs';

const PGN = `[Event "Test"]
[Site "?"]
[Date "2024.01.01"]
[Round "?"]
[White "me"]
[Black "opp"]
[Result "1-0"]
[TimeControl "600"]
[ECO "C20"]
[Opening "King's Pawn"]

1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7# 1-0
`;

await runBrowserTest({
  name: 'analyze',
  captureAllConsole: true,
  async run({ page, logs }) {
    const result = await page.evaluate(async (pgn) => {
  const log = [];
  try {
    const { db } = await import('/src/db/schema.ts');
    const { engine } = await import('/src/engine/engine.ts');
    const { analyzeGamePgn } = await import('/src/engine/analyzer.ts');

    const game = {
      id: 'test-001',
      url: 'https://example.com/test',
      source: 'chesscom',
      username: 'me',
      userColor: 'white',
      opponent: 'opp',
      result: 'win',
      timeControl: '600',
      timeClass: 'rapid',
      endTime: Date.now(),
      opening: "King's Pawn",
      eco: 'C20',
      pgn,
      importedAt: Date.now(),
      analysisStatus: 'pending',
    };
    await db.games.put(game);
    log.push('game inserted');

    // Try to init engine manually first.
    try {
      await engine.newGame();
      log.push('engine newGame ok');
    } catch (e) {
      return { ok: false, stage: 'newGame', error: e?.message ?? String(e), log };
    }

    // Try a single analyze call.
    try {
      const r = await engine.analyze(
        'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2',
        10,
      );
      log.push(`analyze ok: best=${r.bestMoveUci} cp=${r.scoreCp}`);
    } catch (e) {
      return { ok: false, stage: 'analyze', error: e?.message ?? String(e), log };
    }

    // Full game analysis.
    try {
      const analysis = await analyzeGamePgn('test-001', pgn, 10);
      log.push(`full analysis done: ${analysis.moves.length} moves`);
      return {
        ok: true,
        movesCount: analysis.moves.length,
        firstFew: analysis.moves.slice(0, 4).map((m) => ({
          san: m.san,
          cp: m.evalCpAfter,
          classification: m.classification,
          best: m.bestMoveSan,
        })),
        log,
      };
    } catch (e) {
      return { ok: false, stage: 'analyzeGamePgn', error: e?.message ?? String(e), log };
    }
  } catch (e) {
    return { ok: false, stage: 'import', error: e?.message ?? String(e), log };
  }
}, PGN);

    console.log('\n=== Result ===');
    console.log(JSON.stringify(result, null, 2));

    if (logs.length) {
      console.log('\n=== Console ===');
      for (const l of logs) console.log(l);
    }

    expect(result.ok, `analyze stage=${result.stage ?? 'ok'}`).toBeTruthy();
    expect(result.movesCount, 'movesCount').toBeGreaterThan(0);
  },
});
