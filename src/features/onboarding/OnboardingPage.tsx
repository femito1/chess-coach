import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Trans, useTranslation } from 'react-i18next';
import { useEffectiveAuth, useEffectiveUser } from '@/lib/testAuth';
import { useSupabase } from '@/lib/supabase';
import {
  fetchArchives,
  fetchMonth,
  parseArchiveUrl,
} from '@/api/chesscom';
import { suggestUsernameCandidates, emailLocalPart } from './suggestUsername';
import {
  estimateImportTime,
  FALLBACK_MS_PER_GAME_MULTI,
  FALLBACK_MS_PER_GAME_SINGLE,
} from './estimate';
import { probeDevice } from '@/engine/probe';
import { importLastNMonths, type AutoImportProgress } from '@/features/import/auto';
import { getSettings, updateSettings } from '@/db/schema';
import { runProfileSync } from '@/features/auth/useProfileSync';

/**
 * First-sign-in onboarding wizard. Three logical steps in one page:
 *
 *   1. Confirm Chess.com username (smart-suggested, never silent).
 *   2. Pick an import preset (last 1 / 3 / 12 / all months).
 *   3. Progress + redirect to dashboard once the import lands.
 *
 * The device probe runs in the background as soon as the page mounts,
 * so by the time the user reaches step 2 the import-time estimates are
 * calibrated to their machine. We don't block on it — if the user races
 * past the username step before the probe finishes, step 2 falls back
 * to the multi/single-thread constants in `estimate.ts`.
 *
 * Mounted at `/onboarding` outside `<AppLayout>` so the nav header /
 * profile chip don't appear during the focused flow.
 */
export function OnboardingPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { userId } = useEffectiveAuth();
  const { user } = useEffectiveUser();
  const supabase = useSupabase();

  // Kick the device probe off as soon as the page mounts. The wizard
  // doesn't await this — we just want the cached value sitting in
  // Settings.deviceAnalysisMsPerGame by the time step 2 reads it.
  // Marked best-effort: failures are silently swallowed by probeDevice
  // itself, which writes a fallback so we don't keep retrying.
  useEffect(() => {
    void probeDevice().catch(() => {
      /* probeDevice never throws, but TS doesn't know that */
    });
  }, []);

  type Step = 'username' | 'preset' | 'importing';
  const [step, setStep] = useState<Step>('username');
  const [confirmedUsername, setConfirmedUsername] = useState('');
  const [importResult, setImportResult] = useState<{ added: number; skipped: number } | null>(null);

  /** Finish the wizard: persist `onboardingCompletedAt`, push the
   *  username up to the cloud profile, then leave the wizard. */
  async function finish(opts: { username?: string; skipImport?: boolean }) {
    const u = (opts.username ?? '').trim();
    await updateSettings({
      ...(u ? { username: u } : {}),
      onboardingCompletedAt: Date.now(),
    });
    if (u && userId) {
      // Best-effort: re-run profile-sync so the cloud profile picks up
      // the new username. The handshake is idempotent so re-running it
      // is safe even if it fired earlier in the session. We swallow
      // errors because Supabase being down shouldn't block the user
      // from reaching the dashboard — they have a working local DB.
      try {
        const displayName = buildDisplayName(user);
        await runProfileSync({ supabase, clerkUserId: userId, displayName });
      } catch (err) {
        console.warn('[onboarding] profile sync after username confirmation failed', err);
      }
    }
    if (opts.skipImport) {
      navigate('/dashboard', { replace: true });
    }
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-bg px-6 py-12">
      <div className="text-center mb-8">
        <h1 className="text-3xl font-semibold tracking-tight">
          <span className="text-accent">♞</span> Chess Coach
        </h1>
        <p className="text-sm text-text-muted mt-2">
          {t('onboarding.tagline')}
        </p>
      </div>

      <div className="w-full max-w-xl">
        <Stepper current={step} />
        {step === 'username' && (
          <UsernameStep
            onConfirm={async (u) => {
              setConfirmedUsername(u);
              await finish({ username: u, skipImport: false });
              setStep('preset');
            }}
            onSkip={async () => {
              await finish({ skipImport: true });
            }}
          />
        )}
        {step === 'preset' && (
          <PresetStep
            username={confirmedUsername}
            onStart={async (n) => {
              setStep('importing');
              try {
                const r = await importLastNMonths(confirmedUsername, n);
                setImportResult({ added: r.added, skipped: r.skipped });
              } catch (err) {
                console.error('[onboarding] import failed', err);
                setImportResult({ added: 0, skipped: 0 });
              }
            }}
            onSkipImport={async () => {
              await finish({ username: confirmedUsername, skipImport: true });
            }}
          />
        )}
        {step === 'importing' && (
          <ImportingStep
            username={confirmedUsername}
            done={importResult}
            onDone={async () => {
              navigate('/dashboard', { replace: true });
            }}
          />
        )}
      </div>
    </div>
  );
}

