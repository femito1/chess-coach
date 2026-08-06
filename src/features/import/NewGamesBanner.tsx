import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { useLocation } from 'react-router-dom';
import { db, getSettings, type Settings } from '@/db/schema';
import { listImportRecordsFor, recordImport } from '@/db/imports';
import { fetchArchives, fetchMonth, parseArchiveUrl } from '@/api/chesscom';
import { chessComGameToGame, gameIdFromUrl } from '@/import/importer';
import { upsertGames } from '@/db/queries';
import {
  planNewGameFetches,
  computeMissingGameCount,
  shouldCheckForNewGames,
  isDismissedForCount,
  isCacheEntryFresh,
  type LatestImportSnapshot,
} from './newGames';
import {
  NEW_GAMES_RECONCILE_EVENT,
  STORAGE_CACHE_KEY,
  STORAGE_DISMISSED_KEY,
  STORAGE_LAST_CHECKED_KEY,
  clearCacheEntry,
  clearDismissal,
  persistCacheEntry,
  persistDismissal,
  persistNumber,
  readCacheEntry,
  readDismissal,
  readNumber,
} from './newGamesStorage';

/**
 * Top-of-page banner that asks the returning user "you played N new
 * games on chess.com — want to import & analyze them?". Mounts in
 * `<AppLayout>` so it's reachable from every signed-in route, and
 * renders nothing on the steady "all caught up" path.
 *
 * Persistence model — important:
 *   - Successful checks cache `{count, archiveUrls, discoveredAt}` in
 *     localStorage (`STORAGE_CACHE_KEY`). On every mount, we paint
 *     the banner immediately from the cache so a page reload feels
 *     instant and the prompt does NOT disappear just because the user
 *     refreshed. This was the user-facing complaint: dismissals must
 *     be deliberate (× / Not now / Import), not accidental.
 *   - "Not now" writes a `DismissalState` to localStorage too, so the
 *     dismissal survives reloads (a refresh should not re-show what
 *     the user just dismissed). The dismissal expires after
 *     `NEW_GAMES_MIN_RECHECK_MS` OR when the count grows beyond
 *     what was dismissed (`isDismissedForCount`).
 *   - The chess.com fetch itself is throttled by `lastCheckedAt`
 *     (also in localStorage) so we don't hit the API on every
 *     reload — but the throttle does NOT suppress *rendering*; the
 *     cached entry above does that.
 *
 * Layout: a card with stacked copy + actions on phones (`flex-col`),
 * inline on >= sm (`sm:flex-row`). The action buttons are full-width
 * on phones for fat-finger comfort and inline on desktop. Tap targets
 * are min 36 px on phones (matches the existing mobile drawer + chip
 * conventions in `AppLayout` / `TimeClassFilter`).
 *
 * State machine:
 *   - hidden     — no count check has run yet, or the gate said no.
 *   - checking   — chess.com fetch in flight, but only after a
 *                  700 ms grace window so the typical "no new games"
 *                  path never paints anything.
 *   - prompting  — "X new games — Import & analyze | Not now". This
 *                  is the persistent state restored from cache on
 *                  reload.
 *   - importing  — progress label ("imported 12/45"). Banner stays
 *                  pinned through this state so the user sees their
 *                  click took effect.
 *   - done       — "Imported N new games — analysis is running."
 *                  Auto-hides after 6 s (the user's intent already
 *                  succeeded; lingering would just steal vertical
 *                  space).
 *   - error      — banner stays visible with a Try again + Dismiss.
 */
type State =
  | { kind: 'hidden' }
  | { kind: 'checking' }
  | { kind: 'prompting'; count: number; archiveUrls: string[] }
  | { kind: 'importing'; total: number; done: number }
  | { kind: 'done'; added: number }
  | { kind: 'error'; message: string; count: number; archiveUrls: string[] };

const CHECKING_GRACE_MS = 700;
const DONE_AUTO_HIDE_MS = 6000;

