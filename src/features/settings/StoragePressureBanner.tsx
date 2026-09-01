import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  assessStoragePressure,
  readStorageUsage,
  type StoragePressure,
} from '@/lib/storagePersistence';

/** Re-check occasionally: disk space is changed by everything else on the
 *  machine, not by this app, so there is no event to listen for. */
const POLL_MS = 60_000;

/**
 * App-wide banner for "this device is about to stop being able to store your
 * data".
 *
 * A banner rather than only a Settings row because the failure it warns about is
 * completely silent otherwise. A full disk wiped this app's entire local library
 * along with five other origins' data, and nothing anywhere said so — every
 * layer reported healthy, since ext4 reserves 5% for root and `df`'s Avail
 * already excludes it, so the machine looks fine while unprivileged writers
 * starve. The user spent two days thinking individual apps were misbehaving.
 * Being *told* is the whole value; a readout you have to go and look at would
 * not have helped.
 *
 * Only the critical band gets a banner. "Low" is a Settings detail — interrupting
 * every page for it would train the banner to be ignored, and this one needs to
 * be believed the one time it matters.
 */
export function StoragePressureBanner() {
  const { t } = useTranslation();
  const [pressure, setPressure] = useState<StoragePressure>({ kind: 'unknown' });

  useEffect(() => {
    let live = true;
    const check = async () => {
      const usage = await readStorageUsage();
      if (live) setPressure(assessStoragePressure(usage));
    };
    void check();
    const timer = setInterval(() => void check(), POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);

  if (pressure.kind !== 'critical') return null;

  return (
    <div
      role="alert"
      className="border-b border-blunder/50 bg-blunder/10 px-3 py-2 text-sm text-blunder"
    >
      <span className="font-medium">{t('settings.storage.bannerTitle')}</span>{' '}
      {t('settings.storage.bannerBody')}
    </div>
  );
}
