import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { importGameByUrl } from '@/features/import/auto';
import { getSettings } from '@/db/schema';

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
 * Behaviour:
 *  - Validate params; if anything's missing, render a clear error
 *    state with a link back to the manual import page.
 *  - Call `importGameByUrl(...)`. The function short-circuits when the
 *    game is already in IndexedDB so a re-click is instant.
 *  - On success, `navigate('/review/<id>', { replace: true })` so the
 *    deep link doesn't pollute the history stack.
 *  - On failure (game not in the player's recent archives, network
 *    error, etc.), show the error and a "Try manually" link.
 *
 * The page intentionally does NOT wait for analysis to finish — the
 * background queue picks the new pending game up automatically (it's
 * the newest by `endTime`, so newest-first scheduling fires it
 * immediately) and the review page already handles the "still
 * analyzing" state with a placeholder.
 */
export function ImportAndReviewPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();

  const gameUrl = params.get('url') ?? '';
  const usernameParam = params.get('username') ?? '';
  const endTimeRaw = params.get('endTime');
  const endTime = endTimeRaw ? Number(endTimeRaw) : undefined;

  const [status, setStatus] = useState<'pending' | 'error'>('pending');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        if (!gameUrl) throw new Error('Missing `url` parameter');
        // Prefer the explicit username from the deep link, but fall
        // back to the locally-bound username if the extension couldn't
        // detect one (e.g. the user is logged into chess.com but the
        // extension permission was denied). This keeps the link
        // useful in degraded conditions.
        let u = usernameParam.trim();
        if (!u) {
          const settings = await getSettings();
          u = settings.username;
        }
        if (!u) {
          throw new Error(
            'No Chess.com username found. Open Settings → set a username, then retry the link.',
          );
        }
        const { gameId } = await importGameByUrl(u, gameUrl, { endTime });
        if (cancelled) return;
        navigate(`/review/${gameId}`, { replace: true });
      } catch (err) {
        if (cancelled) return;
        setStatus('error');
        setErrorMsg(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [gameUrl, usernameParam, endTime, navigate]);

  if (status === 'pending') {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <div className="rounded-lg border border-border bg-bg-soft px-8 py-6 text-center">
          <div className="mx-auto mb-3 h-6 w-6 animate-spin rounded-full border-2 border-accent border-t-transparent" />
          <h1 className="text-lg font-semibold">Importing your game…</h1>
          <p className="mt-1 text-sm text-text-muted">
            Pulling it from Chess.com and queueing analysis.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <div className="max-w-md rounded-lg border border-border bg-bg-soft px-6 py-5">
        <h1 className="text-lg font-semibold text-text">Couldn't import that game</h1>
        <p className="mt-2 text-sm text-text-muted">
          {errorMsg ?? 'Unknown error.'}
        </p>
        <p className="mt-4 text-sm">
          <a
            href="/import"
            className="text-accent underline-offset-2 hover:underline"
          >
            Open the manual import page
          </a>
          {' '}— if the game is in a recent month it'll show up there.
        </p>
      </div>
    </div>
  );
}
