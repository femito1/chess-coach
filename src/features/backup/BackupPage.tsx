import { useEffect, useRef, useState } from 'react';
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
      setMessage(`Downloaded ${formatBytes(blob.size)}.`);
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
        const ok = window.confirm(
          'Wipe all local data and replace it with the backup? This cannot be undone.',
        );
        if (!ok) {
          setBusy(null);
          return;
        }
      }
      await restoreBackup(file, restoreMode);
      await refresh();
      setMessage(
        restoreMode === 'clear'
          ? 'Local database replaced with backup contents.'
          : restoreMode === 'overwrite'
            ? 'Backup imported (existing rows overwritten on collision).'
            : 'Backup imported (existing rows kept on collision).',
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
      setMessage('Persistent storage granted — the browser will not evict your data.');
      setError(null);
    } else {
      // Chromium-based browsers (Chrome, Edge, Brave, Arc) auto-grant
      // this only when the site looks "engaged" — bookmarked, installed
      // as a PWA, frequently visited, granted notifications, etc.
      // Firefox shows a permission prompt on the first call. Safari may
      // silently auto-deny. None of these failure modes mean the data
      // is gone — IndexedDB still works the same — they just mean the
      // browser is allowed to evict under disk pressure.
      setMessage(null);
      setError(
        "The browser declined the persistence request. Your data is still saved, " +
          "but the browser is allowed to evict it under heavy disk pressure. " +
          "Chrome/Edge usually auto-grant this once you bookmark the site, install it " +
          "as a PWA, or visit it a few more times. Firefox shows a prompt the first " +
          "time. Until then, exporting backups is the safety net.",
      );
    }
  }

  const usagePct = info && info.quota > 0 ? Math.min(100, (info.usage / info.quota) * 100) : 0;

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Backup &amp; restore</h1>
        <p className="text-sm text-text-muted">
          All your games, analyses, puzzles, and repertoires live in this browser&rsquo;s IndexedDB.
          Export a snapshot to move between machines or guard against accidental data loss.
        </p>
      </div>

      <section className="card p-4 space-y-3">
        <h2 className="font-medium">Storage</h2>
        {info ? (
          info.supported ? (
            <>
              <div className="flex items-center justify-between text-sm">
                <span className="text-text-muted">
                  {formatBytes(info.usage)} used of {formatBytes(info.quota)}
                </span>
                <span
                  className={`text-xs px-2 py-0.5 rounded-md ${
                    info.persistent
                      ? 'bg-good/15 text-good'
                      : 'bg-bg-raised text-text-muted'
                  }`}
                >
                  {info.persistent ? 'Persistent' : 'Best-effort'}
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
                  <span>
                    Without persistent storage, the browser may evict this database under heavy
                    disk pressure.
                  </span>
                  <button type="button" className="btn whitespace-nowrap" onClick={handlePersist}>
                    Request persistent
                  </button>
                </div>
              )}
            </>
          ) : (
            <div className="text-sm text-text-muted">
              This browser doesn&rsquo;t expose <code>navigator.storage</code>. Backups still work.
            </div>
          )
        ) : (
          <div className="text-sm text-text-muted">Loading…</div>
        )}

        {counts && (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2 text-xs pt-2">
            <Counter label="Games" value={counts.games} />
            <Counter label="Analyses" value={counts.analyses} />
            <Counter label="Puzzles" value={counts.puzzles} />
            <Counter label="Repertoires" value={counts.repertoires} />
            <Counter label="Rep. nodes" value={counts.repertoireNodes} />
            <Counter label="Notes" value={counts.notes} />
            <Counter label="Eval cache" value={counts.evalCache} />
          </div>
        )}
      </section>

      <section className="card p-4 space-y-3">
        <h2 className="font-medium">Export</h2>
        <p className="text-sm text-text-muted">
          Downloads a single gzip-compressed JSON file with every table. The
          uncompressed format is the official
          <code className="mx-1">dexie-export-import</code>
          shape and includes the schema version, so it restores cleanly even
          after future upgrades. Restore accepts both this <code>.json.gz</code>
          and any older <code>.json</code> backup.
        </p>
        <div>
          <button
            type="button"
            className="btn-primary"
            onClick={handleExport}
            disabled={busy !== null}
          >
            {busy === 'export' ? 'Exporting…' : 'Download backup'}
          </button>
        </div>
      </section>

      <section className="card p-4 space-y-3">
        <h2 className="font-medium">Restore</h2>
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
              <span className="font-medium">Merge</span>
              <span className="text-text-muted">
                {' '}
                — add rows from the backup, keep existing rows on key collision. Safe.
              </span>
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
              <span className="font-medium">Overwrite on collision</span>
              <span className="text-text-muted">
                {' '}
                — backup wins if a row already exists locally with the same id.
              </span>
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
              <span className="font-medium text-blunder">Replace everything</span>
              <span className="text-text-muted">
                {' '}
                — wipe local data first, then import. Use on a fresh machine.
              </span>
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
            {busy === 'restore' ? 'Restoring…' : 'Choose backup file…'}
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
