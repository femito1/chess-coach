import { useEffect, useMemo, useState } from 'react';
import { fetchArchives, fetchMonth, formatMonth, parseArchiveUrl } from '@/api/chesscom';
import { chessComGameToGame } from '@/import/importer';
import { upsertGames } from '@/db/queries';
import { getSettings, updateSettings } from '@/db/schema';

interface ArchiveEntry {
  url: string;
  year: number;
  month: number;
  label: string;
}

export function ImportPage() {
  const [username, setUsername] = useState('');
  const [archives, setArchives] = useState<ArchiveEntry[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [summary, setSummary] = useState<{ added: number; skipped: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void getSettings().then((s) => {
      if (s.username) setUsername(s.username);
    });
  }, []);

  const sortedArchives = useMemo(
    () => [...archives].sort((a, b) => (b.year - a.year) * 12 + (b.month - a.month)),
    [archives],
  );

  async function loadArchives() {
    setError(null);
    setLoading(true);
    setArchives([]);
    setSelected(new Set());
    try {
      const urls = await fetchArchives(username.trim());
      const parsed: ArchiveEntry[] = urls
        .map((url) => {
          const p = parseArchiveUrl(url);
          return p ? { url, year: p.year, month: p.month, label: formatMonth(p.year, p.month) } : null;
        })
        .filter((x): x is ArchiveEntry => x !== null);
      setArchives(parsed);
      await updateSettings({ username: username.trim() });
      // Pre-select latest month.
      if (parsed.length > 0) {
        const latest = [...parsed].sort((a, b) => (b.year - a.year) * 12 + (b.month - a.month))[0];
        setSelected(new Set([latest.url]));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  function toggle(url: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(url)) next.delete(url);
      else next.add(url);
      return next;
    });
  }

  function selectRecent(n: number) {
    const recent = sortedArchives.slice(0, n);
    setSelected(new Set(recent.map((a) => a.url)));
  }

  async function doImport() {
    if (selected.size === 0) return;
    setImporting(true);
    setSummary(null);
    setError(null);
    setProgress({ done: 0, total: selected.size });
    let added = 0;
    let skipped = 0;
    try {
      let done = 0;
      for (const url of selected) {
        const games = await fetchMonth(url);
        const mapped = games.map((g) => chessComGameToGame(g, username.trim()));
        const res = await upsertGames(mapped);
        added += res.added;
        skipped += res.skipped;
        done++;
        setProgress({ done, total: selected.size });
      }
      setSummary({ added, skipped });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setImporting(false);
    }
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Import from Chess.com</h1>
        <p className="text-sm text-text-muted">
          Enter your Chess.com username, pick months, and we'll pull your games via the public API.
          Analysis runs in the background after import.
        </p>
      </div>

      <section className="card p-4 space-y-3">
        <label className="block text-sm">
          <div className="mb-1 text-text-muted">Chess.com username</div>
          <div className="flex gap-2">
            <input
              className="input"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="magnuscarlsen"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && username.trim()) void loadArchives();
              }}
            />
            <button
              type="button"
              className="btn-primary whitespace-nowrap"
              onClick={loadArchives}
              disabled={!username.trim() || loading}
            >
              {loading ? 'Loading…' : 'Load months'}
            </button>
          </div>
        </label>
        {error && <div className="text-sm text-blunder">{error}</div>}
      </section>

      {sortedArchives.length > 0 && (
        <section className="card p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="font-medium">Available months ({sortedArchives.length})</h2>
            <div className="flex gap-2 text-xs">
              <button className="btn" onClick={() => selectRecent(1)}>
                Latest
              </button>
              <button className="btn" onClick={() => selectRecent(3)}>
                Last 3
              </button>
              <button className="btn" onClick={() => selectRecent(12)}>
                Last 12
              </button>
              <button className="btn" onClick={() => setSelected(new Set())}>
                Clear
              </button>
            </div>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2 max-h-80 overflow-auto pr-1">
            {sortedArchives.map((a) => {
              const isSelected = selected.has(a.url);
              return (
                <button
                  key={a.url}
                  type="button"
                  onClick={() => toggle(a.url)}
                  className={`text-sm px-3 py-2 rounded-md border transition-colors text-left ${
                    isSelected
                      ? 'border-accent/60 bg-accent/15 text-accent'
                      : 'border-border bg-bg-soft text-text-muted hover:text-text'
                  }`}
                >
                  {a.label}
                </button>
              );
            })}
          </div>
          <div className="flex items-center gap-3 pt-2">
            <button
              type="button"
              className="btn-primary"
              onClick={doImport}
              disabled={selected.size === 0 || importing}
            >
              {importing
                ? `Importing ${progress?.done ?? 0}/${progress?.total ?? 0}…`
                : `Import ${selected.size} month${selected.size === 1 ? '' : 's'}`}
            </button>
            {summary && (
              <div className="text-sm text-text-muted">
                Added <span className="text-good">{summary.added}</span>, skipped{' '}
                <span className="text-text">{summary.skipped}</span> duplicates.
              </div>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
