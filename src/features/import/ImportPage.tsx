import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Trans } from 'react-i18next';
import { fetchArchives, fetchMonth, formatMonth, parseArchiveUrl } from '@/api/chesscom';
import { chessComGameToGame } from '@/import/importer';
import { upsertGames } from '@/db/queries';
import { getSettings, updateSettings, type ImportRecord } from '@/db/schema';
import { listImportRecordsFor, recordImport } from '@/db/imports';

interface ArchiveEntry {
  url: string;
  year: number;
  month: number;
  label: string;
}

export function ImportPage() {
  const { t } = useTranslation();
  const [username, setUsername] = useState('');
  const [archives, setArchives] = useState<ArchiveEntry[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [summary, setSummary] = useState<{ added: number; skipped: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [records, setRecords] = useState<Map<string, ImportRecord>>(new Map());

  useEffect(() => {
    void getSettings().then((s) => {
      if (s.username) setUsername(s.username);
    });
  }, []);

  const sortedArchives = useMemo(
    () => [...archives].sort((a, b) => (b.year - a.year) * 12 + (b.month - a.month)),
    [archives],
  );

  /** Months we have NOT yet imported for the current username, newest first. */
  const unsynced = useMemo(
    () => sortedArchives.filter((a) => !records.has(a.url)),
    [sortedArchives, records],
  );

  async function refreshRecords(forUser: string) {
    const recs = await listImportRecordsFor('chesscom', forUser);
    const map = new Map<string, ImportRecord>();
    for (const r of recs) map.set(r.archiveUrl, r);
    setRecords(map);
  }

  async function loadArchives() {
    setError(null);
    setLoading(true);
    setArchives([]);
    setSelected(new Set());
    try {
      const u = username.trim();
      const urls = await fetchArchives(u);
      const parsed: ArchiveEntry[] = urls
        .map((url) => {
          const p = parseArchiveUrl(url);
          return p ? { url, year: p.year, month: p.month, label: formatMonth(p.year, p.month) } : null;
        })
        .filter((x): x is ArchiveEntry => x !== null);
      setArchives(parsed);
      await updateSettings({ username: u });
      await refreshRecords(u);
      // Pre-select the latest month that hasn't been imported yet so the
      // common path ("pull what's new") is one click.
      if (parsed.length > 0) {
        const recs = await listImportRecordsFor('chesscom', u);
        const known = new Set(recs.map((r) => r.archiveUrl));
        const sorted = [...parsed].sort((a, b) => (b.year - a.year) * 12 + (b.month - a.month));
        const firstNew = sorted.find((a) => !known.has(a.url));
        setSelected(new Set([(firstNew ?? sorted[0]).url]));
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

  function selectUnsynced() {
    setSelected(new Set(unsynced.map((a) => a.url)));
  }

  async function doImport() {
    if (selected.size === 0) return;
    setImporting(true);
    setSummary(null);
    setError(null);
    setProgress({ done: 0, total: selected.size });
    let added = 0;
    let skipped = 0;
    const u = username.trim();
    try {
      let done = 0;
      for (const url of selected) {
        const games = await fetchMonth(url);
        const mapped = games.map((g) => chessComGameToGame(g, u));
        const res = await upsertGames(mapped);
        added += res.added;
        skipped += res.skipped;
        const parsed = parseArchiveUrl(url);
        if (parsed) {
          await recordImport({
            source: 'chesscom',
            username: u,
            archiveUrl: url,
            year: parsed.year,
            month: parsed.month,
            gameCount: games.length,
            added: res.added,
            skipped: res.skipped,
          });
        }
        done++;
        setProgress({ done, total: selected.size });
      }
      setSummary({ added, skipped });
      await refreshRecords(u);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setImporting(false);
    }
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t('import.pageTitle')}</h1>
        <p className="text-sm text-text-muted">{t('import.pageSubtitle')}</p>
      </div>

      <section className="card p-4 space-y-3">
        <label className="block text-sm">
          <div className="mb-1 text-text-muted">{t('import.usernameLabel')}</div>
          <div className="flex gap-2">
            <input
              className="input"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder={t('import.usernamePlaceholder')}
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
              {loading ? t('import.loading') : t('import.loadMonths')}
            </button>
          </div>
        </label>
        {error && <div className="text-sm text-blunder">{error}</div>}
      </section>

      {sortedArchives.length > 0 && (
        <section className="card p-4 space-y-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <h2 className="font-medium">
              {t('import.availableMonths', { count: sortedArchives.length })}
              {records.size > 0 && (
                <span className="ml-2 text-xs text-text-muted font-normal">
                  {t('import.previouslySynced', { synced: records.size, newCount: unsynced.length })}
                </span>
              )}
            </h2>
            <div className="flex gap-2 text-xs flex-wrap">
              {unsynced.length > 0 && (
                <button
                  type="button"
                  className="btn border-accent/40 text-accent"
                  onClick={selectUnsynced}
                  title={t('import.syncNewestTitle', { count: unsynced.length })}
                >
                  {t('import.syncNewest', { count: unsynced.length })}
                </button>
              )}
              <button type="button" className="btn" onClick={() => selectRecent(1)}>
                {t('import.latest')}
              </button>
              <button type="button" className="btn" onClick={() => selectRecent(3)}>
                {t('import.last3')}
              </button>
              <button type="button" className="btn" onClick={() => selectRecent(12)}>
                {t('import.last12')}
              </button>
              <button type="button" className="btn" onClick={() => setSelected(new Set())}>
                {t('import.clearSelection')}
              </button>
            </div>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2 max-h-80 overflow-auto pr-1">
            {sortedArchives.map((a) => {
              const isSelected = selected.has(a.url);
              const rec = records.get(a.url);
              return (
                <button
                  key={a.url}
                  type="button"
                  onClick={() => toggle(a.url)}
                  className={`text-sm px-3 py-2 rounded-md border transition-colors text-left flex flex-col gap-0.5 ${
                    isSelected
                      ? 'border-accent/60 bg-accent/15 text-accent'
                      : rec
                        ? 'border-good/30 bg-good/5 text-text hover:text-text'
                        : 'border-border bg-bg-soft text-text-muted hover:text-text'
                  }`}
                  title={rec ? t('import.tileLastImported', { relative: formatRelative(rec.importedAt, t), count: rec.gameCount }) : t('import.tileNotYetImported')}
                >
                  <span className="flex items-center gap-1.5">
                    {rec && <span className="text-good text-[10px]">✓</span>}
                    <span>{a.label}</span>
                  </span>
                  {rec && (
                    <span className="text-[11px] text-text-muted">
                      {t('import.tileGamesAndRelative', { count: rec.gameCount, relative: formatRelative(rec.importedAt, t) })}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
          <div className="flex items-center gap-3 pt-2 flex-wrap">
            <button
              type="button"
              className="btn-primary"
              onClick={doImport}
              disabled={selected.size === 0 || importing}
            >
              {importing
                ? t('import.importingProgress', { done: progress?.done ?? 0, total: progress?.total ?? 0 })
                : t('import.importMonths', { count: selected.size })}
            </button>
            {summary && (
              <div className="text-sm text-text-muted">
                <Trans
                  i18nKey="import.summary"
                  values={{ added: summary.added, skipped: summary.skipped }}
                  components={{ good: <span className="text-good" />, neutral: <span className="text-text" /> }}
                />
              </div>
            )}
          </div>
        </section>
      )}
    </div>
  );
}

function formatRelative(epochMs: number, t: (key: string, opts?: Record<string, unknown>) => string): string {
  const diff = Date.now() - epochMs;
  const m = Math.floor(diff / 60_000);
  if (m < 1) return t('import.relativeJustNow');
  if (m < 60) return t('import.relativeMinutes', { value: m });
  const h = Math.floor(m / 60);
  if (h < 24) return t('import.relativeHours', { value: h });
  const d = Math.floor(h / 24);
  if (d < 30) return t('import.relativeDays', { value: d });
  const mo = Math.floor(d / 30);
  if (mo < 12) return t('import.relativeMonths', { value: mo });
  const y = Math.floor(mo / 12);
  return t('import.relativeYears', { value: y });
}