export function NewGamesBanner() {
  const { t } = useTranslation();
  const location = useLocation();
  const [state, setState] = useState<State>({ kind: 'hidden' });
  const [showCheckingUi, setShowCheckingUi] = useState(false);
  const startedRef = useRef(false);

  // On mount: paint immediately from the cached entry (so reload doesn't
  // wipe the prompt), then optionally fire a background re-check. The
  // extension entry route defers this until its selected game is stored;
  // otherwise a stale cached count can briefly include that same game.
  useEffect(() => {
    if (startedRef.current) return;
    if (location.pathname === '/review-by-url') return;
    startedRef.current = true;
    void boot(setState, setShowCheckingUi, t);
  }, [location.pathname, t]);

  useEffect(() => {
    const reconcile = () => {
      startedRef.current = true;
      setState({ kind: 'hidden' });
      void boot(setState, setShowCheckingUi, t, {
        forceCheck: true,
        hydrateCache: false,
      });
    };
    window.addEventListener(NEW_GAMES_RECONCILE_EVENT, reconcile);
    return () => window.removeEventListener(NEW_GAMES_RECONCILE_EVENT, reconcile);
  }, [t]);

  // Auto-hide the "Imported N — analysis running" success after a few
  // seconds. The user already saw their action succeed; pinning the
  // banner forever would steal layout space.
  useEffect(() => {
    if (state.kind !== 'done') return;
    const t = setTimeout(() => setState({ kind: 'hidden' }), DONE_AUTO_HIDE_MS);
    return () => clearTimeout(t);
  }, [state.kind]);

  if (state.kind === 'hidden') return null;
  if (state.kind === 'checking' && !showCheckingUi) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      // Phone-first: stacked layout with full-width buttons. At >= sm
      // it collapses to the inline desktop look. The wrapper uses the
      // same 1.5-rem gutter as the rest of the app chrome so the
      // banner lines up with page content underneath.
      className="mx-auto max-w-screen-2xl px-4 lg:px-8 mt-3"
    >
      <div className="rounded-md border border-accent/40 bg-accent/10 p-3 sm:py-3 sm:px-4 flex flex-col gap-3 sm:flex-row sm:items-start">
        <div className="flex items-start gap-3 flex-1 min-w-0">
          <BannerIcon kind={state.kind} />
          <div className="flex-1 min-w-0">
            <BannerCopy state={state} />
          </div>
          {/* Mobile-only ✕ tucked at the top-right of the copy column
              so dismissal is reachable without scrolling past the
              actions on a small viewport. Desktop uses the inline
              "Not now" button instead. */}
          <MobileCloseButton state={state} setState={setState} />
        </div>
        <BannerActions state={state} setState={setState} />
      </div>
    </div>
  );
}

function BannerIcon({ kind }: { kind: State['kind'] }) {
  if (kind === 'error') {
    return (
      <span aria-hidden className="mt-0.5 text-blunder text-base leading-none">!</span>
    );
  }
  if (kind === 'done') {
    return (
      <span aria-hidden className="mt-0.5 text-good text-base leading-none">✓</span>
    );
  }
  if (kind === 'checking' || kind === 'importing') {
    return (
      <span
        aria-hidden
        className="mt-1 inline-block w-3 h-3 rounded-full border-2 border-accent border-t-transparent animate-spin"
      />
    );
  }
  return (
    <span aria-hidden className="mt-0.5 text-accent text-base leading-none">♞</span>
  );
}

