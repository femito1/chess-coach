// Is NNUE actually on in the browser, and is it labelled honestly?
//
// The whole value of serving a 40 MB network is that evals get better, and the
// whole risk is that they *say* they got better without doing so. Both halves
// are only observable in a real browser, so both are pinned here:
//
//   1. **Stockfish itself says so.** A raw Worker driven through the same two
//      options the app sends must answer `info string NNUE evaluation …`, not
//      `info string classical evaluation enabled.` This is the ground truth; if
//      the net stopped being staged (`scripts/copy-nnue.mjs`) or stopped being
//      served, this is the assertion that notices.
//
//   2. **The numbers really change.** Same FEN, same depth, NNUE vs classical.
//      Classical calls the rook endgame roughly equal (+53 cp); NNUE calls it
//      winning (+377 cp). An engine that loaded no net would produce two
//      identical numbers and still pass assertion 1 if it lied in an info
//      string, so this is the assertion that can't be faked.
//
//   3. **`evaluatorId()` agrees with reality.** `EngineWorker`, the pool, and
//      the `Analysis.engine` stamp must all read `stockfish-16-nnue`. This is the
//      specific bug the explicit `nnueEnabled` assignment in `engine.ts` exists
//      to prevent: the `option name Use NNUE … default false` line arrives AFTER
//      our `setoption`, so inferring the field from the handshake alone
//      mislabels every NNUE analysis as classical — which then makes
//      `diff.ts#isBetter` prefer the weaker copy on sync.
//
//   4. **The opt-out works.** With the Settings toggle off, a fresh worker must
//      hand back `stockfish-16-classical`.
//
//   5. **The eval cache doesn't cross-contaminate.** Classical and NNUE rows for
//      the same (fen, depth) must be separate rows, or a warm classical cache
//      silently feeds an NNUE-labelled analysis.
//
// Run: node scripts/run-tests.mjs --only=engine-nnue

import { runBrowserTest, expect, appendBypass } from '../harness.mjs';

