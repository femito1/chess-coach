// Can the browser load the NNUE net from ANOTHER ORIGIN, and does the app
// degrade rather than die when it can't?
//
// This is the test behind the production deployment. Cloudflare Pages refuses
// any single asset over 25 MiB and the net is 38.3 MiB, so production cannot
// serve it from the app's own origin at all — it has to come from an object
// store. Three things have to hold for that to be safe, and none of them is
// observable outside a real cross-origin-isolated browser:
//
//   1. **A cross-origin `EvalFile` actually works.** Stockfish loads the net
//      through `emscripten_fetch`, which hands the value to XHR verbatim, so an
//      absolute URL should just work. "Should" isn't good enough for a 38 MiB
//      infrastructure decision, so this drives the app's own `EngineWorker`
//      against a foreign origin and checks the engine's own acknowledgement and
//      the eval number.
//
//   2. **CORS is the whole requirement.** The app runs under
//      `COEP: require-corp`, which is why the docs long claimed the host needed
//      `Cross-Origin-Resource-Policy: cross-origin` as well. It does not: both
//      the probe and Stockfish's download are CORS-mode requests, and a CORS
//      response satisfies COEP on its own. Pinned here because it is the
//      difference between "R2's default public bucket works" and "you need a
//      custom domain and a Transform Rule".
//
//   3. **A misconfigured host degrades, it does not hang.** This is the one that
//      matters operationally. Stockfish 16 calls `exit(EXIT_FAILURE)` from
//      `Eval::NNUE::verify()` at the first `go` when `Use NNUE` is on and the net
//      didn't load — so a bucket missing its CORS rule doesn't make evals worse,
//      it makes analysis DIE mid-search. `nnueNetAvailable()`'s HEAD probe is
//      what stands between that and the user; this test removes the CORS header
//      and asserts the app comes back classical and still produces a result.
//
// The foreign origin is a local HTTP server this script starts, with each header
// individually switchable — the point is to test the headers, so they can't come
// from a fixture we don't control.
//
// Run: node scripts/run-tests.mjs --only=nnue-remote-net

import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runBrowserTest, expect, appendBypass } from '../harness.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const netDir = join(repoRoot, 'public', 'stockfish');

// The quiet rook endgame the two evaluators disagree about: classical +53,
// NNUE +377. A tactical position would agree and prove nothing.
const ROOK_ENDGAME = '8/5R2/1p2P3/p4r2/P6p/1P3Pk1/4K3/8 b - - 1 64';
const PROBE_DEPTH = 16;

/**
 * A stand-in for an object store, on its own origin.
 *
 * `cors` and `corp` are separately switchable so the test can establish which
 * header is load-bearing rather than sending both and assuming. Serves out of
 * `public/stockfish/`, so it needs `npm run nnue:stage` to have run — the same
 * precondition the rest of the engine tests have.
 *
 * **It also records every request, and that log is what makes this test
 * meaningful rather than vacuous.** The net is staged same-origin as well (dev
 * needs it there), so a bare-filename `EvalFile` still finds a net — next to the
 * worker script, on the app's own origin. Every assertion about evaluator ids and
 * centipawns therefore passes whether or not the cross-origin URL was used at
 * all: verified by reverting the `engine.ts` change and watching this test stay
 * green. The only thing that distinguishes the two is which server handed over
 * the 38 MiB, so the test asks the server.
 */
