import { useEffect, useState } from 'react';
import {
  getSettings,
  normalizeTimeClassSelection,
  updateSettings,
  db,
  type TimeClassSelection,
} from '@/db/schema';
import { listAllGamesLight, requeueGamesByScope, type RequeueScope } from '@/db/queries';
import { TimeClassChips } from '@/components/TimeClassFilter';
import { useThrottledLiveQuery } from '@/lib/useThrottledLiveQuery';
import {
  CHROME_EXTENSION_NAME,
  CHROME_EXTENSION_STORE_URL,
} from '@/lib/extension';

export function SettingsPage() {
  const [username, setUsername] = useState('');
  const [engineDepth, setEngineDepth] = useState(16);
  const [autoAnalyze, setAutoAnalyze] = useState(true);
  const [savedDepth, setSavedDepth] = useState(16);
  const [timeClassFilter, setTimeClassFilter] = useState<TimeClassSelection>(['rapid']);
  const [saved, setSaved] = useState(false);
  const [importStatus, setImportStatus] = useState<string | null>(null);
  const [requeueStatus, setRequeueStatus] = useState<string | null>(null);
  const [extensionDismissedAt, setExtensionDismissedAt] = useState<number | undefined>(
    undefined,
  );
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

  async function exportAll() {
    const [games, analyses, settings] = await Promise.all([
      db.games.toArray(),
      db.analyses.toArray(),
      db.settings.toArray(),
    ]);
    const blob = new Blob([JSON.stringify({ games, analyses, settings }, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `chess-coach-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function importBackup(file: File) {
    setImportStatus('Importing…');
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      await db.transaction('rw', db.games, db.analyses, db.settings, async () => {
        if (Array.isArray(data.games)) await db.games.bulkPut(data.games);
        if (Array.isArray(data.analyses)) await db.analyses.bulkPut(data.analyses);
        if (Array.isArray(data.settings)) await db.settings.bulkPut(data.settings);
      });
      setImportStatus(`Imported ${data.games?.length ?? 0} games.`);
    } catch (e) {
      setImportStatus(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }
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

  async function wipe() {
    if (!confirm('Delete ALL games, analyses and settings? This cannot be undone.')) return;
    await db.transaction('rw', db.games, db.analyses, db.settings, async () => {
      await db.games.clear();
      await db.analyses.clear();
      await db.settings.clear();
    });
    setImportStatus('All local data deleted.');
  }

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
      </div>

      <section className="card p-4 space-y-4">
        <label className="block text-sm">
          <div className="mb-1 text-text-muted">Chess.com username</div>
          <input className="input" value={username} onChange={(e) => setUsername(e.target.value)} />
        </label>
        <label className="block text-sm">
          <div className="mb-1 text-text-muted">
            Engine depth: <span className="text-text font-mono">{engineDepth}</span>
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
            Higher = stronger but slower. 16 is a good balance for casual review.
          </div>
        </label>
        <div className="block text-sm">
          <div className="mb-1 text-text-muted">Default time-control filter</div>
          <TimeClassChips
            selection={timeClassFilter}
            onChange={setTimeClassFilter}
            available={games ?? []}
          />
          <div className="text-xs text-text-muted mt-1">
            Weaknesses and Puzzles default to these time controls. Pick one
            or more chips, or "All" for everything. Bullet games are high
            volume but low ROI for study, so rapid is a sensible default.
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={autoAnalyze}
            onChange={(e) => setAutoAnalyze(e.target.checked)}
          />
          <span>Automatically analyze imported games in the background</span>
        </label>
        <div className="flex items-center gap-3">
          <button type="button" className="btn-primary" onClick={save}>
            Save
          </button>
          {saved && <span className="text-good text-sm">Saved.</span>}
        </div>

        {depthChanged && (
          <div className="border border-accent/40 bg-accent/5 rounded-md p-3 text-sm space-y-2">
            <div>
              Engine depth changed from{' '}
              <span className="font-mono">{savedDepth}</span> to{' '}
              <span className="font-mono text-accent">{engineDepth}</span>. Re-analyze existing
              games at the new depth?
            </div>
            <div className="flex flex-wrap gap-2">
              <button type="button" className="btn text-xs" onClick={() => doRequeue('latest')}>
                Most recent game
              </button>
              <button type="button" className="btn text-xs" onClick={() => doRequeue('day')}>
                Past day
              </button>
              <button type="button" className="btn text-xs" onClick={() => doRequeue('week')}>
                Past week
              </button>
              <button type="button" className="btn text-xs" onClick={() => doRequeue('month')}>
                Past month
              </button>
              <button type="button" className="btn text-xs" onClick={() => doRequeue('all')}>
                All games
              </button>
              <button
                type="button"
                className="btn text-xs text-text-muted"
                onClick={() => setEngineDepth(savedDepth)}
              >
                Cancel
              </button>
            </div>
            {requeueStatus && <div className="text-xs text-text-muted">{requeueStatus}</div>}
          </div>
        )}
        {!depthChanged && requeueStatus && (
          <div className="text-xs text-text-muted">{requeueStatus}</div>
        )}
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
            <h2 className="font-medium">Browser extension</h2>
            <button
              type="button"
              className="text-xs text-text-muted hover:text-text"
              onClick={() => void dismissExtensionPromo()}
              aria-label="Dismiss extension promo"
              title="Hide this card"
            >
              Dismiss
            </button>
          </div>
          <p className="text-sm">
            <strong>{CHROME_EXTENSION_NAME}</strong> turns the manual flow
            below into a single click: finish a game on Chess.com, click
            the prompt that appears in the corner, and land here with the
            game already imported and analysing.
          </p>
          <ul className="text-xs text-text-muted list-disc pl-5 space-y-0.5">
            <li>No copy-pasting URLs from the chess.com tab.</li>
            <li>
              No data leaves your machine — the extension only reads the
              game URL and opens this app.
            </li>
            <li>Open source; same MIT license as the app.</li>
          </ul>
          <div className="flex flex-wrap gap-2 pt-1">
            <a
              className="btn-primary text-sm"
              href={CHROME_EXTENSION_STORE_URL}
              target="_blank"
              rel="noopener noreferrer"
            >
              Get it on the Chrome Web Store
            </a>
          </div>
        </section>
      ) : (
        <div className="text-xs text-text-muted flex items-center gap-2">
          <span>Browser extension promo dismissed.</span>
          <button
            type="button"
            className="text-accent hover:underline"
            onClick={() => void reopenExtensionPromo()}
          >
            Reopen
          </button>
        </div>
      )}

      <section className="card p-4 space-y-3">
        <h2 className="font-medium">Backup &amp; data</h2>
        <p className="text-xs text-text-muted">
          All your data lives in this browser's IndexedDB. Export it to a JSON file to move
          between devices or keep a backup.
        </p>
        <div className="flex flex-wrap gap-2">
          <button className="btn" onClick={exportAll}>
            Export JSON
          </button>
          <label className="btn cursor-pointer">
            Import JSON
            <input
              type="file"
              accept="application/json"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void importBackup(f);
                e.target.value = '';
              }}
            />
          </label>
          <button className="btn text-blunder hover:text-blunder" onClick={wipe}>
            Delete all data
          </button>
        </div>
        {importStatus && <div className="text-xs text-text-muted">{importStatus}</div>}
      </section>
    </div>
  );
}
