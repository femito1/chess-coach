import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  formatBytes,
  getStorageInfo,
  requestPersistentStorage,
  type StorageInfo,
} from '@/db/backup';

/**
 * Tiny banner on the dashboard surfacing two real silent-data-loss
 * vectors:
 *   1. Origin storage isn't marked persistent — the browser may evict
 *      the IndexedDB under disk pressure. Offer a one-click upgrade.
 *   2. Usage is approaching the quota (>70%) — time to back up + prune.
 *
 * Hides itself when neither condition is true so it doesn't add noise
 * to the happy path.
 */
export function StorageBanner() {
  const [info, setInfo] = useState<StorageInfo | null>(null);

  async function refresh() {
    setInfo(await getStorageInfo());
  }

  useEffect(() => {
    void refresh();
  }, []);

  if (!info || !info.supported) return null;

  const usagePct = info.quota > 0 ? (info.usage / info.quota) * 100 : 0;
  const nearQuota = usagePct >= 70;
  if (info.persistent && !nearQuota) return null;

  return (
    <div className="card p-3 flex flex-wrap items-center gap-3 border-accent/40 text-sm">
      {!info.persistent ? (
        <>
          <span>
            Local storage is <span className="font-medium">best-effort</span>. The browser
            may evict it under disk pressure.
          </span>
          <button
            type="button"
            className="btn text-xs"
            onClick={async () => {
              await requestPersistentStorage();
              await refresh();
            }}
          >
            Make persistent
          </button>
        </>
      ) : (
        <span>
          Using <span className="font-medium">{formatBytes(info.usage)}</span> of{' '}
          {formatBytes(info.quota)} ({usagePct.toFixed(0)}%). Consider exporting a backup.
        </span>
      )}
      <Link to="/backup" className="ml-auto text-xs text-accent hover:underline">
        Backup &amp; restore →
      </Link>
    </div>
  );
}