function BannerCopy({ state }: { state: State }) {
  const { t } = useTranslation();
  if (state.kind === 'checking') {
    return (
      <div className="font-medium text-text">{t('newGamesBanner.checking')}</div>
    );
  }
  if (state.kind === 'prompting') {
    return (
      <>
        <div className="font-medium text-text">
          {t('newGamesBanner.newGame', { count: state.count })}
        </div>
        <p className="text-text-muted mt-0.5 text-xs sm:text-sm">
          {t('newGamesBanner.newGameDesc')}
        </p>
      </>
    );
  }
  if (state.kind === 'importing') {
    return (
      <>
        <div className="font-medium text-text">
          {t('newGamesBanner.importing', { done: state.done, total: state.total, count: state.total })}
        </div>
        <p className="text-text-muted mt-0.5 text-xs sm:text-sm">
          {t('newGamesBanner.importingDesc')}
        </p>
      </>
    );
  }
  if (state.kind === 'done') {
    return (
      <div className="font-medium text-text">
        {state.added > 0
          ? t('newGamesBanner.imported', { count: state.added })
          : t('newGamesBanner.allCaughtUp')}
      </div>
    );
  }
  if (state.kind === 'error') {
    return (
      <>
        <div className="font-medium text-text">
          {state.count > 0
            ? t('newGamesBanner.couldNotImport', { count: state.count })
            : t('newGamesBanner.couldNotCheck')}
        </div>
        <p className="text-text-muted mt-0.5 break-words text-xs sm:text-sm">
          {state.message}
        </p>
      </>
    );
  }
  return null;
}

type SetState = Dispatch<SetStateAction<State>>;

function MobileCloseButton({
  state,
  setState,
}: {
  state: State;
  setState: SetState;
}) {
  const { t } = useTranslation();
  if (state.kind !== 'prompting' && state.kind !== 'error' && state.kind !== 'done') {
    return null;
  }
  return (
    <button
      type="button"
      // Visible on phones only. Desktop uses the inline action set
      // (Not now / Dismiss) so the ✕ would just be redundant chrome.
      className="sm:hidden -mr-1 -mt-1 inline-flex items-center justify-center w-8 h-8 rounded text-text-muted hover:text-text active:bg-bg-raised transition-colors shrink-0"
      onClick={() => {
        if (state.kind === 'prompting') {
          persistDismissal(state.count, Date.now());
        }
        setState({ kind: 'hidden' });
      }}
      aria-label={t('newGamesBanner.ariaDismiss')}
    >
      <span aria-hidden className="text-base leading-none">×</span>
    </button>
  );
}

function BannerActions({
  state,
  setState,
}: {
  state: State;
  setState: SetState;
}) {
  const { t } = useTranslation();
  // Buttons are full-width on phones (one per row) and inline-right
  // on >= sm. The 36 px-tall (`h-9`) targets match the existing
  // hamburger / chip conventions in the app.
  const baseRow =
    'flex flex-col sm:flex-row gap-2 sm:gap-2 sm:items-center sm:shrink-0';
  const baseBtn =
    'h-9 px-3 text-xs rounded-md border transition-colors inline-flex items-center justify-center';
  if (state.kind === 'prompting') {
    return (
      <div className={baseRow}>
        <button
          type="button"
          className={`${baseBtn} border-accent/60 bg-accent/20 text-accent hover:bg-accent/30 font-medium`}
          onClick={() => void doImport(state.count, state.archiveUrls, setState, t)}
        >
          {t('newGamesBanner.importAndAnalyze')}
        </button>
        <button
          type="button"
          className={`hidden sm:inline-flex ${baseBtn} border-border bg-bg-soft text-text-muted hover:text-text`}
          onClick={() => {
            persistDismissal(state.count, Date.now());
            setState({ kind: 'hidden' });
          }}
        >
          {t('newGamesBanner.notNow')}
        </button>
      </div>
    );
  }
  if (state.kind === 'error') {
    return (
      <div className={baseRow}>
        <button
          type="button"
          className={`${baseBtn} border-border bg-bg-soft text-text-muted hover:text-text`}
          onClick={() => void doImport(state.count, state.archiveUrls, setState, t)}
          disabled={state.count <= 0}
        >
          {t('newGamesBanner.tryAgain')}
        </button>
        <button
          type="button"
          className={`hidden sm:inline-flex ${baseBtn} border-border bg-bg-soft text-text-muted hover:text-text`}
          onClick={() => setState({ kind: 'hidden' })}
        >
          {t('newGamesBanner.dismiss')}
        </button>
      </div>
    );
  }
  return null;
}

/* =======================================================================
 *  Imperative shell: cache hydration + chess.com check + import.
 * ======================================================================= */

