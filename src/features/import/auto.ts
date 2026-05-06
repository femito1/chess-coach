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
import { chessComGameToGame } from '@/import/importer';
import { upsertGames } from '@/db/queries';
import { recordImport } from '@/db/imports';

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
function sortArchivesNewestFirst(urls: string[]): string[] {
  const enriched = urls.map((url) => {
    const p = parseArchiveUrl(url);
    return { url, sortKey: p ? p.year * 12 + p.month : -1 };
  });
  enriched.sort((a, b) => b.sortKey - a.sortKey);
  return enriched.map((e) => e.url);
}
