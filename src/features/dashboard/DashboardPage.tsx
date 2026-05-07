import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { countByStatus, listGamesLight, requeueAllErrors } from '@/db/queries';
import { db } from '@/db/schema';
import { isDue } from '@/srs/sm2';
import { ProgressCharts } from './ProgressCharts';
import { StorageBanner } from './StorageBanner';
import { useThrottledLiveQuery } from '@/lib/useThrottledLiveQuery';
import { totalSecondsPlayed } from './progress';

export function DashboardPage() {
  // Throttled to 1.5 s. The dashboard's `games` query reads a *light*
  // projection (`listGamesLight` — no PGN) so each refire allocates
  // ~50 KB of metadata instead of ~2 MB of PGN strings. Combined with
  // cached `userTimeSec` (populated by the analyzer / backfill), this
  // keeps the dashboard fast even while the analyzer is firing per-game
  // writes through `useLiveQuery`.
  const counts = useThrottledLiveQuery(() => countByStatus(), [], 1500);
  const games = useThrottledLiveQuery(() => listGamesLight(), [], 1500);
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
  const decisive = wins + losses + draws;
  const winPct = decisive > 0 ? Math.round((wins / decisive) * 100) : 0;

  // Memoised because `totalSecondsPlayed` parses every PGN to extract
  // clocks. With a 1 k-game library that's non-trivial CPU; we don't
  // want to re-run on every dashboard re-render.
  const hoursPlayed = useMemo(
    () => totalSecondsPlayed(games ?? []) / 3600,
    [games],
  );

  // Analysis status is operational, not a KPI. We only surface it in
  // the dashboard grid when there's something the user might act on:
  // games actively queued/running, errored, or sitting unanalyzed.
  // The QueueIndicator pill handles the live-progress affordance.
  const analyzed = counts?.done ?? 0;
  const queued = (counts?.pending ?? 0) + (counts?.running ?? 0);
  const errored = counts?.error ?? 0;
  const unanalyzed = Math.max(0, total - analyzed - queued - errored);

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
        <RecordStat wins={wins} draws={draws} losses={losses} winPct={winPct} />
        <Stat
          label="Avg accuracy"
          value={avgAccuracy(games ?? [])}
          suffix={avgAccuracy(games ?? []) === '—' ? '' : '%'}
        />
        <Stat label="Hours played" value={formatHours(hoursPlayed)} />
      </div>

      <AnalysisStatus
        total={total}
        analyzed={analyzed}
        queued={queued}
        unanalyzed={unanalyzed}
        errored={errored}
        onRetryErrors={() => void requeueAllErrors()}
      />

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

/** Combined W/D/L stat. Shows the win-rate as the headline number and a
 *  chess.com-style stacked bar with W·D·L counts beneath it, so a single
 *  tile carries the full record without losing the per-bucket detail. */
function RecordStat({
  wins,
  draws,
  losses,
  winPct,
}: {
  wins: number;
  draws: number;
  losses: number;
  winPct: number;
}) {
  const total = wins + draws + losses;
  const winW = total > 0 ? (wins / total) * 100 : 0;
  const drawW = total > 0 ? (draws / total) * 100 : 0;
  const lossW = total > 0 ? (losses / total) * 100 : 0;
  return (
    <div className="card p-4 flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <div className="text-xs text-text-muted">Record</div>
        <div className="text-xs text-text-muted tabular-nums">
          <span className="text-good">{wins}W</span>
          <span> · </span>
          <span>{draws}D</span>
          <span> · </span>
          <span className="text-blunder">{losses}L</span>
        </div>
      </div>
      <div className="text-2xl font-semibold tabular-nums">
        {total > 0 ? `${winPct}%` : '—'}
      </div>
      <div
        className="h-1.5 w-full rounded-full bg-bg-raised overflow-hidden flex"
        role="img"
        aria-label={`${wins} wins, ${draws} draws, ${losses} losses`}
      >
        {winW > 0 && <div className="h-full bg-good" style={{ width: `${winW}%` }} />}
        {drawW > 0 && <div className="h-full bg-text-muted/60" style={{ width: `${drawW}%` }} />}
        {lossW > 0 && <div className="h-full bg-blunder" style={{ width: `${lossW}%` }} />}
      </div>
    </div>
  );
}

/** Single conditional banner for analysis state. Renders nothing in the
 *  steady state (everything analyzed, nothing queued, no errors) so the
 *  dashboard isn't cluttered with three tiles that are almost always
 *  zero. Surfaces actionable state otherwise:
 *    - errors → red, with retry-all
 *    - queued → accent, "analyzing N games"
 *    - unanalyzed-but-idle → muted, with a hint that import / requeue
 *      will pick them up
 */
function AnalysisStatus({
  total,
  analyzed,
  queued,
  unanalyzed,
  errored,
  onRetryErrors,
}: {
  total: number;
  analyzed: number;
  queued: number;
  unanalyzed: number;
  errored: number;
  onRetryErrors: () => void;
}) {
  if (total === 0) return null;
  if (queued === 0 && errored === 0 && unanalyzed === 0) return null;

  return (
    <div className="card p-3 flex flex-wrap items-center gap-x-4 gap-y-2">
      <span className="text-sm text-text-muted">
        Analysis: <span className="text-text">{analyzed}</span> / {total} analyzed
      </span>
      {queued > 0 && (
        <span className="text-sm text-accent">
          {queued} {queued === 1 ? 'game' : 'games'} in queue
        </span>
      )}
      {unanalyzed > 0 && queued === 0 && (
        <span className="text-sm text-text-muted">
          {unanalyzed} pending
        </span>
      )}
      {errored > 0 && (
        <span className="text-sm text-blunder flex items-center gap-2">
          {errored} {errored === 1 ? 'game' : 'games'} errored
          <button type="button" className="btn text-xs" onClick={onRetryErrors}>
            Retry all
          </button>
        </span>
      )}
    </div>
  );
}

function avgAccuracy(games: ReadonlyArray<{ accuracy?: { white: number; black: number }; userColor: 'white' | 'black' }>): string {
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
