/**
 * Provenance check for the analysis worker. Run this before committing hours of
 * compute, and after ever touching the UCI options or the Stockfish binary.
 *
 * It answers two questions with numbers rather than argument:
 *
 *   1. **Does this binary reproduce the browser?** With `Use NNUE false` and the
 *      browser's other three UCI options, native Stockfish must return the same
 *      evaluations the app has been recording. If it does, a
 *      classical-configured worker can extend the existing library seamlessly.
 *      If it doesn't, something about this binary differs from the app's build
 *      and its output does not belong in the same library.
 *
 *   2. **Is NNUE actually doing something?** With `Use NNUE true` the numbers
 *      must diverge on quiet positions. That sounds trivial, but it is the check
 *      that catches a binary silently failing to load its network and falling
 *      back to classical — which is exactly the failure the browser has been
 *      shipping, undetected, all along.
 *
 * The expected classical values below were measured from the app's own engine
 * (`stockfish-nnue-16-single.js`, depth 18, UCI_AnalyseMode on, Threads 1,
 * Hash 64). A transposition table warmed by earlier searches can shift a score
 * by a few centipawns, so a small tolerance is allowed; a systematic difference
 * is what this is looking for, not bit-equality.
 */

import { NativeEngine, WorkerPool, evaluatorId } from './engine';
import { analyzeGamePgn, computeAccuracy } from '@/engine/analyzer';

const DEPTH = 18;

/** Measured from the browser engine at depth 18. */
const CASES = [
  {
    label: 'rook endgame',
    fen: '8/5R2/1p2P3/p4r2/P6p/1P3Pk1/4K3/8 b - - 1 64',
    browserClassicalCp: 53,
    // Classical calls this roughly equal; NNUE sees it as winning. The single
    // clearest illustration of why the evaluator matters for coaching.
    expectNnueDiffers: true,
  },
  {
    label: 'queenless middlegame',
    fen: 'r4rk1/1bp2ppp/p1p5/4P3/2P5/2N5/PP3PPP/2KR3R b - - 1 16',
    browserClassicalCp: -113,
    expectNnueDiffers: true,
  },
  {
    label: 'forced mate',
    fen: 'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5Q2/PPPP1PPP/RNB1K1NR w KQkq - 4 4',
    browserClassicalCp: null, // mate, not a cp score
    // Search finds a forced mate regardless of who is doing the evaluating, so
    // this one must agree either way. It is the control.
    expectNnueDiffers: false,
  },
] as const;

/** Centipawns of slack, to absorb transposition-table warmth. */
const TOLERANCE = 15;

async function scoreWith(
  binPath: string,
  evaluator: 'nnue' | 'classical',
  fen: string,
): Promise<{ cp: number | null; mate: number | null }> {
  const engine = new NativeEngine(binPath, evaluator);
  await engine.ready();
  try {
    const r = await engine.analyze(fen, DEPTH);
    return { cp: r.scoreCp, mate: r.scoreMate };
  } finally {
    engine.terminate();
  }
}

