import { useTranslation } from 'react-i18next';
import { useBootStore } from './queue';

/**
 * Tiny banner shown while boot housekeeping is still running and is
 * slow enough that the user might think the app is hung (>400 ms — see
 * `BOOT_BANNER_DELAY_MS` in `queue.ts`). For warm boots — where every
 * pass either short-circuits via its version stamp or finishes inside
 * the grace period — the banner never renders, so the happy path is
 * unchanged.
 *
 * Lives in the bottom-left so it can't collide with `QueueIndicator`
 * (bottom-right). Visually neutral on purpose: we don't want users to
 * confuse boot housekeeping with engine analysis activity.
 */
export function BootBanner() {
  const { t } = useTranslation();
  const { phase, started } = useBootStore();
  if (!started || !phase) return null;

  // `phase` is now a translation key set by `queue.ts` boot steps.
  // Falls back to the raw phase string if anyone sets a non-key value
  // (e.g. legacy callers / tests), matching i18next's defaultValue
  // behavior.
  const label = t(`bootBanner.${phase}`, { defaultValue: phase });

  return (
    <div
      className="fixed bottom-4 left-4 z-20 card flex items-center gap-3 text-xs px-3 py-2 shadow-lg whitespace-nowrap"
      role="status"
      aria-live="polite"
    >
      <Spinner />
      <span className="text-text-muted">{label}</span>
    </div>
  );
}

function Spinner() {
  return (
    <span
      className="inline-block w-3 h-3 rounded-full border-2 border-text-muted/30 border-t-text-muted animate-spin"
      aria-hidden
    />
  );
}
