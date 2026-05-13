import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  backupFilename,
  exportBackup,
  formatBytes,
  getStorageInfo,
  requestPersistentStorage,
  restoreBackup,
  type RestoreMode,
  type StorageInfo,
} from '@/db/backup';
import { db } from '@/db/schema';

/**
 * Backup / Restore page. The export uses `dexie-export-import` which
 * produces a single JSON blob containing every table; restore is
 * version-aware so a backup from an older schema upgrades cleanly.
 *
 * The same blob format will be the payload for cloud backup once Clerk
 * + Supabase land in Phase 2/3 — no separate format to maintain.
 */
export function BackupPage() {
  const { t } = useTranslation();
  const [info, setInfo] = useState<StorageInfo | null>(null);
  const [busy, setBusy] = useState<null | 'export' | 'restore'>(null);
  const [restoreMode, setRestoreMode] = useState<RestoreMode>('merge');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [counts, setCounts] = useState<{
    games: number;
    analyses: number;
    puzzles: number;
    repertoires: number;
    repertoireNodes: number;
    notes: number;
    evalCache: number;
  } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function refresh() {
    setInfo(await getStorageInfo());
    setCounts({
      games: await db.games.count(),
      analyses: await db.analyses.count(),
      puzzles: await db.puzzles.count(),
      repertoires: await db.repertoires.count(),
      repertoireNodes: await db.repertoireNodes.count(),
      notes: await db.notes.count(),
      evalCache: await db.evalCache.count(),
    });
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function handleExport() {
    setBusy('export');
    setError(null);
    setMessage(null);
    try {
      const blob = await exportBackup();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = backupFilename();
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setMessage(t('backup.downloaded', { size: formatBytes(blob.size) }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function handleRestore(file: File) {
    setBusy('restore');
    setError(null);
    setMessage(null);
    try {
      if (restoreMode === 'clear') {
        const ok = window.confirm(t('backup.wipeConfirm'));
        if (!ok) {
          setBusy(null);
          return;
        }
      }
      await restoreBackup(file, restoreMode);
      await refresh();
      setMessage(
        restoreMode === 'clear'
          ? t('backup.replaced')
          : restoreMode === 'overwrite'
            ? t('backup.importedOverwrite')
            : t('backup.importedMerge'),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function handlePersist() {
    const granted = await requestPersistentStorage();
    setInfo((prev) => (prev ? { ...prev, persistent: granted } : prev));
    if (granted) {
      setMessage(t('backup.persistentGranted'));
      setError(null);
    } else {
      setMessage(null);
      setError(t('backup.persistentDeclined'));
    }
  }

  const usagePct = info && info.quota > 0 ? Math.min(100, (info.usage / info.quota) * 100) : 0;

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t('backup.title')}</h1>
        <p className="text-sm text-text-muted">{t('backup.subtitle')}</p>
      </div>

      <section className="card p-4 space-y-3">
        <h2 className="font-medium">{t('backup.storage')}</h2>
        {info ? (
          info.supported ? (
            <>
              <div className="flex items-center justify-between text-sm">
                <span className="text-text-muted">
                  {t('backup.usedOf', { used: formatBytes(info.usage), total: formatBytes(info.quota) })}
                </span>
                <span
                  className={`text-xs px-2 py-0.5 rounded-md ${
                    info.persistent
                      ? 'bg-good/15 text-good'
                      : 'bg-bg-raised text-text-muted'
                  }`}
                >
                  {info.persistent ? t('backup.persistent') : t('backup.bestEffort')}
                </span>
              </div>
              <div className="h-2 rounded-full bg-bg-raised overflow-hidden">
                <div
                  className="h-full bg-accent/70"
                  style={{ width: `${usagePct.toFixed(2)}%` }}
                />
              </div>
              {!info.persistent && (
                <div className="flex items-center gap-3 text-xs text-text-muted">
                  <span>{t('backup.noPersistText')}</span>
                  <button type="button" className="btn whitespace-nowrap" onClick={handlePersist}>
                    {t('backup.requestPersistent')}
                  </button>
                </div>
              )}
            </>
          ) : (
            <div className="text-sm text-text-muted">
              {t('backup.noStorageApi')}
            </div>
          )
        ) : (
          <div className="text-sm text-text-muted">{t('backup.loading')}</div>
        )}

        {counts && (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2 text-xs pt-2">
            <Counter label={t('backup.counters.games')} value={counts.games} />
            <Counter label={t('backup.counters.analyses')} value={counts.analyses} />
            <Counter label={t('backup.counters.puzzles')} value={counts.puzzles} />
            <Counter label={t('backup.counters.repertoires')} value={counts.repertoires} />
            <Counter label={t('backup.counters.repNodes')} value={counts.repertoireNodes} />
            <Counter label={t('backup.counters.notes')} value={counts.notes} />
            <Counter label={t('backup.counters.evalCache')} value={counts.evalCache} />
          </div>
        )}
      </section>

      <section className="card p-4 space-y-3">
        <h2 className="font-medium">{t('backup.export')}</h2>
        <p className="text-sm text-text-muted">{t('backup.exportDesc')}</p>
        <div>
          <button
            type="button"
            className="btn-primary"
            onClick={handleExport}
            disabled={busy !== null}
          >
            {busy === 'export' ? t('backup.exporting') : t('backup.downloadBackup')}
          </button>
        </div>
      </section>

      <section className="card p-4 space-y-3">
        <h2 className="font-medium">{t('backup.restore')}</h2>
        <div className="space-y-2 text-sm">
          <label className="flex items-start gap-2">
            <input
              type="radio"
              name="restoreMode"
              value="merge"
              checked={restoreMode === 'merge'}
              onChange={() => setRestoreMode('merge')}
            />
            <span>
              <span className="font-medium">{t('backup.merge')}</span>
              <span className="text-text-muted">{t('backup.mergeDesc')}</span>
            </span>
          </label>
          <label className="flex items-start gap-2">
            <input
              type="radio"
              name="restoreMode"
              value="overwrite"
              checked={restoreMode === 'overwrite'}
              onChange={() => setRestoreMode('overwrite')}
            />
            <span>
              <span className="font-medium">{t('backup.overwrite')}</span>
              <span className="text-text-muted">{t('backup.overwriteDesc')}</span>
            </span>
          </label>
          <label className="flex items-start gap-2">
            <input
              type="radio"
              name="restoreMode"
              value="clear"
              checked={restoreMode === 'clear'}
              onChange={() => setRestoreMode('clear')}
            />
            <span>
              <span className="font-medium text-blunder">{t('backup.replaceEverything')}</span>
              <span className="text-text-muted">{t('backup.replaceDesc')}</span>
            </span>
          </label>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json,application/gzip,.gz,.json.gz"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void handleRestore(f);
          }}
        />
        <div>
          <button
            type="button"
            className="btn"
            onClick={() => fileRef.current?.click()}
            disabled={busy !== null}
          >
            {busy === 'restore' ? t('backup.restoring') : t('backup.chooseFile')}
          </button>
        </div>
      </section>

      {message && (
        <div className="card p-3 border-good/40 text-sm text-good">{message}</div>
      )}
      {error && (
        <div className="card p-3 border-blunder/40 text-sm text-blunder">{error}</div>
      )}
    </div>
  );
}

function Counter({ label, value }: { label: string; value: number }) {
  return (
    <div className="card p-2">
      <div className="text-text-muted">{label}</div>
      <div className="text-base font-semibold">{value.toLocaleString()}</div>
    </div>
  );
}
