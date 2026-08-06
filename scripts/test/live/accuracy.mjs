// Pull several real Chess.com games that have `accuracies` reported, analyze
// them locally, and compare our computed accuracy to Chess.com's. Also checks
// that opening metadata is extracted correctly.

import { runBrowserTest, expect, sleep } from '../harness.mjs';

const USER_CC = process.env.USER_CC || 'magnuscarlsen';
const ARCHIVE = process.env.ARCHIVE || 'https://api.chess.com/pub/player/magnuscarlsen/games/2024/01';
const SAMPLE_SIZE = Number(process.env.SAMPLE || '5');

await runBrowserTest({
  name: 'accuracy',
  async run({ page, errors }) {
    const prepared = await page.evaluate(
  async ({ username, archive, sample }) => {
    const { fetchMonth } = await import('/src/api/chesscom.ts');
    const { chessComGameToGame } = await import('/src/import/importer.ts');
    const { db } = await import('/src/db/schema.ts');

    const raw = await fetchMonth(archive);
    const candidates = raw
      .filter((g) => (g.rules === 'chess' || !g.rules) && g.accuracies)
      .filter((g) => g.time_class === 'rapid' || g.time_class === 'blitz')
      .slice(0, sample);

    const ids = [];
    for (const cg of candidates) {
      const game = chessComGameToGame(cg, username);
      game.id = 'acc-' + game.id;
      // Force fresh re-analysis.
      await db.games.put(game);
      ids.push(game.id);
    }
    return {
      ids,
      meta: candidates.map((cg, i) => ({
        id: ids[i],
        chessComAcc: cg.accuracies,
        opening: cg.opening,
        url: cg.url,
      })),
    };
  },
      { username: USER_CC, archive: ARCHIVE, sample: SAMPLE_SIZE },
    );

    console.log(`Prepared ${prepared.ids.length} games`);
    expect(prepared.ids.length, `candidate games found in ${ARCHIVE}`).toBeGreaterThan(0);

    const start = Date.now();
    let last = '';
    while (Date.now() - start < 600_000) {
      const statuses = await page.evaluate(async (ids) => {
        const { db } = await import('/src/db/schema.ts');
        const rows = await Promise.all(ids.map((id) => db.games.get(id)));
        return rows.map((g) => g?.analysisStatus);
      }, prepared.ids);
      const key = statuses.join(',');
      if (key !== last) {
        console.log(new Date().toISOString(), key);
        last = key;
      }
      if (statuses.every((s) => s === 'done' || s === 'error')) break;
      await sleep(2000);
    }

    const final = await page.evaluate(async ({ ids, meta }) => {
      const { db } = await import('/src/db/schema.ts');
      const { computeAccuracyWithModel } = await import('/src/engine/analyzer.ts');
      const metaById = new Map(meta.map((entry) => [entry.id, entry]));
      const models = {
        legacy: { includeBook: true, floor: 20 },
        calibrated: { includeBook: false, floor: 20, gapMultiplier: 1.5 },
        noBookFloor20: { includeBook: false, floor: 20 },
        noBookFloor10: { includeBook: false, floor: 10 },
        noBookFloor5: { includeBook: false, floor: 5 },
        noBookNoFloor: { includeBook: false, floor: 0 },
        noBookFloor20Gap125: { includeBook: false, floor: 20, gapMultiplier: 1.25 },
        noBookFloor20Gap150: { includeBook: false, floor: 20, gapMultiplier: 1.5 },
        noBookGap125: { includeBook: false, floor: 10, gapMultiplier: 1.25 },
        noBookGap150: { includeBook: false, floor: 10, gapMultiplier: 1.5 },
        noBookGap175: { includeBook: false, floor: 10, gapMultiplier: 1.75 },
        noBookGap200: { includeBook: false, floor: 10, gapMultiplier: 2 },
      };
      const out = [];
      for (const id of ids) {
        const g = await db.games.get(id);
        const analysis = await db.analyses.get(id);
        const candidates = {};
        if (analysis) {
          for (const [name, model] of Object.entries(models)) {
            candidates[name] = computeAccuracyWithModel(analysis.moves, model);
          }
        }
        out.push({
          id,
          status: g?.analysisStatus,
          error: g?.analysisError,
          opening: g?.opening,
          eco: g?.eco,
          ours: g?.accuracy,
          chessCom: metaById.get(id)?.chessComAcc,
          candidates,
          moveCount: analysis?.moves?.length ?? 0,
        });
      }
      return out;
    }, { ids: prepared.ids, meta: prepared.meta });

console.log('\n=== Results ===');
let n = 0;
const metrics = new Map();
for (const r of final) {
  console.log(
    JSON.stringify({
      id: r.id,
      status: r.status,
      error: r.error,
      opening: r.opening,
      eco: r.eco,
      ours: r.ours,
      chessCom: r.chessCom,
      candidates: r.candidates,
    }),
  );
  if (r.status === 'done' && r.ours && r.chessCom) {
    n++;
    for (const [name, score] of Object.entries(r.candidates)) {
      const metric = metrics.get(name) ?? {
        absoluteError: 0,
        signedError: 0,
        samples: 0,
      };
      for (const color of ['white', 'black']) {
        const error = score[color] - r.chessCom[color];
        metric.absoluteError += Math.abs(error);
        metric.signedError += error;
        metric.samples++;
      }
      metrics.set(name, metric);
    }
  }
}
    if (n > 0) {
      console.log(`\n=== Calibration (${n} games / ${n * 2} color scores) ===`);
      for (const [name, metric] of metrics) {
        console.log(
          `${name}: MAE=${(metric.absoluteError / metric.samples).toFixed(2)}, ` +
            `signed bias=${(metric.signedError / metric.samples).toFixed(2)}`,
        );
      }
    }

    if (errors.length) {
      console.log('\n=== Browser errors ===');
      for (const e of errors) console.log(e);
    }

    expect(n, 'at least one game produced comparable accuracy values').toBeGreaterThan(0);
  },
});
