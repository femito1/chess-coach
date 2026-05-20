import { useEffect, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import {
  getSettings,
  normalizeTimeClassSelection,
  updateSettings,
  type TimeClassSelection,
} from '@/db/schema';
import { listAllGamesLight, requeueGamesByScope, type RequeueScope } from '@/db/queries';
import { TimeClassChips } from '@/components/TimeClassFilter';
import { useThrottledLiveQuery } from '@/lib/useThrottledLiveQuery';
import {
  CHROME_EXTENSION_NAME,
  CHROME_EXTENSION_STORE_URL,
} from '@/lib/extension';
import {
  LOCALE_DISPLAY_NAMES,
  SUPPORTED_LOCALES,
  isSupportedLocale,
  setLocale,
  type SupportedLocale,
} from '@/i18n';
import {
  FREE_PLAY_STRENGTHS,
  type FreePlayStrength,
} from '@/engine/freePlayEngine';

export function SettingsPage() {
  const { t, i18n } = useTranslation();
  const [username, setUsername] = useState('');
  const [engineDepth, setEngineDepth] = useState(16);
  const [autoAnalyze, setAutoAnalyze] = useState(true);
  const [savedDepth, setSavedDepth] = useState(16);
  const [timeClassFilter, setTimeClassFilter] = useState<TimeClassSelection>(['rapid']);
  const [saved, setSaved] = useState(false);
  const [requeueStatus, setRequeueStatus] = useState<string | null>(null);
  const [extensionDismissedAt, setExtensionDismissedAt] = useState<number | undefined>(
    undefined,
  );
  const [freePlayStrength, setFreePlayStrength] =
    useState<FreePlayStrength>('max');
  // Settings only uses `games` to populate the time-class filter dropdown
  // — staleness of a few seconds is invisible. Throttled for the same
  // reason as the dashboard / weaknesses pages, and uses the light
  // projection (no PGN) since we only need `timeClass` for the dropdown.
  const games = useThrottledLiveQuery(() => listAllGamesLight(), [], 1500);

  useEffect(() => {
    void getSettings().then((s) => {
      setUsername(s.username);
      setEngineDepth(s.engineDepth);
      setSavedDepth(s.engineDepth);
      setAutoAnalyze(s.autoAnalyze);
      setTimeClassFilter(normalizeTimeClassSelection(s.timeClassFilter));
      setExtensionDismissedAt(s.extensionPromoDismissedAt);
      // Default `Settings.freePlayStrength` to `'max'` if unset or
      // corrupted — same fall-through as `strengthToOptions` so the
      // dropdown always shows a meaningful selection.
      const stored = (FREE_PLAY_STRENGTHS as readonly string[]).includes(
        s.freePlayStrength ?? '',
      )
        ? (s.freePlayStrength as FreePlayStrength)
        : 'max';
      setFreePlayStrength(stored);
    });
  }, []);

  const depthChanged = engineDepth !== savedDepth;

  async function save() {
    await updateSettings({
      username: username.trim(),
      engineDepth,
      autoAnalyze,
      timeClassFilter,
    });
    setSavedDepth(engineDepth);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  }

  async function doRequeue(scope: RequeueScope) {
    setRequeueStatus('Queuing…');
    // Persist the new depth first so the queue picks it up on the next game.
    await updateSettings({
      username: username.trim(),
      engineDepth,
      autoAnalyze,
      timeClassFilter,
    });
    setSavedDepth(engineDepth);
    const n = await requeueGamesByScope(scope);
    setRequeueStatus(
      n === 0
        ? 'No games matched that scope.'
        : `Queued ${n} game${n === 1 ? '' : 's'} for re-analysis at depth ${engineDepth}.`,
    );
  }

  async function dismissExtensionPromo() {
    const now = Date.now();
    await updateSettings({ extensionPromoDismissedAt: now });
    setExtensionDismissedAt(now);
  }

  async function reopenExtensionPromo() {
    await updateSettings({ extensionPromoDismissedAt: undefined });
    setExtensionDismissedAt(undefined);
  }

  /** Language picker handler. Two writes: localStorage (load-bearing for
   *  next-boot first paint, written by `setLocale` below) + Dexie
   *  Settings (will sync across devices once Phase 2 ships). Both are
   *  fire-and-forget; failure to persist keeps the runtime switch
   *  working for the current session. */
  async function changeLocale(locale: SupportedLocale): Promise<void> {
    await setLocale(locale);
    await updateSettings({ locale });
  }

  async function changeFreePlayStrength(level: FreePlayStrength): Promise<void> {
    setFreePlayStrength(level);
    await updateSettings({ freePlayStrength: level });
  }

  const currentLocale: SupportedLocale = isSupportedLocale(i18n.resolvedLanguage)
    ? i18n.resolvedLanguage
    : 'en';

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t('settings.title')}</h1>
      </div>

      <section className="card p-4 space-y-4">
        <label className="block text-sm">
          <div className="mb-1 text-text-muted">{t('settings.username')}</div>
          <input className="input" value={username} onChange={(e) => setUsername(e.target.value)} />
        </label>
        <label className="block text-sm">
          <div className="mb-1 text-text-muted">
            {/* `<Trans>` lets the catalog string wrap the depth value in
             *  the right markup ("Engine depth: <strong>16</strong>");
             *  pt-BR puts the noun first too, but a future locale could
             *  reorder these around the value. */}
            <Trans
              i18nKey="settings.engineDepth"
              values={{ depth: engineDepth }}
              components={{
                '1': <span className="text-text font-mono" />,
              }}
            />
          </div>
          <input
            type="range"
            min={10}
            max={22}
            value={engineDepth}
            onChange={(e) => setEngineDepth(Number(e.target.value))}
            className="w-full"
          />
          <div className="text-xs text-text-muted mt-1">
            {t('settings.engineDepthHint')}
          </div>
        </label>
        <div className="block text-sm">
          <div className="mb-1 text-text-muted">{t('settings.timeFilter')}</div>
          <TimeClassChips
            selection={timeClassFilter}
            onChange={setTimeClassFilter}
            available={games ?? []}
          />
          <div className="text-xs text-text-muted mt-1">
            {t('settings.timeFilterHint')}
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={autoAnalyze}
            onChange={(e) => setAutoAnalyze(e.target.checked)}
          />
          <span>{t('settings.autoAnalyze')}</span>
        </label>
        <div className="flex items-center gap-3">
          <button type="button" className="btn-primary" onClick={save}>
            {t('common.save')}
          </button>
          {saved && <span className="text-good text-sm">{t('common.saved')}</span>}
        </div>

        {depthChanged && (
          <div className="border border-accent/40 bg-accent/5 rounded-md p-3 text-sm space-y-2">
            <div>
              <Trans
                i18nKey="settings.depthChanged"
                values={{ from: savedDepth, to: engineDepth }}
                components={{
                  // `<strong>` placeholders are positionally indexed in
                  // i18next-react when used unnamed; we use named keys so
                  // the catalog reads naturally in either language.
                  '1': <span className="font-mono" />,
                  '2': <span className="font-mono text-accent" />,
                }}
              />
            </div>
            <div className="flex flex-wrap gap-2">
              <button type="button" className="btn text-xs" onClick={() => doRequeue('latest')}>
                {t('settings.scope.latest')}
              </button>
              <button type="button" className="btn text-xs" onClick={() => doRequeue('day')}>
                {t('settings.scope.day')}
              </button>
              <button type="button" className="btn text-xs" onClick={() => doRequeue('week')}>
                {t('settings.scope.week')}
              </button>
              <button type="button" className="btn text-xs" onClick={() => doRequeue('month')}>
                {t('settings.scope.month')}
              </button>
              <button type="button" className="btn text-xs" onClick={() => doRequeue('all')}>
                {t('settings.scope.all')}
              </button>
              <button
                type="button"
                className="btn text-xs text-text-muted"
                onClick={() => setEngineDepth(savedDepth)}
              >
                {t('common.cancel')}
              </button>
            </div>
            {requeueStatus && <div className="text-xs text-text-muted">{requeueStatus}</div>}
          </div>
        )}
        {!depthChanged && requeueStatus && (
          <div className="text-xs text-text-muted">{requeueStatus}</div>
        )}
      </section>

      {/* Language picker. Sits high in the page (right after engine
       *  settings) so a Brazilian user who lands on /settings looking
       *  to switch into pt-BR finds it immediately. The picker uses
       *  native-name labels (`Português (Brasil)`, not "Portuguese
       *  (Brazil)") because every other piece of software the user
       *  interacts with does the same. */}
      <section className="card p-4 space-y-3">
        <h2 className="font-medium">{t('settings.language.title')}</h2>
        <p className="text-xs text-text-muted">{t('settings.language.description')}</p>
        <div className="flex flex-wrap gap-2">
          {SUPPORTED_LOCALES.map((loc) => {
            const active = loc === currentLocale;
            return (
              <button
                key={loc}
                type="button"
                aria-pressed={active}
                onClick={() => void changeLocale(loc)}
                className={
                  active
                    ? 'btn-primary text-sm'
                    : 'btn text-sm'
                }
              >
                {LOCALE_DISPLAY_NAMES[loc]}
              </button>
            );
          })}
        </div>
      </section>

      {/* Free-play strength. Sets the default Stockfish strength for
       *  the "Play it out vs engine" CTA on the practice page. The
       *  practice page itself surfaces a per-session override so a
       *  user can drop down to 1200 to drill an opening tactically
       *  without rewriting their global preference. */}
      <section className="card p-4 space-y-3">
        <h2 className="font-medium">{t('settings.freePlayStrength.title')}</h2>
        <p className="text-xs text-text-muted">
          {t('settings.freePlayStrength.description')}
        </p>
        <div className="flex flex-wrap gap-2">
          {FREE_PLAY_STRENGTHS.map((level) => {
            const active = level === freePlayStrength;
            return (
              <button
                key={level}
                type="button"
                aria-pressed={active}
                onClick={() => void changeFreePlayStrength(level)}
                className={active ? 'btn-primary text-sm' : 'btn text-sm'}
              >
                {t(`settings.freePlayStrength.level.${level}`)}
              </button>
            );
          })}
        </div>
      </section>

      {/* Browser-extension promo. Lives in Settings (not as a noisy
       *  dashboard banner) by deliberate choice — the extension is a
       *  power-user shortcut, not a required onboarding step, and the
       *  manual import flow works fine without it. We surface it
       *  prominently here for discovery, with a one-click dismiss
       *  that collapses the card to a small "Reopen" row so it never
       *  becomes a permanent eyesore for users who don't want it.
       *  Dismissal is persisted via `Settings.extensionPromoDismissedAt`. */}
      {extensionDismissedAt === undefined ? (
        <section className="card p-4 space-y-3 border-accent/40">
          <div className="flex items-start justify-between gap-3">
            <h2 className="font-medium">{t('settings.extensionPromo.title')}</h2>
            <button
              type="button"
              className="text-xs text-text-muted hover:text-text"
              onClick={() => void dismissExtensionPromo()}
              aria-label={t('common.dismiss')}
              title={t('common.dismiss')}
            >
              {t('common.dismiss')}
            </button>
          </div>
          <p className="text-sm">
            <Trans
              i18nKey="settings.extensionPromo.intro"
              values={{ name: CHROME_EXTENSION_NAME }}
              components={{ strong: <strong /> }}
            />
          </p>
          <ul className="text-xs text-text-muted list-disc pl-5 space-y-0.5">
            <li>{t('settings.extensionPromo.bullets.noPaste')}</li>
            <li>{t('settings.extensionPromo.bullets.noLeak')}</li>
            <li>{t('settings.extensionPromo.bullets.openSource')}</li>
          </ul>
          <div className="flex flex-wrap gap-2 pt-1">
            <a
              className="btn-primary text-sm"
              href={CHROME_EXTENSION_STORE_URL}
              target="_blank"
              rel="noopener noreferrer"
            >
              {t('settings.extensionPromo.cta')}
            </a>
          </div>
        </section>
      ) : (
        <div className="text-xs text-text-muted flex items-center gap-2">
          <span>{t('settings.extensionPromo.dismissed')}</span>
          <button
            type="button"
            className="text-accent hover:underline"
            onClick={() => void reopenExtensionPromo()}
          >
            {t('common.reopen')}
          </button>
        </div>
      )}

    </div>
  );
}