// The rook endgame from `scripts/worker/verify.ts`. Chosen because it is exactly
// the kind of quiet position the two evaluators disagree about; a tactical
// position would agree and prove nothing.
const ROOK_ENDGAME = '8/5R2/1p2P3/p4r2/P6p/1P3Pk1/4K3/8 b - - 1 64';
const PROBE_DEPTH = 18;

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
  name: 'engine-nnue',
  // Booting workers means networkidle never settles.
  waitUntil: 'domcontentloaded',
  skipInitialGoto: true,
  async run({ page }) {
    await page.goto(appendBypass('http://localhost:5173/'), {
      waitUntil: 'domcontentloaded',
    });
    await page.waitForSelector('a[href="/puzzles"]', { timeout: 15_000 });

    /* ------------------------------------------------------------------ */
    /*  Preflight: is the net even being served?                          */
    /* ------------------------------------------------------------------ */
    // Named separately so a missing net fails with "you didn't stage the net"
    // rather than as a baffling classical-vs-NNUE equality further down.
    const served = await page.evaluate(async () => {
      const { nnueNetUrl, nnueEvalFileValue, nnueNetIsRemote, NNUE_NET_FILE } =
        await import('/src/engine/nnue.ts');
      const res = await fetch(nnueNetUrl(), { method: 'HEAD' });
      return {
        url: nnueNetUrl(),
        file: NNUE_NET_FILE,
        evalFile: nnueEvalFileValue(),
        remote: nnueNetIsRemote(),
        status: res.status,
        bytes: Number(res.headers.get('content-length') ?? '0'),
      };
    });
    console.log('net:', JSON.stringify(served));
    expect(served.status, `HEAD ${served.url}`).toBe(200);
    expect(
      served.bytes,
      `${served.url} must be the real net, not an SPA fallback — run \`npm run nnue:stage\``,
    ).toBeAtLeast(1_000_000);

    // This whole file tests the SAME-ORIGIN path, so pin that the option value is
    // still the bare filename here. `EvalFile` gained the ability to carry a full
    // cross-origin URL for production (see `nnue-remote-net`), and the bare form
    // is not a leftover: Stockfish resolves it next to its own worker script,
    // which is the only spelling that survives a non-root Vite `base`
    // (GitHub Pages). A regression that made this absolute would keep every test
    // here green and break that deployment only.
    expect(served.remote, 'dev serves the net from its own origin').toBe(false);
    expect(served.evalFile, 'same-origin EvalFile is the bare filename').toBe(
      served.file,
    );

    /* ------------------------------------------------------------------ */
    /*  1 + 2. Ground truth: raw worker, both evaluators, same position    */
    /* ------------------------------------------------------------------ */
    const raw = await page.evaluate(
      async ({ fen, depth }) => {
        // Imported, not hardcoded, so a net rename can't leave this test
        // asserting against a filename the app no longer sends.
        const { NNUE_NET_FILE } = await import('/src/engine/nnue.ts');

        function drive(extraOptions) {
          return new Promise((resolve) => {
            const lines = [];
            const w = new Worker('/stockfish/stockfish-nnue-16-single.js');
            let settled = false;
            const finish = (why) => {
              if (settled) return;
              settled = true;
              try {
                w.terminate();
              } catch {
                /* already gone */
              }
              resolve({ why, lines });
            };
            w.addEventListener('message', (ev) => {
              const s = String(ev.data);
              lines.push(s);
              if (s.startsWith('bestmove')) finish('bestmove');
            });
            w.addEventListener('error', (e) => finish(`error: ${e.message || 'unknown'}`));
            setTimeout(() => finish('timeout'), 120_000);
            for (const cmd of [
              'uci',
              'setoption name UCI_AnalyseMode value true',
              'setoption name Threads value 1',
              'setoption name Hash value 64',
              ...extraOptions,
              'isready',
              `position fen ${fen}`,
              `go depth ${depth}`,
            ]) {
              w.postMessage(cmd);
            }
          });
        }

        const lastCp = (lines) => {
          let cp = null;
          for (const l of lines) {
            const m = /score cp (-?\d+)/.exec(l);
            if (m) cp = Number(m[1]);
          }
          return cp;
        };
        const infoStrings = (lines) => lines.filter((l) => l.startsWith('info string'));
        const nnueOptionLine = (lines) =>
          lines.find((l) => /^option name Use NNUE/.test(l)) ?? null;

        const nnue = await drive([
          `setoption name EvalFile value ${NNUE_NET_FILE}`,
          'setoption name Use NNUE value true',
        ]);
        const classical = await drive([]);

        return {
          nnue: {
            why: nnue.why,
            cp: lastCp(nnue.lines),
            strings: infoStrings(nnue.lines),
            optionLine: nnueOptionLine(nnue.lines),
          },
          classical: {
            why: classical.why,
            cp: lastCp(classical.lines),
            strings: infoStrings(classical.lines),
          },
        };
      },
      { fen: ROOK_ENDGAME, depth: PROBE_DEPTH },
    );

    console.log('raw:', JSON.stringify(raw, null, 1));

    expect(raw.nnue.why, 'NNUE search completed').toBe('bestmove');
    expect(raw.classical.why, 'classical search completed').toBe('bestmove');

    const nnueSays = raw.nnue.strings.join(' | ');
    expect(
      /NNUE evaluation/i.test(nnueSays),
      `engine must report NNUE evaluation enabled (got: ${nnueSays})`,
    ).toBe(true);
    expect(
      /classical evaluation/i.test(nnueSays),
      `engine must NOT report classical when NNUE was requested (got: ${nnueSays})`,
    ).toBe(false);
    expect(
      /classical evaluation/i.test(raw.classical.strings.join(' | ')),
      'control run must report classical evaluation',
    ).toBe(true);

    // The reason the explicit `nnueEnabled` assignment exists. If this ever
    // reads `default true`, the inference-only code path would have been fine
    // and the comment in engine.ts should be revisited.
    expect(
      raw.nnue.optionLine,
      'the build still advertises `Use NNUE` default false even when we enable it',
    ).toBe('option name Use NNUE type check default false');

    // Assertion 2: the numbers genuinely differ. Thresholds are loose either
    // side of the measured +53 / +377 so a Stockfish patch release can shift
    // them without going red, while a net that failed to load (both runs
    // classical) cannot pass.
    console.log(`cp: classical=${raw.classical.cp}  nnue=${raw.nnue.cp}`);
    expect(raw.classical.cp, 'classical eval present').toBeAtMost(200);
    expect(raw.nnue.cp, 'NNUE sees the endgame as winning').toBeAtLeast(250);
    expect(
      raw.nnue.cp - raw.classical.cp,
      'NNUE and classical must disagree materially (equal means no net loaded)',
    ).toBeAtLeast(150);

    /* ------------------------------------------------------------------ */
    /*  3. The app's own code path reports NNUE                           */
    /* ------------------------------------------------------------------ */
    const app = await page.evaluate(async (pgn) => {
      const { EngineWorker, engine } = await import('/src/engine/engine.ts');
      const { analysisPool } = await import('/src/engine/pool.ts');
      const { analyzeGamePgn } = await import('/src/engine/analyzer.ts');
      const { nnuePreferenceEnabled, activeEvaluatorId } = await import(
        '/src/engine/nnue.ts'
      );
      const { db } = await import('/src/db/schema.ts');

      // Default state: no preference written, so NNUE is on.
      const prefDefault = nnuePreferenceEnabled();
      const intended = await activeEvaluatorId();

      // A worker built the way the app builds them.
      const w = new EngineWorker();
      await w.analyze('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1', 8);
      const workerId = w.evaluatorId();
      const workerConfirmed = w.isNnueConfirmedByEngine();
      w.terminate();

      // The singleton the review page's eval bar uses.
      await engine.analyze('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1', 8);
      const singletonId = engine.evaluatorId();

      // The pool the analysis queue uses.
      await analysisPool().analyze(
        'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
        8,
      );
      const poolId = analysisPool().evaluatorId();

      // And the stamp that lands on a recorded analysis.
      await db.games.put({
        id: 'nnue-stamp-001',
        url: 'https://example.com/nnue-stamp-001',
        source: 'chesscom',
        username: 'me',
        userColor: 'white',
        opponent: 'opp',
        result: 'win',
        timeControl: '600',
        timeClass: 'rapid',
        endTime: Date.now(),
        pgn,
        importedAt: Date.now(),
        analysisStatus: 'pending',
      });
      const analysis = await analyzeGamePgn('nnue-stamp-001', pgn, 10);

      return {
        prefDefault,
        intended,
        workerId,
        workerConfirmed,
        singletonId,
        poolId,
        analysisEngine: analysis.engine,
        moves: analysis.moves.length,
      };
    }, PGN);

    console.log('app:', JSON.stringify(app, null, 1));

    expect(app.prefDefault, 'NNUE preference defaults ON').toBe(true);
    expect(app.intended, 'intended evaluator').toBe('stockfish-16-nnue');
    expect(app.workerId, 'EngineWorker.evaluatorId()').toBe('stockfish-16-nnue');
    expect(
      app.workerConfirmed,
      'Stockfish confirmed NNUE during the app\'s own handshake',
    ).toBe(true);
    expect(app.singletonId, 'engine singleton (eval bars)').toBe('stockfish-16-nnue');
    expect(app.poolId, 'analysisPool().evaluatorId()').toBe('stockfish-16-nnue');
    expect(app.analysisEngine, 'Analysis.engine stamp').toBe('stockfish-16-nnue');
    expect(app.moves, 'analysis produced moves').toBeAtLeast(4);

    /* ------------------------------------------------------------------ */
    /*  5. Eval-cache rows are per-evaluator                              */
    /* ------------------------------------------------------------------ */
    const cache = await page.evaluate(async (fen) => {
      const { db } = await import('/src/db/schema.ts');
      const { cachedAnalyze, evalCacheRowKey } = await import('/src/engine/cache.ts');

      // Go through `cachedAnalyze`, not the pool: the cache is the thing under
      // test. A non-book position, so the book fast path doesn't skip it and
      // leave nothing to inspect.
      await db.evalCache.where('fen').equals(fen).delete();
      await cachedAnalyze(fen, 10);

      const rows = await db.evalCache.where('fen').equals(fen).toArray();
      return {
        classicalKey: evalCacheRowKey(fen, 10, 'stockfish-16-classical'),
        nnueKey: evalCacheRowKey(fen, 10, 'stockfish-16-nnue'),
        keys: rows.map((r) => r.key),
        evaluators: [...new Set(rows.map((r) => r.evaluator ?? '(absent)'))],
        // Whether a classical row for the same (fen, depth) would be handed to
        // an NNUE lookup. It must not be.
        classicalRowPresent: rows.some((r) => (r.evaluator ?? 'x') === 'stockfish-16-classical'),
      };
    }, ROOK_ENDGAME);
    console.log('cache:', JSON.stringify(cache));
    // Classical keeps the historical `${fen}|${depth}` shape, so an existing
    // cache stays valid for anyone who opts out — no invalidation, no migration.
    expect(cache.classicalKey, 'classical keeps the historical key shape').toBe(
      `${ROOK_ENDGAME}|10`,
    );
    expect(
      cache.nnueKey === cache.classicalKey,
      'NNUE and classical must not share a cache row',
    ).toBe(false);
    expect(
      cache.keys.length,
      `cachedAnalyze wrote a row (got ${JSON.stringify(cache.keys)})`,
    ).toBe(1);
    expect(
      cache.evaluators.includes('stockfish-16-nnue'),
      `rows written under NNUE carry the evaluator (got ${JSON.stringify(cache.evaluators)})`,
    ).toBe(true);
    expect(
      cache.classicalRowPresent,
      'an NNUE run must not write a classical-keyed row',
    ).toBe(false);

    /* ------------------------------------------------------------------ */
    /*  Pool sizing backs off on low-memory devices when NNUE is on        */
    /* ------------------------------------------------------------------ */
    // Driven with synthetic inputs rather than the real device, because the whole
    // point is behaviour on hardware we don't have. Measured cost that motivates
    // it: ~340 MB resident per NNUE worker vs ~125 MB classical, so a 4-worker
    // pool goes from ~0.5 GB to ~1.4 GB — fine on a desktop, fatal on a phone.
    const sizing = await page.evaluate(async () => {
      const { defaultPoolSize } = await import('/src/engine/pool.ts');
      const at = (cores, memoryGb, nnue) => defaultPoolSize({ cores, memoryGb, nnue });
      return {
        // Classical is unchanged by memory: it was always affordable.
        classical8core2gb: at(8, 2, false),
        classical8coreNoApi: at(8, undefined, false),
        // NNUE backs off.
        nnue8core2gb: at(8, 2, true),
        nnue8core4gb: at(8, 4, true),
        nnue8core8gb: at(8, 8, true),
        // A missing `navigator.deviceMemory` must not silently halve desktop
        // throughput — we don't guess.
        nnue8coreNoApi: at(8, undefined, true),
        // Cores still cap when memory is plentiful, and never below 1.
        nnue2core16gb: at(2, 16, true),
        nnue1core16gb: at(1, 16, true),
        nnue1core1gb: at(1, 1, true),
      };
    });
    console.log('pool sizing:', JSON.stringify(sizing));
    expect(sizing.classical8core2gb, 'classical ignores low memory').toBe(4);
    expect(sizing.classical8coreNoApi, 'classical without the memory API').toBe(4);
    expect(sizing.nnue8core2gb, 'NNUE on a 2 GB device drops to one worker').toBe(1);
    expect(sizing.nnue8core4gb, 'NNUE on a 4 GB device drops to two').toBe(2);
    expect(sizing.nnue8core8gb, 'NNUE on an 8 GB device keeps the full pool').toBe(4);
    expect(sizing.nnue8coreNoApi, 'no memory API means no guess').toBe(4);
    expect(sizing.nnue2core16gb, 'cores still cap the pool').toBe(1);
    expect(sizing.nnue1core16gb, 'single core still gets one worker').toBe(1);
    expect(sizing.nnue1core1gb, 'never zero workers (a 0-size pool deadlocks pump)').toBe(1);

    /* ------------------------------------------------------------------ */
    /*  4. The opt-out                                                    */
    /* ------------------------------------------------------------------ */
    const off = await page.evaluate(async () => {
      const { NNUE_PREF_KEY, NNUE_PREF_VERSION, nnuePreferenceEnabled, activeEvaluatorId } =
        await import('/src/engine/nnue.ts');
      const { persistedStorageKey, writePersistedValue } = await import(
        '/src/lib/usePersistedState.ts'
      );
      const { EngineWorker } = await import('/src/engine/engine.ts');

      // Written through the same helpers the Settings toggle uses, so the test
      // can't pass against a key the UI doesn't actually write.
      const storageKey = persistedStorageKey(NNUE_PREF_KEY, NNUE_PREF_VERSION);
      writePersistedValue(storageKey, false);

      const pref = nnuePreferenceEnabled();
      const intended = await activeEvaluatorId();

      const w = new EngineWorker();
      const res = await w.analyze(
        '8/5R2/1p2P3/p4r2/P6p/1P3Pk1/4K3/8 b - - 1 64',
        12,
      );
      const id = w.evaluatorId();
      const confirmed = w.isNnueConfirmedByEngine();
      w.terminate();

      return { storageKey, pref, intended, id, confirmed, cp: res.scoreCp };
    });

    console.log('off:', JSON.stringify(off));
    expect(off.storageKey, 'preference storage key').toBe('chess-coach:engine.nnue:v1');
    expect(off.pref, 'preference reads false once written').toBe(false);
    expect(off.intended, 'intended evaluator with the toggle off').toBe(
      'stockfish-16-classical',
    );
    expect(off.id, 'a worker started with the toggle off is classical').toBe(
      'stockfish-16-classical',
    );
    expect(off.confirmed, 'no NNUE confirmation with the toggle off').toBe(false);
  },
});