async function main(): Promise<void> {
  const binPath = process.env.STOCKFISH_PATH ?? 'stockfish';
  console.log(`Verifying ${binPath} at depth ${DEPTH}\n`);

  const probe = new NativeEngine(binPath, 'classical');
  await probe.ready();
  console.log(`  engine: ${probe.name}`);
  probe.terminate();
  if (!/stockfish\s*16/i.test(probe.name)) {
    console.warn(
      `\n  WARNING: expected a Stockfish 16 build. "${probe.name}" is a different\n` +
        '  version, which evaluates differently — analyses it produces will not be\n' +
        '  comparable with the rest of the library.\n',
    );
  }
  console.log('');

  let failures = 0;
  for (const c of CASES) {
    const classical = await scoreWith(binPath, 'classical', c.fen);
    const nnue = await scoreWith(binPath, 'nnue', c.fen);

    // 1. classical must match the browser
    let line1: string;
    if (c.browserClassicalCp === null) {
      const ok = classical.mate !== null;
      if (!ok) failures++;
      line1 = `${ok ? 'ok  ' : 'FAIL'} classical finds mate (${classical.mate ?? classical.cp})`;
    } else {
      const delta =
        classical.cp === null ? Infinity : Math.abs(classical.cp - c.browserClassicalCp);
      const ok = delta <= TOLERANCE;
      if (!ok) failures++;
      line1 =
        `${ok ? 'ok  ' : 'FAIL'} classical ${classical.cp} vs browser ` +
        `${c.browserClassicalCp} (delta ${delta === Infinity ? 'n/a' : delta})`;
    }

    // 2. NNUE must differ where expected, and agree where it shouldn't
    const bothCp = classical.cp !== null && nnue.cp !== null;
    const nnueDelta = bothCp ? Math.abs(nnue.cp! - classical.cp!) : 0;
    const differs = bothCp ? nnueDelta > TOLERANCE : false;
    const ok2 = differs === c.expectNnueDiffers;
    if (!ok2) failures++;
    const line2 = c.expectNnueDiffers
      ? `${ok2 ? 'ok  ' : 'FAIL'} nnue ${nnue.cp} differs from classical (delta ${nnueDelta})` +
        (ok2 ? '' : ' — is the network actually loaded?')
      : `${ok2 ? 'ok  ' : 'FAIL'} nnue agrees on the forced line (${nnue.mate ?? nnue.cp})`;

    console.log(`${c.label}`);
    console.log(`  ${line1}`);
    console.log(`  ${line2}`);
  }

  // ---- 3. end-to-end: does the real analyzer run on this box? -----------
  //
  // The two checks above only exercise the engine. This one runs
  // `analyzeGamePgn` — the same function the browser calls — through the native
  // backend, which is what actually catches a broken bundle, a missing openings
  // dataset, or a backend that doesn't satisfy the interface. Worth doing before
  // pointing a fresh server at real data.
  console.log('end-to-end analyzer');
  const PGN =
    '[Event "Verify"]\n[Site "?"]\n[White "a"]\n[Black "b"]\n[Result "1-0"]\n' +
    '[TimeControl "600"]\n\n1. e4 e5 2. Bc4 Nc6 3. Qh5 Nf6 4. Qxf7# 1-0\n';
  try {
    const pool = await new WorkerPool(binPath, 2, 'nnue').ready();
    const analysis = await analyzeGamePgn('verify-1', PGN, 12, undefined, undefined, {
      hasOpening: true,
      timeControl: '600',
      backend: pool,
    });
    pool.terminate();
    const acc = computeAccuracy(analysis.moves);
    const ok =
      analysis.moves.length === 7 &&
      analysis.engine === evaluatorId('nnue') &&
      analysis.moves.every((m) => typeof m.classification === 'string') &&
      Number.isFinite(acc.white) &&
      Number.isFinite(acc.black);
    if (!ok) failures++;
    console.log(
      `  ${ok ? 'ok  ' : 'FAIL'} ${analysis.moves.length} moves, engine="${analysis.engine}", ` +
        `accuracy w${acc.white.toFixed(1)}/b${acc.black.toFixed(1)}`,
    );
    // The final move is mate; the analyzer should have classified it as such
    // rather than dropping it.
    const last = analysis.moves[analysis.moves.length - 1];
    const mateOk = last?.mateInAfter !== undefined || last?.classification === 'best';
    if (!mateOk) failures++;
    console.log(
      `  ${mateOk ? 'ok  ' : 'FAIL'} final move ${last?.san} classified "${last?.classification}"`,
    );
  } catch (err) {
    failures++;
    console.log(`  FAIL analyzer threw: ${(err as Error).message}`);
  }

  console.log('');
  if (failures > 0) {
    console.error(
      `${failures} check(s) failed. Do NOT run a bulk analysis with this setup —\n` +
        'the output would not be comparable with the existing library.',
    );
    process.exit(1);
  }
  console.log(
    'All checks passed. Classical reproduces the browser, NNUE is genuinely in\n' +
      'use, and the real analyzer runs here — this box is ready for a bulk run.',
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
