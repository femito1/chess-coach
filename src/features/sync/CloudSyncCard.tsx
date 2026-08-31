import { useTranslation } from 'react-i18next';
import { countsTotal } from './cloudSync';
import { useManualSync } from './useCloudSync';

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

  if (phase.kind === 'idle' || phase.kind === 'checking' || phase.kind === 'disabled') {
    return null;
  }

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
