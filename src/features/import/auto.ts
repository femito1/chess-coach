/**
 * Programmatic, non-UI version of the per-month import flow that
 * `ImportPage` exposes. Used by the onboarding wizard ("import the
 * user's last 1 / 3 / 12 months") and (future) by a one-click
 * "expand history" button on the Settings page.
 *
 * Wire calls + dedup + record-keeping match `ImportPage.doImport()`
 * exactly so the manual flow and this auto flow can interleave without
 * stepping on each other.
 */

import { fetchArchives, fetchMonth, parseArchiveUrl } from '@/api/chesscom';
import type { ChessComGame } from '@/api/chesscom';
import { chessComGameToGame, gameIdFromUrl } from '@/import/importer';
import { upsertGames } from '@/db/queries';
import { recordImport } from '@/db/imports';
import { db } from '@/db/schema';
import {
  candidateGameIdsForUrl,
  candidateMonths,
  extractChessComGameId,
  monthArchiveUrl,
} from './urlShape';

export interface AutoImportProgress {
  archiveUrl: string;
  /** 1-based: the i-th archive that finished. */
  done: number;
  /** Total archives this run will try to import. */
  total: number;
  /** Cumulative count across the run so the UI can render
   *  "imported X games so far". */
  added: number;
  skipped: number;
}

export interface AutoImportResult {
  monthsImported: number;
  added: number;
  skipped: number;
  /** Archive URLs touched, newest first (same order as processing). */
  archives: string[];
}

interface AutoImportOpts {
  /**
   * Optional progress callback fired once per archive *after* the
   * upsert + recordImport have both landed. The wizard renders a
   * progress bar from this; passing nothing skips it.
   */
  onProgress?: (p: AutoImportProgress) => void;
}

/**
 * Pull the most-recent N months of games for `username` and upsert
 * them into IndexedDB. Pass `n = Infinity` to import every archive on
 * file.
 *
 * Throws on the first network or upsert error rather than half-
 * importing silently — the wizard catches it and tells the user
 * "couldn't finish; you can retry from the Import page", which is much
 * nicer than ending up with 6 of 12 months and no indication that
 * anything went wrong.
 */
export async function importLastNMonths(
  username: string,
  n: number,
  opts: AutoImportOpts = {},
): Promise<AutoImportResult> {
  const u = username.trim();
  if (!u) throw new Error('importLastNMonths: empty username');
  const safeN = n === Infinity ? Infinity : Math.max(0, Math.floor(n));
  if (safeN === 0) {
    return { monthsImported: 0, added: 0, skipped: 0, archives: [] };
  }

  const allArchiveUrls = await fetchArchives(u);
  const sorted = sortArchivesNewestFirst(allArchiveUrls);
  const targets = safeN === Infinity ? sorted : sorted.slice(0, safeN);

  let added = 0;
  let skipped = 0;
  const archives: string[] = [];
  let done = 0;

  for (const archiveUrl of targets) {
    const games = await fetchMonth(archiveUrl);
    const mapped = games.map((g) => chessComGameToGame(g, u));
    const upsertRes = await upsertGames(mapped);
    added += upsertRes.added;
    skipped += upsertRes.skipped;

    const parsed = parseArchiveUrl(archiveUrl);
    if (parsed) {
      await recordImport({
        source: 'chesscom',
        username: u,
        archiveUrl,
        year: parsed.year,
        month: parsed.month,
        gameCount: games.length,
        added: upsertRes.added,
        skipped: upsertRes.skipped,
      });
    }

    archives.push(archiveUrl);
    done++;
    opts.onProgress?.({
      archiveUrl,
      done,
      total: targets.length,
      added,
      skipped,
    });
  }

  return { monthsImported: archives.length, added, skipped, archives };
}

/**
 * Sort archive URLs by `(year, month)` descending. Chess.com returns
 * them in chronological (oldest-first) order; we want the most recent
 * months first so `slice(0, n)` returns "the last N months" rather than
 * "the first N months ever".
 *
 * Archives that don't parse (shouldn't happen — Chess.com URLs are
 * stable) sort to the end so a malformed entry can't push a real one
 * out of the top-N.
 */
