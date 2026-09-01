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
import { StorageDurabilityCard } from './StorageDurabilityCard';
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
import { usePersistedState } from '@/lib/usePersistedState';
import { MOVE_SOUNDS_PREF_KEY } from '@/audio/moveSounds';
import { NNUE_PREF_KEY, NNUE_PREF_VERSION } from '@/engine/nnue';
import {
  ENGINE_WORKERS_CHOICES,
  ENGINE_WORKERS_PREF_KEY,
  ENGINE_WORKERS_PREF_VERSION,
  autoPoolSize,
} from '@/engine/pool';
import { activeEngineBuild, canUseThreadedEngine } from '@/engine/engine';
import { applyWorkerCount } from '@/engine/queue';
import { terminateEngineIfIdle } from '@/engine/engine';
import { analysisPool } from '@/engine/pool';
import { CloudSyncCard } from '@/features/sync/CloudSyncCard';

export function SettingsPage() {
  const { t, i18n } = useTranslation();
  const [username, setUsername] = useState('');
  const [engineDepth, setEngineDepth] = useState(16);
  const [autoAnalyze, setAutoAnalyze] = useState(true);
  const [savedDepth, setSavedDepth] = useState(16);
  const [timeClassFilter, setTimeClassFilter] = useState<TimeClassSelection>(['rapid']);
  const [saved, setSaved] = useState(false);
  // Same key + version the board reads through `moveSoundsEnabled()`.
  const [moveSounds, setMoveSounds] = usePersistedState<boolean>(
    MOVE_SOUNDS_PREF_KEY,
    true,
    { isValid: (v): v is boolean => typeof v === 'boolean' },
  );
  // Same key + version the engine handshake reads through
  // `nnuePreferenceEnabled()`.
  const [nnue, setNnue] = usePersistedState<boolean>(NNUE_PREF_KEY, true, {
    version: NNUE_PREF_VERSION,
    isValid: (v): v is boolean => typeof v === 'boolean',
  });
  // Per-device, same reasoning as the NNUE toggle. `null` = auto.
  const [workers, setWorkers] = usePersistedState<number | null>(
    ENGINE_WORKERS_PREF_KEY,
    null,
    {
      version: ENGINE_WORKERS_PREF_VERSION,
      isValid: (v): v is number | null =>
        v === null ||
        (typeof v === 'number' && (ENGINE_WORKERS_CHOICES as readonly number[]).includes(v)),
    },
  );
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

  /**
   * Flip the NNUE preference and make it bite as soon as it safely can.
   *
   * The preference is read at engine *start*, so a worker that is already up
   * keeps whichever evaluator it handshook with. Terminating IDLE engines makes
   * the next `analyze()` rehydrate them under the new setting instead of the
   * user having to reload. Both calls are no-ops while work is in flight
   * (`terminateEngineIfIdle` checks `isBusy`, `terminateIfIdle` checks the queue
   * as well), so this can never cut a running analysis in half — it would come
   * back as a spuriously errored game.
   */
  function changeNnue(next: boolean): void {
    setNnue(next);
    terminateEngineIfIdle();
    analysisPool().terminateIfIdle();
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
      <StorageDurabilityCard />

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

      {/* Engine strength (NNUE). localStorage rather than the synced `Settings`
       *  row for two reasons: the engine handshake reads it synchronously
       *  before its first await, and "is this device willing to spend 40 MB"
       *  is a per-device question — pushing a hotel-wifi decision onto the
       *  user's desktop would be actively wrong. Default ON: a coaching app
       *  whose engine misjudges endgames is wrong in the way that matters
       *  most. See `src/engine/nnue.ts`. */}
      <section className="card p-4 space-y-3">
        <h2 className="font-medium">{t('settings.nnue.title')}</h2>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={nnue}
            onChange={(e) => changeNnue(e.target.checked)}
          />
          <span>{t('settings.nnue.toggle')}</span>
        </label>
        <p className="text-xs text-text-muted">{t('settings.nnue.description')}</p>
        <p className="text-[11px] text-text-muted">{t('settings.nnue.applies')}</p>
      </section>

      {/* Engine worker count. A setting rather than a smarter heuristic because
       *  the performance curve has a CLIFF, not a plateau: measured at depth 18
       *  on a 12-core/8 GB laptop, 4 workers took 9.7 s, 6 took 7.6 s, and 8 took
       *  two minutes once it started swapping. Auto can't safely reach for 6
       *  because the browser exposes total memory (`deviceMemory`, rounded to a
       *  power of two and capped at 8) and never free memory — so it cannot tell
       *  an idle machine from a loaded one. A human can. See `pool.ts`. */}
      <section className="card p-4 space-y-3">
        <h2 className="font-medium">{t('settings.workers.title')}</h2>
        <select
          className="input text-sm"
          value={workers === null ? 'auto' : String(workers)}
          onChange={(e) => {
            const raw = e.target.value;
            const next = raw === 'auto' ? null : Number(raw);
            setWorkers(next);
            // Apply to the live pool so it bites on the next analysis rather than
            // after a reload. `setMaxWorkers` terminates idle workers above the
            // new cap immediately and grows lazily, so this is safe mid-session.
            applyWorkerCount(next ?? autoPoolSize());
          }}
        >
          <option value="auto">{t('settings.workers.auto', { n: autoPoolSize() })}</option>
          {ENGINE_WORKERS_CHOICES.map((n) => (
            <option key={n} value={String(n)}>
              {n === 1 ? t('settings.workers.one') : t('settings.workers.workers', { n })}
            </option>
          ))}
        </select>
        <p className="text-xs text-text-muted">{t('settings.workers.description')}</p>
        <p className="text-[11px] text-text-muted">{t('settings.workers.applies')}</p>

        {/* The fallback build is an 11x slowdown, and nothing else in the UI
         *  would ever say so — analysis just feels broken. Shown whenever the
         *  page can't be cross-origin isolated, or a worker has already booted
         *  on the slow build. */}
        {(!canUseThreadedEngine() || activeEngineBuild() === 'single') && (
          <div className="rounded border border-blunder/40 bg-blunder/5 p-3 space-y-1">
            <div className="text-sm font-medium text-blunder">
              {t('settings.workers.slowBuildTitle')}
            </div>
            <p className="text-xs text-text-muted">{t('settings.workers.slowBuild')}</p>
          </div>
        )}
      </section>

      {/* Move sounds. Kept in localStorage rather than the synced `Settings`
       *  row because the board reads it synchronously inside a move handler,
       *  and because "is this device allowed to make noise" is a per-device
       *  question — the same account on a shared laptop shouldn't inherit it. */}
      <section className="card p-4 space-y-3">
        <h2 className="font-medium">{t('settings.sounds.title')}</h2>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={moveSounds}
            onChange={(e) => setMoveSounds(e.target.checked)}
          />
          <span>{t('settings.sounds.moveSounds')}</span>
        </label>
        <p className="text-xs text-text-muted">
          {t('settings.sounds.description')}
        </p>
      </section>

      {/* Browser-extension promo. Lives in Settings (not as a noisy
       *  dashboard banner) by deliberate choice — the extension is a
       *  power-user shortcut, not a required onboarding step, and the
       *  manual import flow works fine without it. We surface it
       *  prominently here for discovery, with a one-click dismiss
       *  that collapses the card to a small "Reopen" row so it never
       *  becomes a permanent eyesore for users who don't want it.
       *  Dismissal is persisted via `Settings.extensionPromoDismissedAt`. */}
      <CloudSyncCard />

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
