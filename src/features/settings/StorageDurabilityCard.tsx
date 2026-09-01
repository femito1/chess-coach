import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  assessStoragePressure,
  ensureDurableStorage,
  readStorageUsage,
  type StorageDurability,
  type StorageUsage,
} from '@/lib/storagePersistence';

function formatMb(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(bytes < 100_000_000 ? 1 : 0)} MB`;
}

/**
 * Says whether the browser has promised to keep this device's data.
 *
 * Worth a card of its own because the failure it describes is otherwise
 * invisible and reads as data loss: an evicted origin comes back signed out
 * with an empty library, and nothing in the app announces why. The boot call
 * in `AppLayout` does the asking; this only reports the answer, sharing the
 * same memoised promise.
 */
export function StorageDurabilityCard() {
  const { t } = useTranslation();
  const [durability, setDurability] = useState<StorageDurability | null>(null);
  const [usage, setUsage] = useState<StorageUsage | null>(null);

  useEffect(() => {
    let live = true;
    void ensureDurableStorage().then((d) => {
      if (live) setDurability(d);
    });
    void readStorageUsage().then((u) => {
      if (live) setUsage(u);
    });
    return () => {
      live = false;
    };
  }, []);

  if (!durability) return null;

  // Headroom first: a collapsing quota is the fingerprint of a nearly-full disk,
  // which defeats the durability grant entirely and is the failure that actually
  // loses data. Saying so outranks reporting the grant.
  const pressure = assessStoragePressure(usage);

  const tone =
    durability.kind === 'persisted'
      ? 'text-best'
      : durability.kind === 'best-effort'
        ? 'text-inaccuracy'
        : 'text-text-muted';

  const status =
    durability.kind === 'persisted'
      ? t('settings.storage.persisted')
      : durability.kind === 'best-effort'
        ? t('settings.storage.bestEffort')
        : durability.kind === 'unsupported'
          ? t('settings.storage.unsupported')
          : t('settings.storage.error', { message: durability.message });

  return (
    <section className="card p-4 space-y-2">
      <h2 className="font-medium">{t('settings.storage.title')}</h2>
      <p className={`text-sm ${tone}`}>{status}</p>
      {(pressure.kind === 'critical' || pressure.kind === 'low') && (
        <p
          className={`text-sm rounded-md border px-2 py-1.5 ${
            pressure.kind === 'critical'
              ? 'border-blunder/50 bg-blunder/10 text-blunder'
              : 'border-inaccuracy/50 bg-inaccuracy/10 text-inaccuracy'
          }`}
        >
          {pressure.kind === 'critical'
            ? t('settings.storage.diskCritical')
            : t('settings.storage.diskLow')}
        </p>
      )}
      <p className="text-xs text-text-muted">
        {durability.kind === 'persisted'
          ? t('settings.storage.persistedHint')
          : t('settings.storage.bestEffortHint')}
      </p>
      {usage && (
        <p className="text-[11px] text-text-muted font-mono">
          {t('settings.storage.usage', {
            used: formatMb(usage.usage),
            quota: formatMb(usage.quota),
            percent: usage.quota > 0
              ? Math.max(0.1, (usage.usage / usage.quota) * 100).toFixed(1)
              : '0',
          })}
        </p>
      )}
    </section>
  );
}