function startNetHost({ cors, corp }) {
  const requests = [];
  const server = createServer((req, res) => {
    const name = decodeURIComponent((req.url ?? '/').split('?')[0]).replace(/^\/+/, '');
    let size;
    try {
      size = statSync(join(netDir, name)).size;
    } catch {
      requests.push({ method: req.method, name, status: 404, bytes: 0 });
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('not found');
    }
    // Logged before the body is streamed: a GET that the browser aborts partway
    // still counts as the engine having asked us for the net.
    requests.push({ method: req.method, name, status: 200, bytes: size });
    const headers = {
      'content-type': 'application/octet-stream',
      'content-length': String(size),
      'cache-control': 'public, max-age=31536000, immutable',
    };
    if (cors) headers['access-control-allow-origin'] = '*';
    if (corp) headers['cross-origin-resource-policy'] = 'cross-origin';
    if (req.method === 'HEAD') {
      res.writeHead(200, headers);
      return res.end();
    }
    res.writeHead(200, headers);
    createReadStream(join(netDir, name)).pipe(res);
  });
  return new Promise((resolveP, rejectP) => {
    server.on('error', rejectP);
    // Port 0: an ephemeral port, so a developer with something on a fixed port
    // doesn't get a mystery failure.
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolveP({
        origin: `http://127.0.0.1:${port}`,
        /** Requests seen since the last `reset()`. */
        requests: () => requests.slice(),
        reset: () => {
          requests.length = 0;
        },
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

/**
 * Did this host actually hand over the network, and to whom?
 *
 * `probe` is `nnueNetAvailable()`'s HEAD; `download` is Stockfish's own GET via
 * `emscripten_fetch`. The GET is the load-bearing observation: it is present only
 * if `EvalFile` carried the absolute URL, because a bare filename resolves next
 * to the worker script on the app's own origin instead.
 */
function classifyRequests(requests) {
  return {
    probes: requests.filter((r) => r.method === 'HEAD').length,
    downloads: requests.filter((r) => r.method === 'GET' && r.status === 200).length,
    notFound: requests.filter((r) => r.status === 404).length,
    all: requests.map((r) => `${r.method} ${r.name} → ${r.status}`),
  };
}

/** Drive one full app-level engine start against a given net location. */
const runAgainst = async (page, netUrl) =>
  page.evaluate(
    async ({ url, fen, depth }) => {
      const { EngineWorker } = await import('/src/engine/engine.ts');
      const {
        _setNnueNetUrlOverride,
        nnueNetUrl,
        nnueNetIsRemote,
        nnueNetAvailable,
        activeEvaluatorId,
      } = await import('/src/engine/nnue.ts');

      // The override runs through the same `resolveNetLocation` the env var
      // does, so this exercises real resolution — not a bypass of it.
      _setNnueNetUrlOverride(url);

      const resolved = nnueNetUrl();
      const remote = nnueNetIsRemote();
      const probe = await nnueNetAvailable();
      const intended = await activeEvaluatorId();

      const w = new EngineWorker();
      let result = null;
      let error = null;
      try {
        result = await w.analyze(fen, depth);
      } catch (e) {
        error = String(e);
      }
      const id = w.evaluatorId();
      const confirmed = w.isNnueConfirmedByEngine();
      w.terminate();
      _setNnueNetUrlOverride(null);

      return {
        resolved,
        remote,
        probe,
        intended,
        id,
        confirmed,
        cp: result?.scoreCp ?? null,
        error,
      };
    },
    { url: netUrl, fen: ROOK_ENDGAME, depth: PROBE_DEPTH },
  );

// Started before the browser so a bind failure reports itself plainly.
const good = await startNetHost({ cors: true, corp: true });
const corsOnly = await startNetHost({ cors: true, corp: false });
const noCors = await startNetHost({ cors: false, corp: true });

try {
  await runBrowserTest({
    name: 'nnue-remote-net',
    // Booting workers means networkidle never settles.
    waitUntil: 'domcontentloaded',
    skipInitialGoto: true,
    async run({ page }) {
      await page.goto(appendBypass('http://localhost:5173/'), {
        waitUntil: 'domcontentloaded',
      });
      await page.waitForSelector('a[href="/puzzles"]', { timeout: 15_000 });

      // Everything below assumes the page is cross-origin isolated, because that
      // is what makes the CORS question interesting at all. Assert it rather
      // than quietly testing a weaker configuration.
      const isolated = await page.evaluate(() => crossOriginIsolated === true);
      expect(isolated, 'page must be cross-origin isolated (COEP: require-corp)').toBe(
        true,
      );

      /* ---------------------------------------------------------------- */
      /*  Baseline: same-origin, so a failure below is about the origin    */
      /*  change and not about the net being unstaged.                     */
      /* ---------------------------------------------------------------- */
      const local = await runAgainst(page, null);
      console.log('same-origin:', JSON.stringify(local));
      expect(local.remote, 'null override means same-origin').toBe(false);
      expect(
        local.probe,
        'same-origin net must be staged for this test to mean anything — run `npm run nnue:stage`',
      ).toBe(true);
      expect(local.id, 'same-origin evaluator').toBe('stockfish-16-nnue');
      expect(local.cp, 'same-origin NNUE sees the endgame as winning').toBeAtLeast(250);

      /* ---------------------------------------------------------------- */
      /*  1. A foreign origin with CORS + CORP                            */
      /* ---------------------------------------------------------------- */
      good.reset();
      const remote = await runAgainst(page, good.origin);
      const goodReqs = classifyRequests(good.requests());
      console.log('cross-origin (cors+corp):', JSON.stringify(remote));
      console.log('  host saw:', JSON.stringify(goodReqs.all));

      expect(remote.remote, 'a foreign origin resolves as remote').toBe(true);
      expect(remote.resolved, 'resolved URL points at the foreign origin').toBe(
        `${good.origin}/nn-5af11540bbfe.nnue`,
      );
      expect(remote.probe, 'probe finds the cross-origin net').toBe(true);
      expect(remote.intended, 'intended evaluator').toBe('stockfish-16-nnue');
      expect(remote.error, 'analysis completed').toBe(null);
      expect(remote.id, 'EngineWorker.evaluatorId() over a foreign origin').toBe(
        'stockfish-16-nnue',
      );
      // The assertion that can't be faked by a mislabelled field: Stockfish's
      // own acknowledgement, plus a number only a loaded net produces.
      expect(
        remote.confirmed,
        'Stockfish itself confirmed NNUE with a cross-origin EvalFile',
      ).toBe(true);
      expect(remote.cp, 'cross-origin NNUE sees the endgame as winning').toBeAtLeast(250);

      // THE assertion this test exists for. Everything above is also true of a
      // build that ignored the remote URL and loaded the net from its own origin,
      // because dev stages it there too. Only the foreign server's access log can
      // tell the two apart.
      expect(
        goodReqs.probes,
        `the probe HEADed the foreign origin (saw ${JSON.stringify(goodReqs.all)})`,
      ).toBeAtLeast(1);
      expect(
        goodReqs.downloads,
        'Stockfish DOWNLOADED the net from the foreign origin — if this is 0, ' +
          '`EvalFile` was sent as a bare filename and the engine quietly used the ' +
          'same-origin copy, which will not exist in production',
      ).toBeAtLeast(1);
      expect(
        goodReqs.notFound,
        `no 404s against the foreign origin (saw ${JSON.stringify(goodReqs.all)})`,
      ).toBe(0);

      /* ---------------------------------------------------------------- */
      /*  2. CORS alone is enough — CORP is not required                  */
      /* ---------------------------------------------------------------- */
      // This is what makes R2's default public bucket sufficient. If it ever
      // goes red, DEPLOY.md's R2 recipe needs a custom domain and a Transform
      // Rule to add CORP, so fail loudly rather than adjusting the assertion.
      corsOnly.reset();
      const noCorp = await runAgainst(page, corsOnly.origin);
      const corsOnlyReqs = classifyRequests(corsOnly.requests());
      console.log('cross-origin (cors only):', JSON.stringify(noCorp));
      console.log('  host saw:', JSON.stringify(corsOnlyReqs.all));
      expect(noCorp.probe, 'probe succeeds without CORP').toBe(true);
      expect(
        noCorp.id,
        'CORS alone satisfies COEP: require-corp for a CORS-mode fetch',
      ).toBe('stockfish-16-nnue');
      expect(noCorp.confirmed, 'Stockfish loaded the net without CORP').toBe(true);
      expect(noCorp.cp, 'and evaluated with it').toBeAtLeast(250);
      expect(
        corsOnlyReqs.downloads,
        'Stockfish downloaded the net from a host sending no CORP at all',
      ).toBeAtLeast(1);

      /* ---------------------------------------------------------------- */
      /*  3. No CORS: degrade to classical, do NOT hang or die            */
      /* ---------------------------------------------------------------- */
      noCors.reset();
      const blocked = await runAgainst(page, noCors.origin);
      const noCorsReqs = classifyRequests(noCors.requests());
      console.log('cross-origin (no cors):', JSON.stringify(blocked));
      console.log('  host saw:', JSON.stringify(noCorsReqs.all));

      expect(blocked.remote, 'still resolves as remote').toBe(true);
      // The probe is the whole safety mechanism: it turns a fatal
      // `exit(EXIT_FAILURE)` at the first `go` into a labelled fallback.
      expect(blocked.probe, 'probe must fail when the host sends no CORS header').toBe(
        false,
      );
      expect(blocked.intended, 'intended evaluator drops to classical').toBe(
        'stockfish-16-classical',
      );
      expect(
        blocked.error,
        'analysis must still complete — a CORS-less net must not kill the worker',
      ).toBe(null);
      expect(blocked.id, 'evaluator is labelled honestly as classical').toBe(
        'stockfish-16-classical',
      );
      expect(
        blocked.confirmed,
        'and Stockfish must not claim NNUE when the net never arrived',
      ).toBe(false);
      // The number proves the fallback is real rather than a label: classical
      // calls this endgame roughly equal.
      expect(blocked.cp, 'classical reads the same endgame as near-equal').toBeAtMost(200);

      // The probe reached the host — the response was refused by the browser for
      // want of a CORS header, not lost in the network. Distinguishing those
      // matters: an unreachable host would exercise a different code path and
      // this case would stop testing CORS at all.
      expect(
        noCorsReqs.probes,
        `the probe did reach the host (saw ${JSON.stringify(noCorsReqs.all)})`,
      ).toBeAtLeast(1);
      // And having failed the probe, the app must never have asked for 38 MiB it
      // cannot use.
      expect(
        noCorsReqs.downloads,
        'a failed probe must stop the engine before it downloads the net',
      ).toBe(0);
    },
  });
} finally {
  await Promise.all([good.close(), corsOnly.close(), noCors.close()]);
}
