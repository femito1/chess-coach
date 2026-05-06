// Drive a real browser session, import a few real Chess.com games, wait for
// them to analyze, and report per-move classification distribution plus any
// suspicious tags (brilliant, miss, book with non-best, unclassified moves).

import { runBrowserTest, expect, sleep } from '../harness.mjs';

const USER_CC = process.env.USER_CC || 'magnuscarlsen';
const ARCHIVE =
  process.env.ARCHIVE || 'https://api.chess.com/pub/player/magnuscarlsen/games/2024/01';
const SAMPLE = Number(process.env.SAMPLE || '3');

await runBrowserTest({
  name: 'classifications',
  async run({ page, errors }) {
    const ids = await page.evaluate(
  async ({ username, archive, sample }) => {
    const { fetchMonth } = await import('/src/api/chesscom.ts');
    const { chessComGameToGame } = await import('/src/import/importer.ts');
    const { db } = await import('/src/db/schema.ts');

    const raw = await fetchMonth(archive);
    const picked = raw
      .filter((g) => (g.rules === 'chess' || !g.rules))
      .filter((g) => g.time_class === 'rapid' || g.time_class === 'blitz')
      .slice(0, sample);

    const out = [];
    for (const cg of picked) {
      const g = chessComGameToGame(cg, username);
      g.id = 'cls-' + g.id;
      g.analysisStatus = 'pending';
      await db.games.put(g);
      out.push(g.id);
    }
    return out;
  },
      { username: USER_CC, archive: ARCHIVE, sample: SAMPLE },
    );

    console.log(`Imported ${ids.length} games, waiting for analysis…`);
    expect(ids.length, 'imported at least one Chess.com game').toBeGreaterThan(0);

    const start = Date.now();
    let last = '';
    while (Date.now() - start < 15 * 60 * 1000) {
      const statuses = await page.evaluate(async (ids) => {
        const { db } = await import('/src/db/schema.ts');
        const rows = await Promise.all(ids.map((id) => db.games.get(id)));
        return rows.map((g) => g?.analysisStatus ?? 'missing');
      }, ids);
      const key = statuses.join(',');
      if (key !== last) {
        console.log(new Date().toISOString(), key);
        last = key;
      }
      if (statuses.every((s) => s === 'done' || s === 'error')) break;
      await sleep(2500);
    }

    const reports = await page.evaluate(async (ids) => {
  const { db } = await import('/src/db/schema.ts');
  const out = [];
  for (const id of ids) {
    const g = await db.games.get(id);
    const a = await db.analyses.get(id);
    if (!g || !a) {
      out.push({ id, missing: true });
      continue;
    }
    const counts = {};
    for (const m of a.moves) {
      counts[m.classification] = (counts[m.classification] ?? 0) + 1;
    }
    const unclassified = a.moves.filter((m) => !m.classification).length;
    const brilliants = a.moves
      .filter((m) => m.classification === 'brilliant')
      .map((m) => ({
        ply: m.ply,
        san: m.san,
        uci: m.uci,
        bestUci: m.bestMoveUci,
        winBefore: +m.winrateBefore.toFixed(3),
        winAfter: +m.winrateAfter.toFixed(3),
        fenBefore: m.fenBefore,
      }));
    const bookMoves = a.moves
      .filter((m) => m.classification === 'book')
      .map((m) => ({
        ply: m.ply,
        san: m.san,
        uci: m.uci,
        bestUci: m.bestMoveUci,
        isBest: m.bestMoveUci === m.uci,
      }));
    const misses = a.moves
      .filter((m) => m.classification === 'miss')
      .map((m) => ({
        ply: m.ply,
        san: m.san,
        winBefore: +m.winrateBefore.toFixed(3),
        winAfter: +m.winrateAfter.toFixed(3),
        drop: +(m.winrateBefore - m.winrateAfter).toFixed(3),
      }));
    out.push({
      id,
      status: g.analysisStatus,
      error: g.analysisError,
      opening: g.opening,
      eco: g.eco,
      accuracy: g.accuracy,
      totalMoves: a.moves.length,
      counts,
      unclassified,
      brilliants,
      bookMoves: bookMoves.slice(0, 15),
      bookWithNonBest: bookMoves.filter((b) => !b.isBest),
      misses,
    });
  }
  return out;
}, ids);

    console.log('\n=== Report ===\n');
    for (const r of reports) {
      console.log(JSON.stringify(r, null, 2));
      console.log('---');
    }

    if (errors.length) {
      console.log('\n=== Browser errors ===');
      for (const e of errors) console.log(e);
    }

    // Sanity: every analyzed game should have classified moves.
    for (const r of reports) {
      if (r.missing) continue;
      expect(r.unclassified, `${r.id}: unclassified move count`).toBe(0);
    }
  },
});