function Stepper({ current }: { current: 'username' | 'preset' | 'importing' }) {
  const { t } = useTranslation();
  const steps: Array<{ id: 'username' | 'preset' | 'importing'; label: string }> = [
    { id: 'username', label: t('onboarding.stepUsername') },
    { id: 'preset', label: t('onboarding.stepImport') },
    { id: 'importing', label: t('onboarding.stepImporting') },
  ];
  const currentIdx = steps.findIndex((s) => s.id === current);
  return (
    <ol className="flex items-center gap-2 text-xs text-text-muted mb-6 justify-center">
      {steps.map((s, i) => (
        <li key={s.id} className="flex items-center gap-2">
          <span
            className={`inline-flex items-center justify-center w-5 h-5 rounded-full text-[10px] ${
              i <= currentIdx
                ? 'bg-accent/20 text-accent border border-accent/40'
                : 'bg-bg-soft border border-border'
            }`}
          >
            {i + 1}
          </span>
          <span className={i === currentIdx ? 'text-text' : ''}>{s.label}</span>
          {i < steps.length - 1 && <span className="text-border">›</span>}
        </li>
      ))}
    </ol>
  );
}

function buildDisplayName(user: ReturnType<typeof useEffectiveUser>['user']): string | undefined {
  if (!user) return undefined;
  const full = `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim();
  if (full.length > 0) return full;
  if (user.firstName) return user.firstName;
  const email = user.primaryEmailAddress?.emailAddress;
  if (email) {
    const localPart = email.split('@')[0];
    if (localPart) return localPart;
  }
  return undefined;
}

/* =======================================================================
 *  Step 1 — Username confirmation
 * ======================================================================= */

interface ChessComPlayerProfile {
  username: string;
  avatar?: string;
  country?: string;
  last_online?: number;
  name?: string;
}

async function fetchChessComPlayer(handle: string): Promise<ChessComPlayerProfile | null> {
  try {
    const res = await fetch(
      `https://api.chess.com/pub/player/${encodeURIComponent(handle)}`,
      { headers: { Accept: 'application/json' } },
    );
    if (!res.ok) return null;
    return (await res.json()) as ChessComPlayerProfile;
  } catch {
    return null;
  }
}

