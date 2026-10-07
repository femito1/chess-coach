import { parseArchiveUrl } from '@/api/chesscom';
import { sortArchivesNewestFirst } from '@/features/import/newGames';

/**
 * Which Chess.com monthly archives the off-laptop worker should import.
 *
 * Lives in `src/` beside `selectCandidates` for the same reasons: it is pure
 * policy with no I/O, so it belongs in the unit tier, and importing it from a
 * test must not drag in the worker's `main()`.
 *
 * The rule is anchored on the newest game the cloud already holds, not on "the
 * last N months". Every archive from one month before that game's month through
 * the newest archive is selected, which makes a missed night — or a disabled
 * scheduler, or a month away from chess — heal itself on the next run rather
 * than leaving a hole nothing will ever revisit.
 *
 *  - The anchor's own month is re-read on purpose: it is the month still
 *    receiving games, and import is idempotent by game id.
 *  - The month *before* it is re-read too. Archives are bucketed by Chess.com,
 *    not by us, and a game played across midnight on the last of the month can
 *    sit in the earlier archive while ending in the later one. One extra small
 *    fetch a night is the price of not having to know their rule.
 *
 * With no anchor the answer is nothing. A first import is a decision about how
 * much history to pull — the onboarding wizard asks — and a worker that decided
 * it alone would fetch years of archives on its first night.
 */
export function selectImportArchives(
  archiveUrls: readonly string[],
  newestEndTimeMs: number | null,
): string[] {
  if (newestEndTimeMs == null || !Number.isFinite(newestEndTimeMs)) return [];
  const d = new Date(newestEndTimeMs);
  // Month index (year * 12 + month, 1-based month), same key
  // `sortArchivesNewestFirst` sorts by. UTC because Chess.com's archive
  // boundaries are, and the laptop's timezone is not the server's.
  const anchor = d.getUTCFullYear() * 12 + (d.getUTCMonth() + 1);
  const from = anchor - 1;
  return sortArchivesNewestFirst([...archiveUrls]).filter((url) => {
    const p = parseArchiveUrl(url);
    return p != null && p.year * 12 + p.month >= from;
  });
}
