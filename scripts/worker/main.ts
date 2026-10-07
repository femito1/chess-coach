/**
 * Off-laptop analysis worker.
 *
 * Imports any new Chess.com games, analyzes them with native Stockfish, writes
 * the analyses back. Your laptop then picks both up through the normal cloud
 * sync — the worker is just another device, one that imports and analyzes.
 *
 *     chess.com ──import──▶ cloud_games ◀──sync── laptop
 *                               │
 *     worker  ─────────────────▶│   native Stockfish, N processes
 *                               ▼
 *                           cloud_analyses
 *                               │
 *     laptop  ◀──sync───────────┘
 *
 * Import is what makes the loop unattended. Without it the worker only ever saw
 * games the laptop had already imported — by which point the laptop had usually
 * analyzed them too, so the nightly run found nothing to do.
 *
 * It reuses `analyzeGamePgn` verbatim, so classifications, motifs, phases,
 * accuracies and book detection are computed by exactly the same code as in the
 * browser. Only the engine transport differs, injected via `EngineBackend`.
 *
 * ── Authentication ────────────────────────────────────────────────────────
 *
 * There is no browser here, so no Clerk session and no user JWT. The worker
 * authenticates with the Supabase **service_role** key, which bypasses RLS
 * entirely. Two consequences worth stating plainly:
 *
 *   - That key must never be committed, shipped to a browser, or pasted
 *     anywhere public. It is strictly an environment variable on a machine you
 *     control.
 *   - Because RLS is bypassed, the allowlist is not enforcing anything here.
 *     `USER_ID` is therefore required and every query filters on it explicitly,
 *     so a typo cannot silently read or write another account's rows.
 *
 * ── Resumability ──────────────────────────────────────────────────────────
 *
 * Each analysis is written as soon as it finishes. Kill the worker at any point
 * and re-run it: it re-reads what is already present and picks up where it left
 * off. There is no lease or checkpoint state to get wrong.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  analyzeGamePgn,
  computeAccuracy,
  countUserBrilliancies,
} from '@/engine/analyzer';
import type { Analysis, Game } from '@/db/schema';
import { selectCandidates } from '@/features/sync/selectCandidates';
import { selectImportArchives } from '@/features/sync/selectImportArchives';
import { toCloudGame } from '@/features/sync/diff';
import { fetchArchives, fetchMonth } from '@/api/chesscom';
import { chessComGameToGame } from '@/import/importer';
import { WorkerPool, evaluatorId, type Evaluator } from './engine';
import { cpus } from 'node:os';

interface Config {
  supabaseUrl: string;
  serviceRoleKey: string;
  userId: string;
  stockfishPath: string;
  depth: number;
  evaluator: Evaluator;
  concurrency: number;
  /** Re-analyze games that already have an analysis of the target quality. */
  force: boolean;
  /** Stop after N games. For a smoke test before committing hours of compute. */
  limit: number | null;
  dryRun: boolean;
  /** Import new Chess.com games before analyzing. On unless `IMPORT=0`. */
  importGames: boolean;
  /** Chess.com account to import from. Defaults to the one on the newest game. */
  chesscomUsername: string | null;
}

function readConfig(): Config {
  const need = (k: string): string => {
    const v = process.env[k];
    if (!v) {
      console.error(`Missing required env var ${k}. See scripts/worker/README.md`);
      process.exit(2);
    }
    return v;
  };
  const num = (k: string, dflt: number): number => {
    const v = process.env[k];
    if (!v) return dflt;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) {
      console.error(`${k} must be a positive number, got "${v}"`);
      process.exit(2);
    }
    return n;
  };
  const evaluator = (process.env.EVALUATOR ?? 'nnue') as Evaluator;
  if (evaluator !== 'nnue' && evaluator !== 'classical') {
    console.error(`EVALUATOR must be "nnue" or "classical", got "${evaluator}"`);
    process.exit(2);
  }
  return {
    supabaseUrl: need('SUPABASE_URL'),
    serviceRoleKey: need('SUPABASE_SERVICE_ROLE_KEY'),
    userId: need('USER_ID'),
    stockfishPath: process.env.STOCKFISH_PATH ?? 'stockfish',
    depth: num('DEPTH', 18),
    evaluator,
    // Leave a core for the OS and for the Node process doing the chess.js work,
    // which is not free at these volumes.
    concurrency: num('CONCURRENCY', Math.max(1, cpus().length - 1)),
    force: process.env.FORCE === '1',
    limit: process.env.LIMIT ? num('LIMIT', 0) : null,
    dryRun: process.env.DRY_RUN === '1',
    importGames: process.env.IMPORT !== '0',
    chesscomUsername: process.env.CHESSCOM_USERNAME?.trim() || null,
  };
}

const PAGE = 1000;

