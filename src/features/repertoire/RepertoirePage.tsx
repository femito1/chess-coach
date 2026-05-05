import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, type Color } from '@/db/schema';
import { createRepertoire, deleteRepertoire, dueCards } from './store';

export function RepertoirePage() {
  const reps = useLiveQuery(() => db.repertoires.orderBy('updatedAt').reverse().toArray(), []);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [color, setColor] = useState<Color>('white');
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

  async function create() {
    if (!name.trim()) return;
    await createRepertoire({ name: name.trim(), color });
    setName('');
    setCreating(false);
  }

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Repertoire</h1>
          <p className="text-sm text-text-muted">
            Build an opening repertoire, drill it with spaced repetition, and compare
            your actual games against your prep.
          </p>
        </div>
        <button type="button" className="btn-primary" onClick={() => setCreating(!creating)}>
          {creating ? 'Cancel' : 'New repertoire'}
        </button>
      </div>

      {creating && (
        <div className="card p-4 space-y-3">
          <label className="block text-sm">
            <div className="mb-1 text-text-muted">Name</div>
            <input
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. My Najdorf"
            />
          </label>
          <label className="block text-sm">
            <div className="mb-1 text-text-muted">Color you play</div>
            <select
              className="input w-auto"
              value={color}
              onChange={(e) => setColor(e.target.value as Color)}
            >
              <option value="white">White</option>
              <option value="black">Black</option>
            </select>
          </label>
          <button type="button" className="btn-primary" onClick={create} disabled={!name.trim()}>
            Create
          </button>
        </div>
      )}

      {!reps || reps.length === 0 ? (
        <div className="card p-8 text-center text-text-muted">
          No repertoires yet. Create one to start building your prep.
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {reps.map((r) => (
            <div key={r.id} className="card p-4 flex flex-col gap-3">
              <div>
                <div className="flex items-start justify-between gap-3">
                  <div className="font-medium">{r.name}</div>
                  <span
                    className={`text-xs px-2 py-0.5 rounded ${r.color === 'white' ? 'bg-bg-raised text-text' : 'bg-text/90 text-bg'}`}
                  >
                    {r.color}
                  </span>
                </div>
                {r.description && (
                  <div className="text-xs text-text-muted mt-1">{r.description}</div>
                )}
                <div className="text-xs text-text-muted mt-1">
                  Updated {new Date(r.updatedAt).toLocaleDateString()}
                  {dueCounts[r.id] > 0 && (
                    <>
                      {' · '}
                      <span className="text-accent">{dueCounts[r.id]} due</span>
                    </>
                  )}
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <Link to={`/repertoire/${r.id}`} className="btn-primary text-xs">
                  Open
                </Link>
                <Link
                  to={`/repertoire/${r.id}/train`}
                  className="btn text-xs"
                  title="Spaced-repetition cards drilling individual positions"
                >
                  Cards {dueCounts[r.id] > 0 ? `(${dueCounts[r.id]})` : ''}
                </Link>
                <Link
                  to={`/repertoire/${r.id}/lines`}
                  className="btn text-xs"
                  title="Play through full opening lines from move 1"
                >
                  Lines
                </Link>
                <button
                  type="button"
                  className="btn text-xs ml-auto text-blunder hover:text-blunder"
                  onClick={() => {
                    if (confirm(`Delete repertoire "${r.name}"?`)) void deleteRepertoire(r.id);
                  }}
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
