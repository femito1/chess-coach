import { useTranslation } from 'react-i18next';
import { countsTotal } from './cloudSync';
import { useCloudProgress, useManualSync } from './useCloudSync';

/**
 * Settings card for cloud sync.
 *
 * Renders nothing at all unless this account is enrolled in
 * `cloud_sync_allowlist`. Sync is deliberately a single-account feature (see
 * `supabase/cloud-sync.sql` for why), so for everyone else the card would be a
 * control they can't use — worse than absent.
 *
 * The `checking` state also renders nothing, so the card doesn't flash in and
 * out on every Settings visit while the allowlist query is in flight.
 */
export function CloudSyncCard() {
  const { t } = useTranslation();
  const { phase, last, session, sessionTotal, syncNow, canSync } = useManualSync();
  // Same condition the early return below uses. Computed BEFORE it, because a
  // hook cannot be called conditionally — the flag is what keeps the hook from
  // issuing requests RLS would refuse, or polling for an account that will never
  // have cloud rows.
  const syncAvailable =
    phase.kind !== 'idle' && phase.kind !== 'checking' && phase.kind !== 'disabled';
  const progress = useCloudProgress(syncAvailable);

  if (!syncAvailable) return null;

  return (
    <section className="card p-4 space-y-3">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h2 className="font-medium">{t('sync.title')}</h2>
          <p className="text-sm text-text-muted mt-0.5">{t('sync.description')}</p>
        </div>
        <button
          type="button"
          className="btn text-xs shrink-0"
          onClick={syncNow}
          disabled={!canSync}
        >
          {phase.kind === 'syncing' ? t('sync.syncing') : t('sync.syncNow')}
        </button>
      </div>

      {phase.kind === 'syncing' && (
        <div className="space-y-1.5">
          <div className="flex justify-between text-xs text-text-muted tabular-nums">
            <span>{t(`sync.phase.${phase.progress.phase}`)}</span>
            {phase.progress.total > 0 && (
              <span>
                {phase.progress.done} / {phase.progress.total}
              </span>
            )}
          </div>
          {/* Indeterminate during the manifest step (no total yet), a real bar
              once we know how much there is to move. A first sync can shift
              tens of megabytes, so a frozen spinner would look broken. */}
          <div className="h-1 rounded bg-bg-raised overflow-hidden">
            <div
              className="h-full bg-accent transition-[width] duration-300"
              style={{
                width:
                  phase.progress.total > 0
                    ? `${Math.min(100, (phase.progress.done / phase.progress.total) * 100)}%`
                    : '15%',
              }}
            />
          </div>
        </div>
      )}

      {/* Server-side analysis progress.
       *
       * Counts only (see `cloudProgress.ts`), so this stays cheap enough to
       * poll. It exists because the server worker in `scripts/worker/` can run
       * for hours and the only previous way to watch it was its stdout — the app
       * that consumes its output couldn't see it working. */}
      <div className="rounded border border-border/60 p-2.5 space-y-1.5">
        <div className="flex items-baseline justify-between gap-2 flex-wrap">
          <h3 className="text-xs font-medium">{t('sync.cloud.title')}</h3>
          <button
            type="button"
            className="text-[11px] text-accent hover:underline disabled:opacity-50 disabled:no-underline"
            onClick={progress.refresh}
            disabled={progress.loading}
          >
            {progress.loading ? t('sync.cloud.refreshing') : t('sync.cloud.refresh')}
          </button>
        </div>

        {progress.summary && !progress.summary.empty && (
          <>
            <div className="flex justify-between gap-2 text-xs text-text-muted tabular-nums">
              <span>
                {t('sync.cloud.progress', {
                  analyzed: progress.summary.analyses,
                  games: progress.summary.games,
                })}
              </span>
              <span>
                {progress.summary.allNnue
                  ? t('sync.cloud.allNnue')
                  : t('sync.cloud.nnue', { nnue: progress.summary.nnueAnalyses })}
              </span>
            </div>
            <div className="h-1 rounded bg-bg-raised overflow-hidden">
              {/* Two stacked widths on one track: total analyzed sets the bar,
                  and the NNUE share fills it in the accent colour, so "analyzed"
                  and "analyzed *well*" are legible at a glance. */}
              <div
                className="h-full bg-accent/40 transition-[width] duration-300"
                style={{ width: `${progress.summary.percent}%` }}
              >
                <div
                  className="h-full bg-accent transition-[width] duration-300"
                  style={{
                    width:
                      progress.summary.analyses > 0
                        ? `${(progress.summary.nnueAnalyses / progress.summary.analyses) * 100}%`
                        : '0%',
                  }}
                />
              </div>
            </div>
            {progress.summary.classicalAnalyses > 0 && (
              <p className="text-[11px] text-text-muted">
                {/* Interpolated as `n`, not `count`: i18next reads a `count`
                    variable as a plural selector and would look for
                    `classicalPending_one` / `_other` keys we don't ship. */}
                {t('sync.cloud.classicalPending', {
                  n: progress.summary.classicalAnalyses,
                })}
              </p>
            )}
          </>
        )}

        {progress.summary?.empty && (
          <p className="text-[11px] text-text-muted">{t('sync.cloud.empty')}</p>
        )}

        {progress.error && !progress.summary && (
          <p className="text-[11px] text-text-muted">{t('sync.cloud.failed')}</p>
        )}

        <p className="text-[11px] text-text-muted">
          {progress.refreshedAt !== null &&
            `${t('sync.cloud.updatedAt', { at: formatTime(progress.refreshedAt) })} · `}
          {t('sync.cloud.hint')}
        </p>
      </div>

      {phase.kind === 'error' && (
        <div
          role="alert"
          className="text-xs rounded border border-blunder/40 bg-blunder/10 p-2 space-y-1"
        >
          <div className="font-medium text-blunder">{t('sync.failed')}</div>
          <div className="text-text-muted font-mono break-words">{phase.message}</div>
        </div>
      )}

      {phase.kind === 'ready' && last && (
        <div className="text-xs text-text-muted space-y-0.5">
          <div>
            {countsTotal(last) === 0
              ? t('sync.upToDate', { at: formatTime(last.at) })
              : t('sync.lastRun', {
                  at: formatTime(last.at),
                  seconds: Math.max(1, Math.round(last.durationMs / 1000)),
                })}
          </div>
          {countsTotal(last) > 0 && (
            <ul className="pl-4 list-disc space-y-0.5">
              {last.gamesPushed + last.gamesPulled > 0 && (
                <li>
                  {t('sync.games', {
                    up: last.gamesPushed,
                    down: last.gamesPulled,
                  })}
                </li>
              )}
              {last.analysesPushed + last.analysesPulled > 0 && (
                <li>
                  {t('sync.analyses', {
                    up: last.analysesPushed,
                    down: last.analysesPulled,
                  })}
                  {last.bytesPushed > 0 && ` · ${formatBytes(last.bytesPushed)}`}
                </li>
              )}
              {last.attemptsPushed + last.attemptsPulled > 0 && (
                <li>
                  {t('sync.puzzles', {
                    up: last.attemptsPushed,
                    down: last.attemptsPulled,
                  })}
                </li>
              )}
            </ul>
          )}
        </div>
      )}

      {phase.kind === 'ready' && !last && (
        <p className="text-xs text-text-muted">{t('sync.notYetRun')}</p>
      )}

      {sessionTotal > 0 && (
        <p className="text-[11px] text-text-muted">
          {t('sync.sessionTotal', {
            up:
              session.gamesPushed + session.analysesPushed + session.attemptsPushed,
            down:
              session.gamesPulled + session.analysesPulled + session.attemptsPulled,
          })}
        </p>
      )}

      <p className="text-[11px] text-text-muted">{t('sync.archiveNote')}</p>
    </section>
  );
}

function formatTime(at: number): string {
  return new Date(at).toLocaleTimeString();
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