function UsernameStep({
  onConfirm,
  onSkip,
}: {
  onConfirm: (u: string) => void | Promise<void>;
  onSkip: () => void | Promise<void>;
}) {
  const { t } = useTranslation();
  const { user } = useEffectiveUser();
  const [suggestion, setSuggestion] = useState<ChessComPlayerProfile | null>(null);
  const [suggestionPending, setSuggestionPending] = useState(true);
  const [manual, setManual] = useState('');
  const [manualResult, setManualResult] = useState<
    | { kind: 'idle' }
    | { kind: 'pending' }
    | { kind: 'found'; profile: ChessComPlayerProfile }
    | { kind: 'notFound' }
  >({ kind: 'idle' });
  // WHICH handle is being confirmed, not merely whether one is. A single
  // boolean was shared by both PlayerCards below, so confirming either one put
  // *both* into their loading label — the guessed account appeared to be
  // signing in when you had picked the one you typed. The identity of the
  // in-flight handle is the thing the UI needs, so it is the thing we store.
  const [confirmingHandle, setConfirmingHandle] = useState<string | null>(null);

  // Auto-suggest: walk the candidate list (clerk username → first name →
  // email local part) and surface the first one that resolves to a
  // real Chess.com profile.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const candidates = suggestUsernameCandidates({
        username: user?.username ?? null,
        firstName: user?.firstName ?? null,
        primaryEmailLocalPart: emailLocalPart(user?.primaryEmailAddress?.emailAddress),
      });
      for (const c of candidates) {
        const p = await fetchChessComPlayer(c);
        if (cancelled) return;
        if (p) {
          setSuggestion(p);
          setSuggestionPending(false);
          return;
        }
      }
      if (!cancelled) setSuggestionPending(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [user?.username, user?.firstName, user?.primaryEmailAddress?.emailAddress]);

  // Debounced live lookup of the manual input. 300ms idle settles to a
  // single fetch — the same UX pattern Chess.com uses.
  const manualRef = useRef(manual);
  manualRef.current = manual;
  useEffect(() => {
    const handle = manual.trim();
    if (handle.length < 3) {
      setManualResult({ kind: 'idle' });
      return;
    }
    setManualResult({ kind: 'pending' });
    const t = setTimeout(async () => {
      const p = await fetchChessComPlayer(handle);
      if (manualRef.current.trim() !== handle) return;
      setManualResult(p ? { kind: 'found', profile: p } : { kind: 'notFound' });
    }, 300);
    return () => clearTimeout(t);
  }, [manual]);

  async function confirm(handle: string) {
    // Still one at a time: every card is disabled while any confirm is in
    // flight, so this guard is belt-and-braces against a double tap landing
    // before the re-render.
    if (confirmingHandle !== null) return;
    setConfirmingHandle(handle);
    try {
      await onConfirm(handle);
    } finally {
      setConfirmingHandle(null);
    }
  }
  // Only the card whose handle is in flight shows progress; the others go
  // inert without claiming to be doing anything. (If you type the same handle
  // that was guessed, both cards are that handle and both show it — correct,
  // they are the same account.)
  const busy = confirmingHandle !== null;

  return (
    <div className="card p-6 space-y-5">
      <div>
        <h2 className="text-lg font-medium">{t('onboarding.username.title')}</h2>
        <p className="text-sm text-text-muted mt-1">
          {t('onboarding.username.subtitle')}
        </p>
      </div>

      {suggestionPending && (
        <div className="text-sm text-text-muted">{t('onboarding.username.looking')}</div>
      )}

      {!suggestionPending && suggestion && (
        <PlayerCard
          profile={suggestion}
          headline={t('onboarding.username.isThisYou')}
          actionLabel={
            confirmingHandle === suggestion.username
              ? t('onboarding.username.confirming')
              : t('onboarding.username.yesItsMe')
          }
          onAction={() => confirm(suggestion.username)}
          disabled={busy}
        />
      )}

      {!suggestionPending && !suggestion && (
        <div className="text-sm text-text-muted">
          {t('onboarding.username.couldntGuess')}
        </div>
      )}

      <div className="border-t border-border pt-4 space-y-3">
        <label className="block text-sm">
          <div className="mb-1 text-text-muted">
            {suggestion ? t('onboarding.username.orEnter') : t('onboarding.username.enter')}
          </div>
          <input
            className="input"
            value={manual}
            onChange={(e) => setManual(e.target.value)}
            placeholder="magnuscarlsen"
            autoFocus={!suggestion}
          />
        </label>

        {manualResult.kind === 'pending' && (
          <div className="text-xs text-text-muted">{t('onboarding.username.checking')}</div>
        )}
        {manualResult.kind === 'notFound' && (
          <div className="text-xs text-blunder">
            {t('onboarding.username.notFound')}
          </div>
        )}
        {manualResult.kind === 'found' && (
          <PlayerCard
            profile={manualResult.profile}
            headline={t('onboarding.username.found', { username: manualResult.profile.username })}
            actionLabel={
              confirmingHandle === manualResult.profile.username
                ? t('onboarding.username.confirming')
                : t('onboarding.username.useThis')
            }
            onAction={() => confirm(manualResult.profile.username)}
            disabled={busy}
          />
        )}
      </div>

      <div className="flex items-center justify-between border-t border-border pt-4">
        <button
          type="button"
          className="text-xs text-text-muted hover:text-text disabled:opacity-50"
          onClick={() => void onSkip()}
          disabled={busy}
        >
          {t('onboarding.username.skip')}
        </button>
        <span className="text-xs text-text-muted">{t('onboarding.username.step1of2')}</span>
      </div>
    </div>
  );
}

