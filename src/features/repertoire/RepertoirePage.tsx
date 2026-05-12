import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, type Repertoire } from '@/db/schema';
import { deleteRepertoire, dueCards } from './store';

/**
 * Repertoire list page. After the family-first refactor, repertoires
 * are bound 1:1 to opening families ("Sicilian Defense", "Italian
 * Game"). New repertoires are not created from this page — the user
 * creates them implicitly by adding lines from the Openings library
 * (`/openings`), which auto-creates the family-bound repertoire on
 * first add. This page is now a *list* + *practice launcher*.
 *
 * The legacy "New repertoire" button + free-form "Custom" repertoires
 * are intentionally not exposed here. v10 wiped the legacy data and
 * the new flow is family-driven. If a user genuinely wants a custom
 * tree they can still get one by importing PGN through the editor —
 * we don't surface a button for it because >95% of the use case is
 * the family flow.
 */
export function RepertoirePage() {
  const reps = useLiveQuery(
    () => db.repertoires.orderBy('updatedAt').reverse().toArray(),
    [],
  );
  const [dueCounts, setDueCounts] = useState<Record<string, number>>({});

  useLiveQuery(async () => {
    if (!reps) return;
    const counts: Record<string, number> = {};
    for (const r of reps) {
      const cards = await dueCards(r.id);
      counts[r.id] = cards.length;
    }
    setDueCounts(counts);
  }, [reps]);

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Repertoire</h1>
          <p className="text-sm text-text-muted">
            One repertoire per opening family. Add lines from the{' '}
            <Link to="/openings" className="text-accent hover:underline">
              openings library
            </Link>{' '}
            to build a family&rsquo;s repertoire, then drill it on the{' '}
            <Link to="/practice" className="text-accent hover:underline">
              practice page
            </Link>
            .
          </p>
        </div>
        <Link to="/openings" className="btn-primary text-xs">
          Browse openings
        </Link>
      </div>

      {!reps ? (
        <div className="card p-8 text-center text-text-muted">Loading…</div>
      ) : reps.length === 0 ? (
        <div className="card p-8 text-center text-text-muted space-y-2">
          <div className="text-lg">No repertoires yet.</div>
          <p className="text-sm">
            Pick an opening family and add a few lines from the{' '}
            <Link to="/openings" className="text-accent hover:underline">
              openings library
            </Link>{' '}
            — the repertoire is created for you.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {reps.map((r) => (
            <RepertoireCard
              key={r.id}
              rep={r}
              dueCount={dueCounts[r.id] ?? 0}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function RepertoireCard({
  rep,
  dueCount,
}: {
  rep: Repertoire;
  dueCount: number;
}) {
  const isFamily = rep.kind === 'family' || (rep.kind == null && Boolean(rep.family));
  return (
    <div className="card p-4 flex flex-col gap-3">
      <div>
        <div className="flex items-start justify-between gap-3">
          <div className="font-medium truncate">{rep.name}</div>
          <span
            className={`text-xs px-2 py-0.5 rounded shrink-0 border ${
              rep.color === 'white'
                ? 'bg-white text-black border-white/70'
                : 'bg-black text-white border-black'
            }`}
          >
            {rep.color}
          </span>
        </div>
        {!isFamily && (
          <div className="text-[11px] text-text-muted italic mt-0.5">
            Custom (not bound to a single family)
          </div>
        )}
        {rep.description && (
          <div className="text-xs text-text-muted mt-1">{rep.description}</div>
        )}
        <div className="text-xs text-text-muted mt-1">
          Updated {new Date(rep.updatedAt).toLocaleDateString()}
          {dueCount > 0 && (
            <>
              {' \u00b7 '}
              <span className="text-accent">{dueCount} due</span>
            </>
          )}
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        {/*
         * Two distinct study modes, surfaced as the only buttons on
         * the card. "Drill lines" is the default — play through the
         * prep one move at a time. "Review due" is the spaced-repetition
         * scheduler over individual positions; it leads with the due
         * count because that's the actual user-facing question
         * ("what's due today?"). The legacy "Lines" button — which
         * duplicated Drill-lines with a clunkier picker — was removed
         * 2026-05-12; its only unique feature, the family-aggregate
         * stats card, was ported into the practice page's right aside.
         */}
        <Link
          to={`/practice?rep=${encodeURIComponent(rep.id)}`}
          className="btn-primary text-xs"
          title="Play through the lines in this repertoire"
        >
          Drill lines
        </Link>
        <Link
          to={`/repertoire/${rep.id}/train`}
          className={dueCount > 0 ? 'btn-primary text-xs' : 'btn text-xs'}
          title="Spaced-repetition cards drilling individual positions"
        >
          {dueCount > 0 ? `Review due (${dueCount})` : 'Review (no cards due)'}
        </Link>
        <button
          type="button"
          className="btn text-xs ml-auto text-blunder hover:text-blunder"
          onClick={() => {
            if (confirm(`Delete repertoire "${rep.name}"?`))
              void deleteRepertoire(rep.id);
          }}
        >
          Delete
        </button>
      </div>
    </div>
  );
}
