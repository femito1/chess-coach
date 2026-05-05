// Test accuracy on games with low chess.com accuracy (<80) so we can check
// that low-accuracy games actually come out low.

import { chromium } from 'playwright';

const URL = process.env.URL || 'http://localhost:5174/';
const TARGET_URLS = [
  'https://www.chess.com/game/live/146284294300',
  'https://www.chess.com/game/live/146313888396',
  'https://www.chess.com/game/live/159353853685',
];

async function findGame(url) {
  const parts = url.split('/');
  // Unfortunately chess.com public API doesn't expose game-by-ID, but we can scan recent months.
  const player = 'hikaru';
  const archives = (await (await fetch(`https://api.chess.com/pub/player/${player}/games/archives`)).json()).archives;
  for (const a of archives.slice(-6)) {
    const d = await (await fetch(a)).json();
    for (const g of d.games) {
      if (g.url === url) return g;
    }
  }
  return null;
}

const games = [];
for (const u of TARGET_URLS) {
  const g = await findGame(u);
  if (g) games.push(g);
}
console.log(`Found ${games.length}/${TARGET_URLS.length} target games`);

const browser = await chromium.launch({ headless: true });
const page = await (await browser.newContext()).newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

await page.goto(URL, { waitUntil: 'networkidle' });

const ids = await page.evaluate(async (raw) => {
  const { chessComGameToGame } = await import('/src/import/importer.ts');
  const { db } = await import('/src/db/schema.ts');
  const ids = [];
  for (const cg of raw) {
    const g = chessComGameToGame(cg, cg.white.username);
    g.id = 'low-' + g.id;
    g.analysisStatus = 'pending';
    await db.games.put(g);
    ids.push(g.id);
  }
  return ids;
}, games);

// Wait for completion.
const start = Date.now();
let last = '';
while (Date.now() - start < 600000) {
  const s = await page.evaluate(async (ids) => {
    const { db } = await import('/src/db/schema.ts');
    const rows = await Promise.all(ids.map((id) => db.games.get(id)));
    return rows.map((g) => g?.analysisStatus).join(',');
  }, ids);
  if (s !== last) {
    console.log(new Date().toISOString(), s);
    last = s;
  }
  if (s.split(',').every((x) => x === 'done' || x === 'error')) break;
  await new Promise((r) => setTimeout(r, 2000));
}

const final = await page.evaluate(async (ids) => {
  const { db } = await import('/src/db/schema.ts');
  const out = [];
  for (const id of ids) {
    const g = await db.games.get(id);
    const a = await db.analyses.get(id);
    out.push({
      id,
      status: g?.analysisStatus,
      ours: g?.accuracy,
      chessCom: g?.chessComAccuracy,
      moveCount: a?.moves?.length ?? 0,
      blunders: a?.moves?.filter((m) => m.classification === 'blunder').length ?? 0,
      mistakes: a?.moves?.filter((m) => m.classification === 'mistake').length ?? 0,
      inaccs: a?.moves?.filter((m) => m.classification === 'inaccuracy').length ?? 0,
      sampleWorst: a?.moves
        ?.map((m, i) => ({ ply: m.ply, san: m.san, drop: +(m.winrateBefore - m.winrateAfter).toFixed(3), cls: m.classification }))
        .sort((a,b) => b.drop - a.drop)
        .slice(0, 8),
    });
  }
  return out;
}, ids);

for (const r of final) {
  console.log('\n', JSON.stringify(r, null, 2));
}

await browser.close();