/**
 * Mount-time logic, split out so React's effect callback is tiny.
 *
 * Phase A — hydrate from cache. If we have a fresh, non-dismissed
 * cache entry for the current username, paint the prompt RIGHT NOW
 * so the page reload doesn't lose the "you have N new games" state.
 *
 * Phase B — decide whether to (re-)check chess.com. Honors the
 * `shouldCheckForNewGames` gate (rate limit + grace window). When we
 * already painted from cache, the (re)check still runs in the
 * background — but only if the throttle allows it — so the count
 * stays roughly current.
 */
async function boot(
  setState: SetState,
  setShowCheckingUi: (b: boolean) => void,
  t: TFunction,
  opts: { forceCheck?: boolean; hydrateCache?: boolean } = {},
): Promise<void> {
  let settings: Settings;
  try {
    settings = await getSettings();
  } catch {
    return;
  }
  const username = (settings.username ?? '').trim();
  if (!username) return;

  const records = await listImportRecordsFor('chesscom', username);
  if (records.length === 0) return;

  records.sort((a, b) => (b.year - a.year) * 12 + (b.month - a.month));
  const latestRecord = records[0]!;
  const latestImportAt = Math.max(...records.map((r) => r.importedAt));
  const now = Date.now();

  // Phase A — hydrate from cache (synchronous-ish).
  if (opts.hydrateCache !== false) {
    const cached = readCacheEntry();
    const dismissal = readDismissal();
    if (
      isCacheEntryFresh(cached, username, now) &&
      !isDismissedForCount(cached!.count, dismissal, now)
    ) {
      setState({
        kind: 'prompting',
        count: cached!.count,
        archiveUrls: cached!.archiveUrls,
      });
    }
  }

  // Phase B — refetch only when the throttle allows it.
  const lastCheckedAt = readNumber(STORAGE_LAST_CHECKED_KEY);
  const ok =
    opts.forceCheck === true ||
    shouldCheckForNewGames({
      username,
      onboardingCompletedAt: settings.onboardingCompletedAt,
      latestImportAt,
      lastCheckedAt,
      now,
    });
  if (!ok) return;

  await runCheck(username, latestRecord, setState, setShowCheckingUi, t);
}

async function runCheck(
  username: string,
  latestRecord: { archiveUrl: string; year: number; month: number; gameCount: number; importedAt: number },
  setState: SetState,
  setShowCheckingUi: (b: boolean) => void,
  _t: TFunction,
): Promise<void> {
  // Show a spinner only if the check takes more than ~700 ms, so a
  // hot-cache "no new games" path stays invisible even on the first
  // load. On reload we typically already painted from cache during
  // boot's Phase A, so this spinner won't appear at all.
  setState((s) => (s.kind === 'hidden' ? { kind: 'checking' } : s));
  const graceTimer = setTimeout(() => setShowCheckingUi(true), CHECKING_GRACE_MS);

  try {
    const archiveUrls = await fetchArchives(username);
    const latest: LatestImportSnapshot = {
      archiveUrl: latestRecord.archiveUrl,
      year: latestRecord.year,
      month: latestRecord.month,
      gameCount: latestRecord.gameCount,
      importedAt: latestRecord.importedAt,
    };
    const plans = planNewGameFetches(archiveUrls, latest);
    const archiveGameIds = new Map<string, string[]>();
    await Promise.all(
      plans.map(async (p) => {
        try {
          const games = await fetchMonth(p.archiveUrl);
          archiveGameIds.set(
            p.archiveUrl,
            games.map((game) => gameIdFromUrl(game.url)),
          );
        } catch {
          archiveGameIds.set(p.archiveUrl, []);
        }
      }),
    );
    const allIds = [...new Set([...archiveGameIds.values()].flat())];
    const existingRows = await db.games.bulkGet(allIds);
    const existingIds = new Set(
      existingRows.flatMap((game) => (game ? [game.id] : [])),
    );
    const { count, archiveUrls: archivesWithNewGames } = computeMissingGameCount(
      plans,
      archiveGameIds,
      existingIds,
    );

    persistNumber(STORAGE_LAST_CHECKED_KEY, Date.now());

    if (count <= 0) {
      // Caught up: clear any stale cache + dismissal so the next
      // session starts cleanly, and hide the banner.
      clearCacheEntry();
      clearDismissal();
      setState({ kind: 'hidden' });
      return;
    }

    // Persist the freshly-discovered count so a reload restores the
    // banner without another fetch.
    persistCacheEntry({
      username: username.trim().toLowerCase(),
      discoveredAt: Date.now(),
      count,
      archiveUrls: archivesWithNewGames,
    });

    const dismissal = readDismissal();
    if (isDismissedForCount(count, dismissal, Date.now())) {
      setState({ kind: 'hidden' });
      return;
    }

    setState({ kind: 'prompting', count, archiveUrls: archivesWithNewGames });
  } catch (err) {
    // Soft-fail: chess.com being briefly unreachable shouldn't
    // disrupt the user. If we already painted from cache during
    // Phase A, leave that state in place; otherwise just hide.
    console.warn('[NewGamesBanner] check failed', err);
    setState((s) => (s.kind === 'checking' ? { kind: 'hidden' } : s));
  } finally {
    clearTimeout(graceTimer);
    setShowCheckingUi(false);
  }
}

