// Pin the dashboard's prep-gap card end to end: the half that unit tests
// can't reach, because it depends on IndexedDB, the openings library and a
// live Dexie query all agreeing.
//
// Three things are asserted, in order of how easily they'd rot:
//
//  1. A losing, unprepped opening produces a row. (The feature works.)
//  2. The row is labelled with the *library's* spelling, "Caro-Kann", not
//     the games' own "Caro Kann". The seeded games carry the hyphen-less
//     name that `parseOpeningFromEcoUrl` produces, so a row containing the
//     hyphen can only have come from resolving the opening out of the
//     game's moves. Without this assertion the test would pass just as
//     happily if the card echoed the raw game string, which is the whole
//     thing the two-stage design exists to avoid.
//  3. Adding that variation to a repertoire makes the row disappear with
//     no reload. This is the load-bearing one: it is what distinguishes
//     "reads the repertoire tree" from "checks whether a family
//     repertoire exists", the distinction the feature was specified on.
//
// The fixture also exercises the depth-truncation path. Its moves match
// the library's 7-ply "Advance Variation, Short Variation", which gets
// truncated to "Advance Variation" so the position checked (5 plies) is as
// coarse as the count beside it.

import { runBrowserTest, expect, appendBypass, DEFAULT_URL, pollUntil } from '../harness.mjs';

const ADVANCE_PGN = `[Event "Live Chess"]
[Site "Chess.com"]
[White "opponent"]
[Black "tester"]
[Result "1-0"]
[ECO "B12"]
[ECOUrl "https://www.chess.com/openings/Caro-Kann-Defense-Advance-Variation-4.Nf3"]

1. e4 c6 2. d4 d5 3. e5 Bf5 4. Nf3 e6 5. Be2 Nd7 6. O-O h6 1-0`;

// A second opening the user *wins* in, purely to lift the library over the
// card's minimum-games floor without adding a second gap.
const ITALIAN_PGN = `[Event "Live Chess"]
[Site "Chess.com"]
[White "tester"]
[Black "opponent"]
[Result "1-0"]
[ECO "C50"]
[ECOUrl "https://www.chess.com/openings/Italian-Game-Two-Knights-Defense"]

1. e4 e5 2. Nf3 Nc6 3. Bc4 Nf6 4. d3 Bc5 1-0`;

await runBrowserTest({
  name: 'prep-gaps',
  viewport: { width: 1280, height: 1024 },
  waitUntil: 'domcontentloaded',
  async run({ page }) {
    await page.waitForSelector('a[href="/dashboard"]', { timeout: 10_000 });

    const seeded = await page.evaluate(
      async ({ advancePgn, italianPgn }) => {
        const { db } = await import('/src/db/schema.ts');
        await db.repertoireLineStats.clear();
        await db.repertoireCards.clear();
        await db.repertoireNodes.clear();
        await db.repertoires.clear();
        await db.games.clear();

        const rows = [];
        // Six Caro-Kann Advance losses as Black: the gap.
        for (let i = 0; i < 6; i++) {
          rows.push({
            id: `ck-${i}`,
            url: `https://example.invalid/ck/${i}`,
            source: 'chesscom',
            username: 'tester',
            userColor: 'black',
            opponent: 'opponent',
            result: 'loss',
            timeControl: '600',
            timeClass: 'rapid',
            endTime: 1_700_000_000 + i * 3600,
            // Exactly what `parseOpeningFromEcoUrl` emits for this slug —
            // note the missing hyphen and the trailing move sequence.
            opening: 'Caro Kann Defense Advance Variation: 4.Nf3',
            eco: 'B12',
            pgn: advancePgn,
            importedAt: Date.now(),
            analysisStatus: 'done',
          });
        }
        // Six Italian wins as White: makes the library big enough for the
        // card to speak at all, and must not itself become a row.
        for (let i = 0; i < 6; i++) {
          rows.push({
            id: `it-${i}`,
            url: `https://example.invalid/it/${i}`,
            source: 'chesscom',
            username: 'tester',
            userColor: 'white',
            opponent: 'opponent',
            result: 'win',
            timeControl: '600',
            timeClass: 'rapid',
            endTime: 1_700_100_000 + i * 3600,
            opening: 'Italian Game Two Knights Defense',
            eco: 'C50',
            pgn: italianPgn,
            importedAt: Date.now(),
            analysisStatus: 'done',
          });
        }
        await db.games.bulkPut(rows);
        return { games: await db.games.count() };
      },
      { advancePgn: ADVANCE_PGN, italianPgn: ITALIAN_PGN },
    );
    expect(seeded.games, 'seeded 12 games').toBe(12);

    await page.goto(appendBypass(`${DEFAULT_URL}dashboard`), {
      waitUntil: 'networkidle',
    });

    // 1 + 2. The row appears, and names the opening the library's way.
    const rowText = await pollUntil(
      async () => {
        const text = await page.evaluate(() => {
          const heads = Array.from(document.querySelectorAll('div'));
          const head = heads.find((d) => d.textContent?.trim() === 'Prep gaps');
          const card = head?.closest('.card');
          return card ? (card.textContent ?? '') : '';
        });
        return {
          done: text.includes('Advance Variation'),
          value: text,
          label: `card text: ${text.slice(0, 120)}`,
        };
      },
      { timeoutMs: 20_000 },
    );

    expect(
      rowText.includes('Caro-Kann Defense: Advance Variation'),
      'row is labelled from the library, hyphen and all',
    ).toBeTruthy();
    expect(
      rowText.includes('Caro Kann Defense Advance Variation:'),
      'row does not echo the raw game string',
    ).toBeFalsy();
    expect(rowText.includes('lost 6 of 6'), 'row states the record').toBeTruthy();
    expect(
      rowText.includes('Italian'),
      'an opening you win in is not a gap',
    ).toBeFalsy();

    // 3. Prep it, and the row must retire itself — no reload.
    const prepped = await page.evaluate(async () => {
      const { db } = await import('/src/db/schema.ts');
      const { ensureFamilyRepertoire, addLineToRepertoire, getVariations } =
        await import('/src/features/openings/library.ts');
      const family = 'Caro-Kann Defense';
      const rep = await ensureFamilyRepertoire(family);
      // The 5-ply Advance line — the defining position the card checks.
      const advance = getVariations(family)
        .filter((v) => v.variation === 'Advance Variation')
        .sort((a, b) => a.plies - b.plies)[0];
      await addLineToRepertoire(rep.id, advance);
      return {
        color: rep.color,
        plies: advance.plies,
        nodes: await db.repertoireNodes.count(),
      };
    });
    expect(prepped.color, 'Caro-Kann repertoire is a Black one').toBe('black');
    expect(prepped.plies, 'defining Advance line is 5 plies').toBe(5);
    expect(prepped.nodes >= 5, 'prep wrote nodes').toBeTruthy();

    const gone = await pollUntil(
      async () => {
        const text = await page.evaluate(() => {
          const heads = Array.from(document.querySelectorAll('div'));
          const head = heads.find((d) => d.textContent?.trim() === 'Prep gaps');
          const card = head?.closest('.card');
          return card ? (card.textContent ?? '') : '';
        });
        return {
          done: !text.includes('Advance Variation'),
          value: text,
          label: `card text after prep: ${text.slice(0, 120) || '(card gone)'}`,
        };
      },
      { timeoutMs: 20_000 },
    );
    expect(
      gone.includes('Advance Variation'),
      'prepping the variation retires the row without a reload',
    ).toBeFalsy();
  },
});
