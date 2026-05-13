import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { importGameByUrl } from '@/features/import/auto';
import { db, getSettings } from '@/db/schema';
import { EngineCockpit } from '@/engine/EngineCockpit';

/**
 * Deep-link entry point for the Chrome extension's "Review in Chess
 * Coach" CTA. Mounted at `/review-by-url` and reachable from any URL of
 * the form:
 *
 *   /review-by-url?url=<chess.com game url>&username=<chesscom user>&endTime=<ms>
 *
 * `username` is required because Chess.com's pub-data API is keyed on
 * the player's archive — there is no per-game endpoint. The extension
 * passes both because it can read both straight off the chess.com
 * page. `endTime` is an optional epoch-ms hint used to scope the
 * archive lookup to the right month; without it we fall back to the
 * current month and the previous one, which is fine for any game the
 * user just finished.
 *
 * Two-phase UX (Pass 7, 2026-05-12):
 *   Phase A — *fetching*: the Chess.com archive is downloaded and the
 *     game is upserted into IndexedDB. Usually <2 s on a good network;
 *     pinned at the top of the page with a small spinner.
 *   Phase B — *analyzing*: the analysis queue picks the new pending
 *     game up automatically (newest-first scheduling) and Stockfish
 *     starts working through every ply. Wallclock is highly machine-
 *     dependent — a 40-move game on a multi-thread build at default
 *     depth takes roughly 30–90 s. Instead of an opaque spinner we
 *     surface the *engine itself* via `<EngineCockpit>`: live PV,
 *     depth counter, NPS / nodes, and a mini-board showing the
 *     position the engine is currently looking at with its
 *     best-move arrow. This is the "Stockfish brain" landing
 *     experience for the extension flow — way more interesting than
 *     a 60-second progress bar.
 *
 * On Phase B completion (`game.analysisStatus === 'done'`) the page
 * navigates to `/review/<id>` automatically. There's also a manual
 * "Skip to review now" button so power users who don't want to wait
 * for the cockpit can drop straight onto the review page (where the
 * partial-analysis state will fill in as the engine catches up).
 *
 * Failure modes:
 *   - Phase A error (game not in archives, bad URL, etc.) — render
 *     a clear error card with a link back to the manual import page.
 *   - Phase B error (engine error during analysis) — surface a
 *     "Something went wrong with analysis" callout with a Retry-this-
 *     game button; the underlying queue's auto-heal pass also picks
 *     stuck games up next boot.
 */
export function ImportAndReviewPage() {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const navigate = useNavigate();

  const gameUrl = params.get('url') ?? '';
  const usernameParam = params.get('username') ?? '';
  const endTimeRaw = params.get('endTime');
  const endTime = endTimeRaw ? Number(endTimeRaw) : undefined;

  // 'fetching'    — we're hitting chess.com / writing the row.
  // 'analyzing'   — game row exists; we're waiting for the queue to
  //                 finish analysis. Cockpit is rendered.
  // 'error'       — Phase A or Phase B errored.
  const [phase, setPhase] = useState<'fetching' | 'analyzing' | 'error'>('fetching');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [importedGameId, setImportedGameId] = useState<string | null>(null);

  // Phase A: import the game. Same logic as before — only the post-
  // import side effect changed (no longer auto-navigates).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        if (!gameUrl) throw new Error(t('importAndReview.missingUrl'));
        let u = usernameParam.trim();
        if (!u) {
          const settings = await getSettings();
          u = settings.username;
        }
        if (!u) {
          throw new Error(t('importAndReview.noUsernameSettings'));
        }
        const { gameId } = await importGameByUrl(u, gameUrl, { endTime });
        if (cancelled) return;
        setImportedGameId(gameId);
        setPhase('analyzing');
      } catch (err) {
        if (cancelled) return;
        setPhase('error');
        setErrorMsg(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [gameUrl, usernameParam, endTime]);

  // Phase B: watch the imported game's analysis status. Live-query
  // because the analyzer writes to the same row from another tick;
  // when status flips to 'done' or 'error' we transition.
  const game = useLiveQuery(
    () => (importedGameId ? db.games.get(importedGameId) : undefined),
    [importedGameId],
  );

  useEffect(() => {
    if (!game || !importedGameId) return;
    if (game.analysisStatus === 'done') {
      navigate(`/review/${importedGameId}`, { replace: true });
    } else if (game.analysisStatus === 'error') {
      setPhase('error');
      setErrorMsg(
        game.analysisError ??
          t('importAndReview.engineErrored'),
      );
    }
  }, [game, importedGameId, navigate, t]);

  if (phase === 'error') {
    return <ErrorCard message={errorMsg} />;
  }

  if (phase === 'fetching') {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <div className="rounded-lg border border-border bg-bg-soft px-8 py-6 text-center max-w-sm">
          <div className="mx-auto mb-3 h-6 w-6 animate-spin rounded-full border-2 border-accent border-t-transparent" />
          <h1 className="text-lg font-semibold">{t('importAndReview.fetchingTitle')}</h1>
          <p className="mt-1 text-sm text-text-muted">
            {t('importAndReview.fetchingSubtitle')}
          </p>
        </div>
      </div>
    );
  }

  // phase === 'analyzing'
  return (
    <div className="mx-auto max-w-2xl space-y-3">
      <EngineCockpit
        title={t('importAndReview.analyzingTitle')}
        subtitle={t('importAndReview.analyzingSubtitle')}
        gameId={importedGameId ?? undefined}
        pgn={game?.pgn}
      />
      <div className="flex items-center justify-end">
        <button
          type="button"
          className="btn text-xs"
          onClick={() =>
            importedGameId &&
            navigate(`/review/${importedGameId}`, { replace: true })
          }
        >
          {t('importAndReview.skipToReview')}
        </button>
      </div>
    </div>
  );
}

function ErrorCard({ message }: { message: string | null }) {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <div className="max-w-md rounded-lg border border-border bg-bg-soft px-6 py-5">
        <h1 className="text-lg font-semibold text-text">{t('importAndReview.errorTitle')}</h1>
        <p className="mt-2 text-sm text-text-muted">
          {message ?? t('importAndReview.unknownError')}
        </p>
        <p className="mt-4 text-sm">
          <a
            href="/import"
            className="text-accent underline-offset-2 hover:underline"
          >
            {t('importAndReview.openManualImport')}
          </a>
          {t('importAndReview.errorPostlude')}
        </p>
      </div>
    </div>
  );
}