/**
 * Use the same per-archive logic as `ImportPage.doImport()` (and the
 * onboarding wizard's `importLastNMonths`) so the manual + banner
 * flows can interleave without stepping on each other. The analysis
 * queue is already booted from `<AppLayout>` and will pick up the
 * newly-imported `pending` games automatically — no extra wiring.
 */
async function doImport(
  expectedCount: number,
  archiveUrls: string[],
  setState: SetState,
  t: TFunction,
): Promise<void> {
  setState({ kind: 'importing', total: archiveUrls.length, done: 0 });

  let settings: Settings;
  try {
    settings = await getSettings();
  } catch (err) {
    setState({
      kind: 'error',
      message: err instanceof Error ? err.message : String(err),
      count: expectedCount,
      archiveUrls,
    });
    return;
  }
  const username = (settings.username ?? '').trim();
  if (!username) {
    setState({
      kind: 'error',
      message: t('newGamesBanner.noUsernameError'),
      count: expectedCount,
      archiveUrls,
    });
    return;
  }

  let added = 0;
  try {
    let done = 0;
    for (const url of archiveUrls) {
      const games = await fetchMonth(url);
      const mapped = games.map((g) => chessComGameToGame(g, username));
      const upsertRes = await upsertGames(mapped);
      added += upsertRes.added;
      const parsed = parseArchiveUrl(url);
      if (parsed) {
        await recordImport({
          source: 'chesscom',
          username,
          archiveUrl: url,
          year: parsed.year,
          month: parsed.month,
          gameCount: games.length,
          added: upsertRes.added,
          skipped: upsertRes.skipped,
        });
      }
      done++;
      setState({ kind: 'importing', total: archiveUrls.length, done });
    }
  } catch (err) {
    setState({
      kind: 'error',
      message: err instanceof Error ? err.message : String(err),
      count: expectedCount,
      archiveUrls,
    });
    return;
  }

  // User took the import path — they're caught up, so flush the
  // cache + dismissal so a future "you have N new games" prompt
  // appears unconditionally.
  clearCacheEntry();
  clearDismissal();
  // Stamp the last-checked timestamp too: we just observed the
  // current state of chess.com (via the import fetch), so a
  // subsequent banner check shouldn't immediately re-fire.
  persistNumber(STORAGE_LAST_CHECKED_KEY, Date.now());
  setState({ kind: 'done', added });
}

// Tiny escape-hatch for browser-driven tests that want to seed or
// inspect the persisted state. Not used in production code paths.
export const __test__ = {
  STORAGE_CACHE_KEY,
  STORAGE_DISMISSED_KEY,
  STORAGE_LAST_CHECKED_KEY,
  readCacheEntry,
  readDismissal,
};
