import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { countByStatus, listGames, requeueAllErrors } from '@/db/queries';
import { db } from '@/db/schema';
import { isDue } from '@/srs/sm2';
import { ProgressCharts } from './ProgressCharts';
import { StorageBanner } from './StorageBanner';
import { useThrottledLiveQuery } from '@/lib/useThrottledLiveQuery';
import { totalSecondsPlayed } from './progress';

export function DashboardPage() {
  // Throttled to 1.5 s. These four queries together pull every game
  // (with PGN!), every puzzle, and every repertoire card on each Dexie
  // change event. While the analyzer is running, that fires hundreds of
  // times per minute and makes the dashboard feel glued to the engine.
  // 1.5 s of staleness on aggregate counters is invisible to the user.
  const counts = useThrottledLiveQuery(() => countByStatus(), [], 1500);
  const games = useThrottledLiveQuery(() => listGames(), [], 1500);
  const duePuzzles = useThrottledLiveQuery(
    async () => {
      const ps = await db.puzzles.toArray();
      return ps.filter((p) => isDue(p.srs)).length;
    },
    [],
    1500,
  );
  const dueRepCards = useThrottledLiveQuery(
    async () => {
      const cs = await db.repertoireCards.toArray();
      return cs.filter((c) => isDue(c.srs)).length;
    },
    [],
    1500,
  );

  const total = games?.length ?? 0;
  const wins = games?.filter((g) => g.result === 'win').length ?? 0;
  const losses = games?.filter((g) => g.result === 'loss').length ?? 0;
  const draws = games?.filter((g) => g.result === 'draw').length ?? 0;

  // Memoised because `totalSecondsPlayed` parses every PGN to extract
  // clocks. With a 1 k-game library that's non-trivial CPU; we don't
  // want to re-run on every dashboard re-render.
  const hoursPlayed = useMemo(
    () => totalSecondsPlayed(games ?? []) / 3600,
    [games],
  );

  const recent = games?.slice(0, 5) ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
          <p className="text-sm text-text-muted">
            Import games, let the engine analyze in the background, and review what to fix.
          </p>
        </div>
        <Link to="/import" className="btn-primary">
          Import games
        </Link>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat label="Games" value={total} />
        <Stat label="Wins" value={wins} tone="good" />
        <Stat label="Losses" value={losses} tone="bad" />
        <Stat label="Draws" value={draws} />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat label="Analyzed" value={counts?.done ?? 0} />
        <Stat label="Queued" value={(counts?.pending ?? 0) + (counts?.running ?? 0)} />
        <Stat label="Errors" value={counts?.error ?? 0} tone={counts?.error ? 'bad' : undefined} />
        <Stat label="Avg accuracy" value={avgAccuracy(games ?? [])} suffix="%" />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat label="Hours played" value={formatHours(hoursPlayed)} />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <Link to="/weaknesses" className="card p-4 hover:border-accent/60 transition-colors">
          <div className="text-xs text-text-muted">Study</div>
          <div className="text-lg font-semibold">Weaknesses</div>
          <div className="text-xs text-text-muted mt-1">
            Recurring mistake patterns across your games.
          </div>
        </Link>
        <Link to="/puzzles" className="card p-4 hover:border-accent/60 transition-colors">
          <div className="text-xs text-text-muted">Drill</div>
          <div className="text-lg font-semibold">
            Puzzles {duePuzzles ? <span className="text-accent">· {duePuzzles} due</span> : null}
          </div>
          <div className="text-xs text-text-muted mt-1">
            Generated from your own blunders.
          </div>
        </Link>
        <Link to="/repertoire" className="card p-4 hover:border-accent/60 transition-colors">
          <div className="text-xs text-text-muted">Prep</div>
          <div className="text-lg font-semibold">
            Repertoire {dueRepCards ? <span className="text-accent">· {dueRepCards} due</span> : null}
          </div>
          <div className="text-xs text-text-muted mt-1">
            Spaced-repetition opening training.
          </div>
        </Link>
      </div>

      <StorageBanner />

      {(counts?.error ?? 0) > 0 && (
        <div className="card p-3 flex items-center gap-3 border-blunder/40">
          <span className="text-sm text-blunder">
            {counts!.error} game{counts!.error === 1 ? '' : 's'} errored during analysis.
          </span>
          <button
            type="button"
            className="btn text-xs"
            onClick={() => void requeueAllErrors()}
          >
            Retry all
          </button>
        </div>
      )}

      <ProgressCharts games={games ?? []} />

      <section className="card p-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-medium">Recent games</h2>
          <Link to="/games" className="text-xs text-text-muted hover:text-text">
            View all →
          </Link>
        </div>
        {recent.length === 0 ? (
          <div className="text-sm text-text-muted py-8 text-center">
            No games yet.{' '}
            <Link to="/import" className="text-accent">
              Import your first batch
            </Link>
            .
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {recent.map((g) => (
              <li key={g.id} className="py-2 flex items-center gap-3 text-sm">
                <span
                  className={`w-1.5 h-1.5 rounded-full ${
                    g.result === 'win'
                      ? 'bg-good'
                      : g.result === 'loss'
                        ? 'bg-blunder'
                        : 'bg-text-muted'
                  }`}
                />
                <span className="flex-1 truncate">
                  vs <span className="font-medium">{g.opponent}</span>
                  <span className="text-text-muted"> · {g.opening ?? 'Unknown opening'}</span>
                </span>
                <span className="text-xs text-text-muted">{g.timeClass}</span>
                <Link to={`/review/${g.id}`} className="btn text-xs py-0.5 px-2">
                  Review
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
  suffix,
}: {
  label: string;
  value: number | string;
  tone?: 'good' | 'bad';
  suffix?: string;
}) {
  const toneClass = tone === 'good' ? 'text-good' : tone === 'bad' ? 'text-blunder' : '';
  return (
    <div className="card p-4">
      <div className="text-xs text-text-muted">{label}</div>
      <div className={`text-2xl font-semibold ${toneClass}`}>
        {value}
        {suffix}
      </div>
    </div>
  );
}

function avgAccuracy(games: { accuracy?: { white: number; black: number }; userColor: 'white' | 'black' }[]): string {
  const withAcc = games.filter((g) => g.accuracy);
  if (withAcc.length === 0) return '—';
  const sum = withAcc.reduce((acc, g) => acc + (g.userColor === 'white' ? g.accuracy!.white : g.accuracy!.black), 0);
  return (sum / withAcc.length).toFixed(1);
}

/** Compact hours-played formatter. Below an hour we show minutes; below
 *  ten hours we keep one decimal of precision (so 6.4 h doesn't round to
 *  6 h on a few short sessions); past that we show whole hours since
 *  the decimal is just noise. */
function formatHours(h: number): string {
  if (!Number.isFinite(h) || h <= 0) return '—';
  if (h < 1) return `${Math.round(h * 60)} min`;
  if (h < 10) return `${h.toFixed(1)} h`;
  return `${Math.round(h)} h`;
}