/**
 * Import a single Chess.com game identified by its public game URL
 * (e.g. `https://www.chess.com/game/live/12345678901`). Used by the
 * Chrome extension's "Review in Chess Coach" deep link.
 *
 * Chess.com's published-data API has no per-game endpoint, so we have
 * to fetch the user's monthly archive and locate the matching game by
 * URL. To avoid scanning every month back to 2007, we accept an
 * optional `endTime` hint (epoch ms, as the extension can read from
 * the chess.com page) and start at that month, then fall back to the
 * current month + the previous one. In the worst case we scan two
 * months — bounded, predictable, fast.
 *
 * If the game is already in IndexedDB (deterministic id = hash(url)),
 * we short-circuit and just return its id without re-fetching the
 * archive. That makes the deep link instant on the second click.
 */
export interface ImportGameByUrlResult {
  gameId: string;
  /** True when we hit the IndexedDB short-circuit and didn't re-fetch
   *  the archive. */
  alreadyImported: boolean;
}

export async function importGameByUrl(
  username: string,
  gameUrl: string,
  opts: { endTime?: number } = {},
): Promise<ImportGameByUrlResult> {
  const u = username.trim();
  if (!u) throw new Error('importGameByUrl: empty username');
  if (!gameUrl) throw new Error('importGameByUrl: empty gameUrl');

  // Short-circuit: if a row with the deterministic id derived from the
  // exact URL we were handed already exists, we're done. We also try
  // the URL-shape variant (chess.com uses `/game/live/<id>` on the
  // page and `/live/game/<id>` in the published-data API in some
  // historical responses), so a re-click after an import done via the
  // other shape still hits the cache.
  const candidateIds = candidateGameIdsForUrl(gameUrl, gameIdFromUrl);
  for (const id of candidateIds) {
    const existing = await db.games.get(id);
    if (existing) {
      return { gameId: id, alreadyImported: true };
    }
  }

  const targetGameId = extractChessComGameId(gameUrl);

  // Try the month containing `endTime` first, then current month, then
  // previous month. Each fallback is a single Chess.com archive fetch.
  const monthsToTry = candidateMonths(opts.endTime);

  for (const { year, month } of monthsToTry) {
    const archiveUrl = monthArchiveUrl(u, year, month);
    let games: ChessComGame[];
    try {
      games = await fetchMonth(archiveUrl);
    } catch {
      // 404s on never-played months are normal — keep walking.
      continue;
    }
    // Match by exact URL first (the common case), then by extracted
    // numeric id (covers the `/game/live/` ↔ `/live/game/` shape
    // mismatch that has popped up historically — chess.com flipped
    // the path segments at least once).
    const hit =
      games.find((g) => g.url === gameUrl) ??
      (targetGameId
        ? games.find((g) => extractChessComGameId(g.url) === targetGameId)
        : undefined);
    if (hit) {
      // Upsert ALL games from that month so the user gets the
      // surrounding context for free, and so re-clicking "Review"
      // on adjacent games is instant.
      const mapped = games.map((g) => chessComGameToGame(g, u));
      const upsertRes = await upsertGames(mapped);
      await recordImport({
        source: 'chesscom',
        username: u,
        archiveUrl,
        year,
        month,
        gameCount: games.length,
        added: upsertRes.added,
        skipped: upsertRes.skipped,
      });
      // The id we return is the one derived from chess.com's *own*
      // URL for the game, so /review/:id matches what the rest of
      // the app stored.
      return { gameId: gameIdFromUrl(hit.url), alreadyImported: false };
    }
  }

  throw new Error(
    `importGameByUrl: could not find ${gameUrl} in the last few archives for ${u}`,
  );
}

function sortArchivesNewestFirst(urls: string[]): string[] {
  const enriched = urls.map((url) => {
    const p = parseArchiveUrl(url);
    return { url, sortKey: p ? p.year * 12 + p.month : -1 };
  });
  enriched.sort((a, b) => b.sortKey - a.sortKey);
  return enriched.map((e) => e.url);
}
