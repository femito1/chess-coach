import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, getSettings, updateSettings } from '@/db/schema';
import type { Analysis, TimeClassFilter } from '@/db/schema';
import { aggregateMistakes } from './aggregate';
import { MOTIF_LABEL } from '@/engine/motifs';
import { TimeClassFilterSelect } from '@/components/TimeClassFilter';
import { gameMatchesFilter, labelFor } from '@/lib/timeClass';

export function WeaknessesPage() {
  const games = useLiveQuery(() => db.games.toArray(), []);
  const [filter, setFilter] = useState<TimeClassFilter>('rapid');

  // Load saved filter preference once.
  useEffect(() => {
    void getSettings().then((s) => {
      if (s.timeClassFilter) setFilter(s.timeClassFilter);
    });
  }, []);

  const filteredGames = useMemo(
    () => (games ?? []).filter((g) => gameMatchesFilter(g, filter)),
    [games, filter],
  );

  // Only fetch analyses for the games that survive the time-class
  // filter. Each Analysis carries the full move list (often 40-100
  // entries × hundreds of bytes each), so bypassing irrelevant
  // analyses is a meaningful RAM saving on a multi-time-class library.
  const analyses = useLiveQuery(async () => {
    if (filteredGames.length === 0) return [] as Analysis[];
    const ids = filteredGames.map((g) => g.id);
    const rows = await db.analyses.bulkGet(ids);
    return rows.filter((a): a is Analysis => Boolean(a));
  }, [filteredGames]);

  const agg = useMemo(() => {
    if (!analyses) return null;
    const map = new Map<string, Analysis>();
    for (const a of analyses) map.set(a.gameId, a);
    return aggregateMistakes(filteredGames, map);
  }, [filteredGames, analyses]);

  function onFilterChange(next: TimeClassFilter) {
    setFilter(next);
    void updateSettings({ timeClassFilter: next });
  }

  if (!games || !analyses) {
    return <div className="text-text-muted">Loading…</div>;
  }

  const analyzedGames = filteredGames.filter((g) => g.analysisStatus === 'done').length;

  const header = (
    <div className="flex items-end justify-between gap-4 flex-wrap">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Weaknesses</h1>
        <p className="text-sm text-text-muted">
          {analyzedGames === 0
            ? 'Patterns across your analyzed games — what\u2019s costing you the most points.'
            : `Patterns across ${analyzedGames} analyzed ${labelFor(filter).toLowerCase()} game${analyzedGames === 1 ? '' : 's'} — what\u2019s costing you the most points.`}
        </p>
      </div>
      <TimeClassFilterSelect
        value={filter}
        onChange={onFilterChange}
        available={games}
      />
    </div>
  );

  if (!agg || analyzedGames === 0) {
    return (
      <div className="space-y-6">
        {header}
        <div className="card p-8 text-center text-text-muted space-y-2">
          <div className="text-lg">
            No analyzed {filter === 'all' ? '' : labelFor(filter).toLowerCase()} games yet.
          </div>
          <div className="text-sm">
            {filter === 'all' ? (
              <>
                <Link to="/import" className="text-accent">
                  Import some games
                </Link>{' '}
                and let the engine finish, then come back.
              </>
            ) : (
              <>
                Try switching the filter above, or{' '}
                <Link to="/import" className="text-accent">
                  import more games
                </Link>
                .
              </>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {header}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="Total mistakes" value={agg.totalMistakes} />
        <StatCard
          label="Opening drops"
          value={agg.byPhase.opening.count}
          sub={pct(agg.byPhase.opening.avgDrop)}
        />
        <StatCard
          label="Middlegame drops"
          value={agg.byPhase.middlegame.count}
          sub={pct(agg.byPhase.middlegame.avgDrop)}
        />
        <StatCard
          label="Endgame drops"
          value={agg.byPhase.endgame.count}
          sub={pct(agg.byPhase.endgame.avgDrop)}
        />
      </div>

      <section className="card p-4">
        <h2 className="font-medium mb-3">Tactical motifs</h2>
        {agg.byMotif.length === 0 ? (
          <div className="text-sm text-text-muted">
            No tactical motifs detected yet. The detector runs on newly
            analyzed games; if you imported games before this update, re-run
            the analysis from Settings.
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {agg.byMotif.map((m) => (
              <div key={m.motif} className="border border-border rounded-md p-3 bg-bg-raised/30">
                <div className="flex items-baseline justify-between">
                  <div className="font-medium">{MOTIF_LABEL[m.motif]}</div>
                  <div className="text-accent font-mono">{m.count}</div>
                </div>
                <ul className="mt-2 space-y-1 text-xs text-text-muted">
                  {m.examples.map((ex) => (
                    <li key={`${ex.gameId}-${ex.ply}`} className="flex gap-2 items-center">
                      <span className="font-mono w-14 shrink-0">{ex.san}</span>
                      <span className="truncate flex-1">vs {ex.opponent}</span>
                      <Link
                        to={`/review/${ex.gameId}?ply=${ex.ply}`}
                        className="text-accent hover:underline shrink-0"
                      >
                        Review →
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="card p-4">
        <h2 className="font-medium mb-3">Time pressure</h2>
        <div className="grid grid-cols-2 gap-4 text-sm">
          <TimePressureCard
            title="In time trouble"
            total={agg.byTimePressure.inTrouble.count}
            mistakes={agg.byTimePressure.inTrouble.mistakes}
            rate={agg.byTimePressure.inTrouble.rate}
            bad
          />
          <TimePressureCard
            title="Normal tempo"
            total={agg.byTimePressure.normal.count}
            mistakes={agg.byTimePressure.normal.mistakes}
            rate={agg.byTimePressure.normal.rate}
          />
        </div>
        <div className="text-xs text-text-muted mt-2">
          "Time trouble" = under 15 seconds, or under 20% of base time.
        </div>
      </section>

      <section className="card p-4">
        <h2 className="font-medium mb-3">Openings: worst accuracy</h2>
        {agg.byOpening.length === 0 ? (
          <div className="text-sm text-text-muted">
            Not enough data yet. Play or import more games with known openings.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-text-muted text-xs">
              <tr>
                <th className="text-left p-2 font-medium">Opening</th>
                <th className="text-right p-2 font-medium">Games</th>
                <th className="text-right p-2 font-medium">Mistakes</th>
                <th className="text-right p-2 font-medium">Your avg accuracy</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {agg.byOpening.slice(0, 10).map((o) => (
                <tr key={o.opening} className="hover:bg-bg-raised/60">
                  <td className="p-2 truncate max-w-[400px]">{o.opening}</td>
                  <td className="p-2 text-right font-mono">{o.games}</td>
                  <td className="p-2 text-right font-mono">{o.mistakes}</td>
                  <td className="p-2 text-right font-mono">{o.avgAcc.toFixed(1)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card p-4">
        <h2 className="font-medium mb-3">Recurring blunder squares</h2>
        {agg.recurringSquares.length === 0 ? (
          <div className="text-sm text-text-muted">
            No repeated-square patterns yet.
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {agg.recurringSquares.slice(0, 12).map((s) => (
              <div
                key={s.square}
                className="px-3 py-1.5 rounded-md bg-blunder/15 text-blunder font-mono text-sm"
              >
                {s.square} <span className="text-xs opacity-80">×{s.count}</span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function StatCard({ label, value, sub }: { label: string; value: number | string; sub?: string }) {
  return (
    <div className="card p-4">
      <div className="text-xs text-text-muted">{label}</div>
      <div className="text-2xl font-semibold">{value}</div>
      {sub && <div className="text-xs text-text-muted">avg drop {sub}</div>}
    </div>
  );
}

function TimePressureCard({
  title,
  total,
  mistakes,
  rate,
  bad,
}: {
  title: string;
  total: number;
  mistakes: number;
  rate: number;
  bad?: boolean;
}) {
  return (
    <div className={`border rounded-md p-3 ${bad ? 'border-blunder/40 bg-blunder/5' : 'border-border bg-bg-raised/30'}`}>
      <div className="text-xs text-text-muted uppercase tracking-wide">{title}</div>
      <div className="mt-1 text-lg font-semibold">{(rate * 100).toFixed(1)}%</div>
      <div className="text-xs text-text-muted">
        {mistakes} mistakes across {total} moves
      </div>
    </div>
  );
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}
