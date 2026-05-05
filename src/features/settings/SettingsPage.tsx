import { useEffect, useState } from 'react';
import { getSettings, updateSettings, db, type TimeClassFilter } from '@/db/schema';
import { requeueGamesByScope, type RequeueScope } from '@/db/queries';
import { TimeClassFilterSelect } from '@/components/TimeClassFilter';
import { useThrottledLiveQuery } from '@/lib/useThrottledLiveQuery';

export function SettingsPage() {
  const [username, setUsername] = useState('');
  const [engineDepth, setEngineDepth] = useState(16);
  const [autoAnalyze, setAutoAnalyze] = useState(true);
  const [savedDepth, setSavedDepth] = useState(16);
  const [timeClassFilter, setTimeClassFilter] = useState<TimeClassFilter>('rapid');
  const [saved, setSaved] = useState(false);
  const [importStatus, setImportStatus] = useState<string | null>(null);
  const [requeueStatus, setRequeueStatus] = useState<string | null>(null);
  // Settings only uses `games` to populate the time-class filter dropdown
  // — staleness of a few seconds is invisible. Throttled for the same
  // reason as the dashboard / weaknesses pages.
  const games = useThrottledLiveQuery(() => db.games.toArray(), [], 1500);

  useEffect(() => {
    void getSettings().then((s) => {
      setUsername(s.username);
      setEngineDepth(s.engineDepth);
      setSavedDepth(s.engineDepth);
      setAutoAnalyze(s.autoAnalyze);
      if (s.timeClassFilter) setTimeClassFilter(s.timeClassFilter);
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
        <label className="block text-sm">
          <div className="mb-1 text-text-muted">Default time-control filter</div>
          <TimeClassFilterSelect
            value={timeClassFilter}
            onChange={setTimeClassFilter}
            available={games ?? []}
          />
          <div className="text-xs text-text-muted mt-1">
            Weaknesses and Puzzles default to this time control. Bullet games are high
            volume but low ROI for study, so rapid is a sensible default.
          </div>
        </label>
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