/** Page through a table; PostgREST caps a response at 1 000 rows. */
async function fetchAll<T>(
  db: SupabaseClient,
  table: string,
  columns: string,
  userId: string,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from(table)
      .select(columns)
      .eq('user_id', userId)
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
}

/**
 * Pull new Chess.com games into `cloud_games` and return the ids it added.
 *
 * Mirrors the browser's import exactly: the same `chessComGameToGame` mapping,
 * so the id (a hash of the game URL), `userColor` and opening fields match what
 * the laptop would have produced, and the same insert-if-absent rule as
 * `upsertGames` — a row that already exists is never touched, because it may
 * be `done` and carry an accuracy this import knows nothing about. The laptop
 * then pulls these as it pulls any cloud-only game, and its new-games banner
 * reconciles by exact id, so it will not offer them a second time.
 *
 * Never fatal. Chess.com being down for a night must not cost the analysis of
 * games that are already here.
 */
async function importNewGames(
  db: SupabaseClient,
  cfg: Config,
  known: ReadonlySet<string>,
): Promise<string[]> {
  try {
    const { data, error } = await db
      .from('cloud_games')
      .select('end_time, username:data->>username')
      .eq('user_id', cfg.userId)
      .order('end_time', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(`newest game: ${error.message}`);
    const newest = data as { end_time: number; username: string | null } | null;
    const username = cfg.chesscomUsername ?? newest?.username ?? null;
    if (!username) {
      console.log('Import: no Chess.com username on file — skipping.');
      return [];
    }

    const archives = selectImportArchives(
      await fetchArchives(username),
      newest?.end_time ?? null,
    );
    if (archives.length === 0) {
      console.log(`Import: ${username} — no archives to read.`);
      return [];
    }

    const added: string[] = [];
    for (const url of archives) {
      const fresh = (await fetchMonth(url))
        .map((g) => chessComGameToGame(g, username))
        .filter((g) => !known.has(g.id) && !added.includes(g.id));
      if (fresh.length === 0) continue;
      if (!cfg.dryRun) {
        // `ignoreDuplicates` is ON CONFLICT DO NOTHING: the laptop may have
        // pushed the same game since `known` was read, and its row wins.
        const { error: insErr } = await db
          .from('cloud_games')
          .upsert(
            fresh.map((g) => toCloudGame(cfg.userId, g)),
            { onConflict: 'user_id,game_id', ignoreDuplicates: true },
          );
        if (insErr) throw new Error(`insert games: ${insErr.message}`);
      }
      added.push(...fresh.map((g) => g.id));
    }
    const months = archives.map((u) => u.split('/games/')[1]).join(', ');
    console.log(
      `Import: ${username} — read ${months}; ` +
        `${added.length} new${cfg.dryRun ? ' (dry run, not written)' : ''}.`,
    );
    return added;
  } catch (err) {
    console.error(`Import failed, analyzing what is already here: ${(err as Error).message}`);
    return [];
  }
}

function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

async function main(): Promise<void> {
  const cfg = readConfig();
  const db = createClient(cfg.supabaseUrl, cfg.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  console.log('chess-coach analysis worker');
  console.log(`  user        ${cfg.userId}`);
  console.log(`  depth       ${cfg.depth}`);
  console.log(`  evaluator   ${evaluatorId(cfg.evaluator)}`);
  console.log(`  concurrency ${cfg.concurrency}`);
  console.log(`  stockfish   ${cfg.stockfishPath}`);
  console.log(`  import      ${cfg.importGames ? 'on' : 'off (IMPORT=0)'}`);
  if (cfg.dryRun) console.log('  DRY RUN — nothing will be written');

  // ---- what needs doing -------------------------------------------------
  const [games, analyses] = await Promise.all([
    fetchAll<{ game_id: string }>(db, 'cloud_games', 'game_id', cfg.userId),
    fetchAll<{ game_id: string; depth: number; engine: string | null }>(
      db,
      'cloud_analyses',
      'game_id, depth, engine',
      cfg.userId,
    ),
  ]);

  if (games.length === 0) {
    console.log(
      '\nNo games found for this user in cloud_games.\n' +
        'Run a sync from the app first (Settings → Cloud sync → Sync now) so the\n' +
        'worker has something to analyze.',
    );
    return;
  }

  if (cfg.importGames) {
    console.log('');
    const imported = await importNewGames(
      db,
      cfg,
      new Set(games.map((g) => g.game_id)),
    );
    for (const id of imported) games.push({ game_id: id });
  }

  const existing = new Map(
    analyses.map((a) => [a.game_id, { depth: a.depth, engine: a.engine }]),
  );
  let candidates = selectCandidates({
    gameIds: games.map((g) => g.game_id),
    existing,
    depth: cfg.depth,
    wantNnue: cfg.evaluator === 'nnue',
    force: cfg.force,
  });

  const byReason = candidates.reduce<Record<string, number>>((acc, c) => {
    acc[c.reason] = (acc[c.reason] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`\n${games.length} games, ${existing.size} with an analysis.`);
  console.log(`${candidates.length} need work: ${JSON.stringify(byReason)}`);

  if (cfg.limit !== null && candidates.length > cfg.limit) {
    candidates = candidates.slice(0, cfg.limit);
    console.log(`LIMIT=${cfg.limit} — analyzing the first ${candidates.length}.`);
  }
  if (candidates.length === 0) {
    console.log('Nothing to do.');
    return;
  }
  if (cfg.dryRun) {
    console.log('Dry run: stopping before any engine work.');
    return;
  }

  // ---- engines ----------------------------------------------------------
  console.log(`\nStarting ${cfg.concurrency} engines…`);
  const pool = await new WorkerPool(
    cfg.stockfishPath,
    cfg.concurrency,
    cfg.evaluator,
  ).ready();
  console.log(`  ${pool.engineName} · Use NNUE=${cfg.evaluator === 'nnue'}`);

  let done = 0;
  let failed = 0;
  const started = Date.now();
  let stopping = false;
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      if (stopping) process.exit(130);
      stopping = true;
      console.log(`\n${sig} — finishing in-flight games, then stopping.`);
      console.log('Re-run to resume; everything written so far is kept.');
    });
  }

  // One game at a time through the analyzer, but each game fans its positions
  // out across every engine — the same shape as the browser, and it keeps the
  // eval cache hot on the opening prefix a run of games shares.
  for (const c of candidates) {
    if (stopping) break;
    try {
      const { data, error } = await db
        .from('cloud_games')
        .select('data')
        .eq('user_id', cfg.userId)
        .eq('game_id', c.gameId)
        .maybeSingle();
      if (error) throw new Error(`fetch game: ${error.message}`);
      const game = (data as { data: Game } | null)?.data;
      if (!game) {
        console.warn(`  ${c.gameId}: game row vanished, skipping`);
        continue;
      }

      const analysis: Analysis = await analyzeGamePgn(
        game.id,
        game.pgn,
        cfg.depth,
        undefined,
        undefined,
        {
          hasOpening: Boolean(game.eco || game.opening),
          timeControl: game.timeControl,
          backend: pool,
        },
      );

      const acc = computeAccuracy(analysis.moves);
      const { error: upErr } = await db.from('cloud_analyses').upsert(
        {
          user_id: cfg.userId,
          game_id: analysis.gameId,
          depth: analysis.depth,
          analyzed_at: analysis.analyzedAt,
          engine: analysis.engine,
          move_count: analysis.moves.length,
          data: analysis,
        },
        { onConflict: 'user_id,game_id' },
      );
      if (upErr) throw new Error(`upsert analysis: ${upErr.message}`);

      // Mirror what the browser queue does: stamp the derived summary onto the
      // game row so the Games table can render it from the light projection.
      // Without this, a pulled game would show no accuracy until the laptop's
      // boot recompute pass got round to it.
      // Reuse the app's own helper rather than re-deriving the ply-parity rule,
      // so the server can't drift from what the browser counts.
      const brilliantCount = countUserBrilliancies(analysis.moves, game.userColor);
      const { error: gErr } = await db.from('cloud_games').upsert(
        {
          user_id: cfg.userId,
          game_id: game.id,
          analysis_status: 'done',
          end_time: game.endTime,
          data: { ...game, analysisStatus: 'done', accuracy: acc, brilliantCount },
        },
        { onConflict: 'user_id,game_id' },
      );
      if (gErr) throw new Error(`upsert game: ${gErr.message}`);

      done++;
      if (done % 10 === 0 || done === candidates.length) {
        const elapsed = Date.now() - started;
        const rate = elapsed / done;
        const left = (candidates.length - done) * rate;
        const c = pool.stats;
        console.log(
          `  ${done}/${candidates.length}  ${fmtDuration(elapsed)} elapsed, ` +
            `~${fmtDuration(left)} left  ` +
            `cache ${c.hits}/${c.hits + c.misses} hits, ${c.bookSkips} book skips`,
        );
      }
    } catch (err) {
      failed++;
      console.error(`  ${c.gameId}: ${(err as Error).message}`);
      // Keep going. One unparseable PGN shouldn't end a multi-hour run, and the
      // next invocation will retry it.
      if (failed > 50 && failed > done) {
        console.error('Too many consecutive failures — stopping.');
        break;
      }
    }
  }

  pool.terminate();
  console.log(
    `\nDone: ${done} analyzed, ${failed} failed, in ${fmtDuration(Date.now() - started)}.`,
  );
  console.log('Now sync from the app to pull the results down.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