function PlayerCard({
  profile,
  headline,
  actionLabel,
  onAction,
  disabled,
}: {
  profile: ChessComPlayerProfile;
  headline: string;
  actionLabel: string;
  onAction: () => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const country = profile.country
    ? profile.country.replace('https://api.chess.com/pub/country/', '')
    : null;
  /**
   * Layout: identity above a full-width action on phones (`flex-col`), one row
   * on `>= sm`. Same shape as `NewGamesBanner`, for the same reasons.
   *
   * It used to be a single `flex` row at every width, which distorted the card
   * on a phone. The mechanism is worth knowing, because it is not the obvious
   * one: the text column is `flex-1`, i.e. `flex: 1 1 0%`, and shrink is
   * distributed in proportion to each item's *basis* — so a basis of 0
   * contributes nothing and the text absorbs none of the overflow. All of it
   * came out of the two `auto`-basis items instead: the avatar, which has no
   * `shrink-0` and so squashed from a 48 px circle into an ellipse, and the
   * `whitespace-nowrap` button, whose label then overflowed its own box. Hence
   * both fixes below — stacking buys the room, `shrink-0` stops the avatar
   * paying for a shortfall that is not its to pay.
   */
  return (
    <div className="rounded-lg border border-accent/30 bg-accent/5 p-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-4">
      <div className="flex items-center gap-3 min-w-0 sm:gap-4 sm:flex-1">
        {profile.avatar ? (
          // chess.com hot-links are public; no auth needed.
          <img
            src={profile.avatar}
            alt=""
            className="w-12 h-12 shrink-0 rounded-full object-cover bg-bg-raised"
          />
        ) : (
          <div className="w-12 h-12 shrink-0 rounded-full bg-bg-raised flex items-center justify-center text-text-muted text-lg font-semibold">
            {profile.username.charAt(0).toUpperCase()}
          </div>
        )}
        <div className="min-w-0">
          <div className="text-xs text-text-muted">{headline}</div>
          <div className="font-medium truncate">{profile.username}</div>
          <div className="text-xs text-text-muted truncate">
            {[profile.name, country].filter(Boolean).join(' · ') || t('onboarding.username.playerCardFallback')}
          </div>
        </div>
      </div>
      <button
        type="button"
        className="btn-primary whitespace-nowrap w-full sm:w-auto sm:shrink-0"
        onClick={onAction}
        disabled={disabled}
      >
        {actionLabel}
      </button>
    </div>
  );
}

/* =======================================================================
 *  Step 2 — Preset chooser
 * ======================================================================= */

interface PresetOption {
  id: '1m' | '3m' | '12m' | 'all';
  labelKey: string;
  months: number;
  emphasis?: boolean;
}

const PRESETS: PresetOption[] = [
  { id: '1m', labelKey: 'onboarding.preset.lastMonth', months: 1, emphasis: true },
  { id: '3m', labelKey: 'onboarding.preset.last3Months', months: 3 },
  { id: '12m', labelKey: 'onboarding.preset.last12Months', months: 12 },
  { id: 'all', labelKey: 'onboarding.preset.allGames', months: Infinity },
];

interface ArchiveCount {
  url: string;
  year: number;
  month: number;
  /** Number of games in this archive — populated lazily; null until
   *  the archive's month endpoint has been fetched. */
  count: number | null;
}

function PresetStep({
  username,
  onStart,
  onSkipImport,
}: {
  username: string;
  onStart: (months: number) => void | Promise<void>;
  onSkipImport: () => void | Promise<void>;
}) {
  const { t } = useTranslation();
  const [archives, setArchives] = useState<ArchiveCount[] | null>(null);
  const [archivesError, setArchivesError] = useState<string | null>(null);
  const [msPerGame, setMsPerGame] = useState<number | null>(null);
  const [chosen, setChosen] = useState<PresetOption['id']>('1m');
  const [starting, setStarting] = useState(false);

  // Pull archive list + game counts. The archives endpoint returns just
  // the URLs; we still need to fetch each month to know how many games
  // it contains. To keep the wizard responsive, we fetch only the most
  // recent 12 months eagerly (covers 1m / 3m / 12m presets exactly) and
  // estimate "all" by extrapolating from the average. Rate limiting on
  // chess.com isn't aggressive but we're nice anyway.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const urls = await fetchArchives(username);
        const enriched: ArchiveCount[] = urls
          .map((url): ArchiveCount | null => {
            const p = parseArchiveUrl(url);
            return p ? { url, year: p.year, month: p.month, count: null } : null;
          })
          .filter((x): x is ArchiveCount => x !== null)
          .sort((a, b) => (b.year - a.year) * 12 + (b.month - a.month));
        if (cancelled) return;
        setArchives(enriched);

        // Fetch the most-recent up-to-12 months' counts in parallel.
        const recent = enriched.slice(0, 12);
        const results = await Promise.all(
          recent.map(async (a) => {
            try {
              const games = await fetchMonth(a.url);
              return { url: a.url, count: games.length };
            } catch {
              return { url: a.url, count: 0 };
            }
          }),
        );
        if (cancelled) return;
        setArchives((prev) => {
          if (!prev) return prev;
          const byUrl = new Map(results.map((r) => [r.url, r.count]));
          return prev.map((a) =>
            byUrl.has(a.url) ? { ...a, count: byUrl.get(a.url)! } : a,
          );
        });
      } catch (e) {
        if (cancelled) return;
        setArchivesError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [username]);

  // Pull the device probe result. We don't await `probeDevice()` here
  // — it's fired from the page-level effect — but we read whatever
  // value lives in Settings, including the fallback the probe writes
  // on engine failure. If the probe hasn't completed yet, `msPerGame`
  // stays null and we use the `crossOriginIsolated`-aware fallback for
  // labels.
  useEffect(() => {
    let cancelled = false;
    let interval: ReturnType<typeof setInterval> | null = null;
    void (async () => {
      const tick = async () => {
        const s = await getSettings();
        if (cancelled) return;
        if (typeof s.deviceAnalysisMsPerGame === 'number') {
          setMsPerGame(s.deviceAnalysisMsPerGame);
          if (interval) clearInterval(interval);
        }
      };
      await tick();
      interval = setInterval(tick, 750);
    })();
    return () => {
      cancelled = true;
      if (interval) clearInterval(interval);
    };
  }, []);

  const fallbackMs =
    typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated
      ? FALLBACK_MS_PER_GAME_MULTI
      : FALLBACK_MS_PER_GAME_SINGLE;
  const effectiveMs = msPerGame ?? fallbackMs;

  /** Sum game counts across the most-recent N months. Returns null
   *  when archives haven't loaded yet; returns a (possibly-extrapolated)
   *  estimate for `Infinity`. */
  const counts = useMemo(() => {
    if (!archives) return null;
    return computePresetCounts(archives);
  }, [archives]);

  async function start() {
    if (starting) return;
    setStarting(true);
    try {
      const preset = PRESETS.find((p) => p.id === chosen)!;
      await onStart(preset.months);
    } finally {
      setStarting(false);
    }
  }

  return (
    <div className="card p-6 space-y-5">
      <div>
        <h2 className="text-lg font-medium">{t('onboarding.preset.title')}</h2>
        <p className="text-sm text-text-muted mt-1">
          <Trans
            i18nKey="onboarding.preset.intro"
            values={{ username }}
            components={{ 1: <span className="text-text" /> }}
          />
        </p>
      </div>

      {archivesError && (
        <div className="text-sm text-blunder border border-blunder/40 rounded-md p-3 bg-blunder/10">
          {t('onboarding.preset.fetchError', { error: archivesError })}
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {PRESETS.map((p) => {
          const isChosen = chosen === p.id;
          const c = counts?.[p.id] ?? null;
          const games = c?.games ?? null;
          const exact = c?.exact ?? false;
          const estimate = games != null
            ? estimateImportTime(games, effectiveMs)
            : null;
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => setChosen(p.id)}
              className={`text-left p-4 rounded-lg border transition-colors ${
                isChosen
                  ? 'border-accent bg-accent/10 text-text'
                  : p.emphasis
                    ? 'border-accent/40 bg-bg-soft hover:border-accent/60'
                    : 'border-border bg-bg-soft hover:border-accent/40'
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="font-medium">{t(p.labelKey)}</span>
                {p.emphasis && !isChosen && (
                  <span className="text-[10px] uppercase tracking-wider text-accent">
                    {t('onboarding.preset.recommended')}
                  </span>
                )}
              </div>
              <div className="text-xs text-text-muted mt-2">
                {games == null
                  ? t('onboarding.preset.loading')
                  : t(exact ? 'onboarding.preset.gameCount' : 'onboarding.preset.approxGameCount', { count: games, games: games.toLocaleString() })}
              </div>
              <div className="text-xs text-text-muted">
                {estimate ? t('onboarding.preset.analysisLabel', { label: estimate.label }) : ' '}
              </div>
            </button>
          );
        })}
      </div>

      {msPerGame === null && (
        <div className="text-[11px] text-text-muted">
          {t('onboarding.preset.calibrating')}
        </div>
      )}

      <div className="flex items-center justify-between border-t border-border pt-4">
        <button
          type="button"
          className="text-xs text-text-muted hover:text-text"
          onClick={() => void onSkipImport()}
        >
          {t('onboarding.preset.skipImport')}
        </button>
        <button
          type="button"
          className="btn-primary"
          disabled={starting || archives === null}
          onClick={() => void start()}
        >
          {starting ? t('onboarding.preset.starting') : t('onboarding.preset.startImport')}
        </button>
      </div>
    </div>
  );
}

/**
 * Roll up archive game counts into per-preset totals. For "all" we
 * sum what we have and *extrapolate* the unknown tail using the
 * average count across the loaded months — better an estimate than a
 * spinner that never settles.
 */
function computePresetCounts(
  archives: ArchiveCount[],
): Record<PresetOption['id'], { games: number; exact: boolean }> {
  function sumKnown(slice: ArchiveCount[]): { games: number; allKnown: boolean } {
    let games = 0;
    let allKnown = true;
    for (const a of slice) {
      if (a.count == null) {
        allKnown = false;
      } else {
        games += a.count;
      }
    }
    return { games, allKnown };
  }
  const m1 = sumKnown(archives.slice(0, 1));
  const m3 = sumKnown(archives.slice(0, 3));
  const m12 = sumKnown(archives.slice(0, 12));
  const known = archives.filter((a) => a.count != null);
  const avg = known.length > 0
    ? known.reduce((a, b) => a + (b.count ?? 0), 0) / known.length
    : 0;
  const extrapolatedAll = Math.round(
    sumKnown(archives).games + (archives.length - known.length) * avg,
  );
  return {
    '1m': { games: m1.games, exact: m1.allKnown },
    '3m': { games: m3.games, exact: m3.allKnown },
    '12m': { games: m12.games, exact: m12.allKnown },
    all: { games: extrapolatedAll, exact: known.length === archives.length },
  };
}

/* =======================================================================
 *  Step 3 — Importing
 * =======================================================================
 *
 *  By the time we reach this step, `importLastNMonths` was already
 *  kicked off by the parent (the wizard awaits it). We render a simple
 *  spinner-style status that auto-redirects to the dashboard once the
 *  import resolves, so step 3 is really just "show progress until
 *  import resolves, then redirect" — collapsed from the original plan.
 */

function ImportingStep({
  username,
  done,
  onDone,
}: {
  username: string;
  done: { added: number; skipped: number } | null;
  onDone: () => void | Promise<void>;
}) {
  const { t } = useTranslation();
  // Auto-advance once the import wraps. The 600ms delay lets the user
  // briefly see the success summary instead of being whisked away the
  // millisecond the last archive lands.
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => {
      void onDone();
    }, 600);
    return () => clearTimeout(t);
  }, [done, onDone]);

  return (
    <div className="card p-6 space-y-4">
      <h2 className="text-lg font-medium">
        {done ? t('onboarding.importing.imported') : t('onboarding.importing.title')}
      </h2>
      <p className="text-sm text-text-muted">
        <Trans
          i18nKey="onboarding.importing.intro"
          values={{ username }}
          components={{ 1: <span className="text-text" /> }}
        />
      </p>
      {!done ? (
        <div className="flex items-center gap-3 text-sm">
          <span className="inline-block w-3 h-3 rounded-full border-2 border-accent border-t-transparent animate-spin" />
          <span className="text-text-muted">{t('onboarding.importing.usuallyTakes')}</span>
        </div>
      ) : (
        <div className="text-sm">
          <Trans
            i18nKey="onboarding.importing.added"
            values={{ added: done.added }}
            components={{ good: <span className="text-good" /> }}
          />
          {done.skipped > 0 && (
            <Trans
              i18nKey="onboarding.importing.skipped"
              values={{ skipped: done.skipped }}
              components={{ neutral: <span className="text-text-muted" /> }}
            />
          )}
          {t('onboarding.importing.period')}
        </div>
      )}
    </div>
  );
}

// Re-export the `AutoImportProgress` type so callers importing from
// this module get a single import site even though the type itself
// lives in the auto-import feature.
export type { AutoImportProgress };
