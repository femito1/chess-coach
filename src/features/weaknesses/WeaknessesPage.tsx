import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  db,
  getSettings,
  normalizeTimeClassSelection,
  updateSettings,
} from '@/db/schema';
import type { Analysis, TimeClassSelection } from '@/db/schema';
import { listAllGamesLight } from '@/db/queries';
import { aggregateMistakes, type MistakeRow } from './aggregate';
import { MOTIF_EXPLANATION, MOTIF_LABEL } from '@/engine/motifs';
import { TimeClassChips } from '@/components/TimeClassFilter';
import { Board } from '@/components/Board';
import { THUMBNAIL_BOARD_MAX_PX } from '@/components/BoardFrame';
import { EvalBar } from '@/components/EvalBar';
import { CLASSIFICATION_LABEL } from '@/engine/classify';
import { gameMatchesSelection, labelForSelection } from '@/lib/timeClass';
import { useThrottledLiveQuery } from '@/lib/useThrottledLiveQuery';
import { Chess } from 'chess.js';

export function WeaknessesPage() {
  // Throttled to 1 s: the analyzer can fire hundreds of `db.games`
  // writes per minute during a queue run. We pull a *light* projection
  // (no PGN) since the aggregator only needs metadata + the analyses
  // table. Without the projection a 1 k-game library would haul ~2 MB
  // of PGN into memory on every refire — the dominant cause of the
  // mid-analysis page hangs the user reported on prod.
  const games = useThrottledLiveQuery(() => listAllGamesLight(), [], 1000);
  const [filter, setFilter] = useState<TimeClassSelection>(['rapid']);

  useEffect(() => {
    void getSettings().then((s) => {
      setFilter(normalizeTimeClassSelection(s.timeClassFilter));
    });
  }, []);

  const filteredGames = useMemo(
    () => (games ?? []).filter((g) => gameMatchesSelection(g, filter)),
    [games, filter],
  );

  // Only fetch analyses for the games that survive the time-class
  // filter. Each Analysis carries the full move list (often 40-100
  // entries × hundreds of bytes each), so bypassing irrelevant
  // analyses is a meaningful RAM saving on a multi-time-class library.
  const analyses = useThrottledLiveQuery(
    async () => {
      if (filteredGames.length === 0) return [] as Analysis[];
      const ids = filteredGames.map((g) => g.id);
      const rows = await db.analyses.bulkGet(ids);
      return rows.filter((a): a is Analysis => Boolean(a));
    },
    [filteredGames],
    1000,
  );

  const agg = useMemo(() => {
    if (!analyses) return null;
    const map = new Map<string, Analysis>();
    for (const a of analyses) map.set(a.gameId, a);
    return aggregateMistakes(filteredGames, map);
  }, [filteredGames, analyses]);

  function onFilterChange(next: TimeClassSelection) {
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
            : `Patterns across ${analyzedGames} analyzed ${labelForSelection(filter).toLowerCase()} game${analyzedGames === 1 ? '' : 's'} — what\u2019s costing you the most points.`}
        </p>
      </div>
      <TimeClassChips
        selection={filter}
        onChange={onFilterChange}
        available={games}
      />
    </div>
  );

  const isAll = filter.length === 0;
  if (!agg || analyzedGames === 0) {
    return (
      <div className="space-y-6">
        {header}
        <div className="card p-8 text-center text-text-muted space-y-2">
          <div className="text-lg">
            No analyzed {isAll ? '' : labelForSelection(filter).toLowerCase()} games yet.
          </div>
          <div className="text-sm">
            {isAll ? (
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
          <div className="space-y-3">
            {agg.byMotif.map((m) => (
              <div key={m.motif} className="border border-border rounded-md p-3 bg-bg-raised/30">
                <div className="flex items-baseline justify-between">
                  <div className="font-medium">{MOTIF_LABEL[m.motif]}</div>
                  <div className="text-accent font-mono">{m.count}</div>
                </div>
                <p className="mt-1 text-xs text-text-muted leading-relaxed">
                  {MOTIF_EXPLANATION[m.motif]}
                </p>
                <ul className="mt-3 divide-y divide-border">
                  {m.examples.map((ex) => (
                    <MistakeExample
                      key={`${ex.gameId}-${ex.ply}`}
                      row={ex}
                    />
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

/**
 * One example row inside a motif card. Click to expand into a mini
 * board preview showing the FEN before the mistake, the move the user
 * played (highlighted as the wrong move), and the move the engine
 * preferred (drawn as a green arrow). An EvalBar sits to the left of
 * the board mirroring the rhythm of the review page.
 *
 * Why expand-in-place vs. just routing to `/review/:id?ply=N`: from
 * Pass 4 user-feedback, clicking through to the review page jumped the
 * board to the position *after* the mistake (no move highlighted, no
 * "this is the bad move" framing) and the user had to navigate
 * backwards to even see what move was being criticised. The inline
 * preview answers "what was the move and what was wrong with it"
 * before the user commits to a full deep-link review.
 *
 * The "Review in full" button still routes to `/review/:id?ply=N`,
 * additionally appending `?from=weakness` so the review page can
 * surface a banner explaining the deep-link context (and pre-position
 * the board exactly on the offending ply).
 */
function MistakeExample({ row }: { row: MistakeRow }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <li className="py-2">
      <div className="flex items-center gap-2 text-sm">
        <button
          type="button"
          onClick={() => setExpanded((x) => !x)}
          className="text-text-muted hover:text-text shrink-0 w-5"
          aria-label={expanded ? 'Collapse example' : 'Expand example'}
          title={expanded ? 'Collapse' : 'Expand to see the position'}
        >
          {expanded ? '▼' : '▶'}
        </button>
        <span className="font-mono w-16 shrink-0">{row.san}</span>
        <span className="truncate flex-1 text-xs text-text-muted">
          vs {row.opponent}
          {row.bestMoveSan && (
            <>
              {' \u00b7 '}engine wanted{' '}
              <span className="font-mono text-good">{row.bestMoveSan}</span>
            </>
          )}
        </span>
        <Link
          to={buildReviewLink(row)}
          className="text-accent hover:underline shrink-0 text-xs"
        >
          Review in full →
        </Link>
      </div>
      {expanded && (
        <div className="mt-3">
          <ExpandedMistake row={row} />
        </div>
      )}
    </li>
  );
}

/**
 * Build the deep-link the "Review in full" button uses. We pin three
 * params:
 *  - `ply`        — jump straight to the offending position. Existing
 *                   behaviour, kept so the URL still works on its own.
 *  - `from`       — `'weakness'`. Tells the review page to render the
 *                   "you came from the weaknesses page" banner.
 *  - `motifs`     — comma-separated motif keys that this row was tagged
 *                   with. Lets the banner enumerate motif explanations
 *                   without re-reading the analysis row. Capped at the
 *                   first three so the URL stays sane.
 */
function buildReviewLink(row: MistakeRow): string {
  const params = new URLSearchParams();
  params.set('ply', String(row.ply));
  params.set('from', 'weakness');
  if (row.motifs.length > 0) {
    params.set('motifs', row.motifs.slice(0, 3).join(','));
  }
  return `/review/${row.gameId}?${params.toString()}`;
}

function ExpandedMistake({ row }: { row: MistakeRow }) {
  // Compute fenAfter (= the position the user *landed on* after their
  // mistake, before the engine's reply) so we can render the played
  // move's last-move highlight cleanly. Falls back to fenBefore when
  // we can't replay the move (corrupt UCI / illegal move — shouldn't
  // happen for stored analyses but defensive code is cheap).
  const fenAfter = useMemo(() => {
    if (!row.uci) return row.fenBefore;
    try {
      const c = new Chess(row.fenBefore);
      const m = c.move({
        from: row.uci.slice(0, 2),
        to: row.uci.slice(2, 4),
        promotion: row.uci.slice(4, 5) || undefined,
      });
      if (!m) return row.fenBefore;
      return c.fen();
    } catch {
      return row.fenBefore;
    }
  }, [row.fenBefore, row.uci]);

  // Mover-POV orientation. Mover side is `row.userColor` because
  // aggregator only emits rows where the mover is the user.
  const orientation = row.userColor;
  const bestArrow = row.bestMoveUci
    ? [
        {
          from: row.bestMoveUci.slice(0, 2),
          to: row.bestMoveUci.slice(2, 4),
          brush: 'engineBest' as const,
        },
      ]
    : [];

  return (
    <div className="bg-bg-soft rounded-md p-3 space-y-2">
      <p className="text-xs text-text-muted leading-relaxed">
        {row.userColor === 'white' ? 'You played White.' : 'You played Black.'}{' '}
        On move {Math.ceil(row.ply / 2)}, you played{' '}
        <span className="font-mono text-blunder font-semibold">{row.san}</span>
        {row.bestMoveSan ? (
          <>
            {' '}— the engine preferred{' '}
            <span className="font-mono text-good font-semibold">
              {row.bestMoveSan}
            </span>
            .
          </>
        ) : (
          '.'
        )}{' '}
        Classified as <span className="font-medium">
          {CLASSIFICATION_LABEL[row.classification]}
        </span>
        {row.inTimeTrouble && (
          <>
            {' '}<span className="text-mistake">(played in time trouble)</span>
          </>
        )}
        .
      </p>
      <div
        className="mx-auto w-full flex gap-2 items-stretch"
        style={{ maxWidth: `min(${THUMBNAIL_BOARD_MAX_PX}px, 80vw)` }}
      >
        <EvalBar
          cpWhite={row.evalCpBefore}
          orientation={orientation}
        />
        <div className="flex-1 min-w-0">
          <Board
            fen={fenAfter}
            orientation={orientation}
            lastMoveUci={row.uci}
            lastMoveClassification={row.classification}
            arrows={bestArrow}
            viewOnly
          />
        </div>
      </div>
      <p className="text-[11px] text-text-muted">
        Eval bar shows the position <em>before</em> your move. The board
        shows where it landed; the green arrow is what the engine wanted
        to play.
      </p>
    </div>
  );
}
