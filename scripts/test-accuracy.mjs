// Pull several real Chess.com games that have `accuracies` reported, analyze
// them locally, and compare our computed accuracy to Chess.com's. Also checks
// that opening metadata is extracted correctly.

import { chromium } from 'playwright';

const URL = process.env.URL || 'http://localhost:5173/';
const USER_CC = process.env.USER_CC || 'magnuscarlsen';
const ARCHIVE = process.env.ARCHIVE || 'https://api.chess.com/pub/player/magnuscarlsen/games/2024/01';
const SAMPLE_SIZE = Number(process.env.SAMPLE || '5');

const browser = await chromium.launch({ headless: true });
const page = await (await browser.newContext()).newPage();

const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`[console.error] ${m.text()}`);
});

await page.goto(URL, { waitUntil: 'networkidle' });

// Pick games that have chess.com accuracies and are standard chess rapid/blitz.
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
if (!prepared.ids.length) {
  console.error('No candidate games with accuracies found in archive:', ARCHIVE);
  await browser.close();
  process.exit(2);
}

// Wait for queue to analyze all.
const start = Date.now();
let last = '';
while (Date.now() - start < 600000) {
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
  await new Promise((r) => setTimeout(r, 2000));
}

const final = await page.evaluate(async (ids) => {
  const { db } = await import('/src/db/schema.ts');
  const out = [];
  for (const id of ids) {
    const g = await db.games.get(id);
    out.push({
      id,
      status: g?.analysisStatus,
      error: g?.analysisError,
      opening: g?.opening,
      eco: g?.eco,
      ours: g?.accuracy,
      chessCom: g?.chessComAccuracy,
      moveCount: (await db.analyses.get(id))?.moves?.length ?? 0,
    });
  }
  return out;
}, prepared.ids);

console.log('\n=== Results ===');
let totalDiffW = 0;
let totalDiffB = 0;
let n = 0;
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
    }),
  );
  if (r.status === 'done' && r.ours && r.chessCom) {
    totalDiffW += Math.abs(r.ours.white - r.chessCom.white);
    totalDiffB += Math.abs(r.ours.black - r.chessCom.black);
    n++;
  }
}
if (n > 0) {
  console.log(
    `\nMean absolute error vs Chess.com: white=${(totalDiffW / n).toFixed(2)}, black=${(totalDiffB / n).toFixed(2)}`,
  );
}

if (errors.length) {
  console.log('\n=== Browser errors ===');
  errors.forEach((e) => console.log(e));
}

await browser.close();
process.exit(0);
