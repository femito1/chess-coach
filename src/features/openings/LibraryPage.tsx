import { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Board } from '@/components/Board';
import { db, type Color } from '@/db/schema';
import { createRepertoire } from '@/features/repertoire/store';
import {
  addFamilyToRepertoire,
  addLineToRepertoire,
  colorHint,
  familyColor,
  getFamilies,
  getVariations,
  replayLine,
  searchOpenings,
  type OpeningLine,
  type VariationEntry,
} from './library';
import { ColorBadge } from './ColorBadge';

type ColorFilter = 'all' | Color;

const FAMILIES = getFamilies();

export function LibraryPage() {
  const [query, setQuery] = useState('');
  const [colorFilter, setColorFilter] = useState<ColorFilter>('all');
  const [selectedFamily, setSelectedFamily] = useState<string | null>(null);
  const [selectedLine, setSelectedLine] = useState<OpeningLine | null>(null);
  const [ply, setPly] = useState(0);

  const filteredFamilies = useMemo(() => {
    const q = query.trim().toLowerCase();
    return FAMILIES.filter((f) => {
      if (colorFilter !== 'all' && f.color !== colorFilter) return false;
      if (q && !f.family.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [query, colorFilter]);

  const searchResults = useMemo(() => {
    if (query.trim().length < 2) return [];
    const all = searchOpenings(query, 80);
    return colorFilter === 'all'
      ? all.slice(0, 40)
      : all.filter((r) => colorHint(r) === colorFilter).slice(0, 40);
  }, [query, colorFilter]);

  const variations = useMemo(
    () => (selectedFamily ? getVariations(selectedFamily) : []),
    [selectedFamily],
  );

  function pickLine(line: OpeningLine) {
    setSelectedLine(line);
    setPly(line.uci.length);
  }

  const { fens, sans } = useMemo(
    () => (selectedLine ? replayLine(selectedLine) : { fens: [], sans: [] }),
    [selectedLine],
  );

  const currentFen = fens[ply] ?? fens[0] ?? '';
  const lastUci =
    selectedLine && ply > 0 ? selectedLine.uci[ply - 1] : undefined;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Openings Library</h1>
        <p className="text-sm text-text-muted">
          Browse {FAMILIES.reduce((n, f) => n + f.count, 0)} preloaded lines from the
          Lichess opening database. Pick any line to preview it, then add it to a
          repertoire for spaced-repetition drilling.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[340px_minmax(0,1fr)] gap-4 items-start">
        <aside className="card p-3 space-y-3">
          <input
            className="input"
            placeholder='Search family or ECO (e.g. "Najdorf", "B90")'
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />

          <div className="flex gap-1 text-xs">
            <ColorFilterButton
              label="Both sides"
              active={colorFilter === 'all'}
              onClick={() => setColorFilter('all')}
            />
            <ColorFilterButton
              label="As White"
              active={colorFilter === 'white'}
              onClick={() => setColorFilter('white')}
              color="white"
            />
            <ColorFilterButton
              label="As Black"
              active={colorFilter === 'black'}
              onClick={() => setColorFilter('black')}
              color="black"
            />
          </div>

          {searchResults.length > 0 && (
            <div className="space-y-1 border-b border-border pb-2">
              <div className="text-xs uppercase tracking-wide text-text-muted">
                Search results
              </div>
              <ul className="max-h-48 overflow-auto divide-y divide-border scrollable pr-2">
                {searchResults.map((r) => (
                  <li key={r.name}>
                    <button
                      type="button"
                      onClick={() => pickLine(r)}
                      className="w-full text-left py-1 text-sm hover:text-accent flex items-center gap-2"
                    >
                      <ColorBadge color={colorHint(r)} size="xs" />
                      <span className="font-mono text-xs text-text-muted">
                        {r.eco}
                      </span>
                      <span className="truncate flex-1">{r.name}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div>
            <div className="text-xs uppercase tracking-wide text-text-muted mb-1">
              Families ({filteredFamilies.length})
            </div>
            <ul className="max-h-[60vh] overflow-auto divide-y divide-border scrollable pr-2">
              {filteredFamilies.map((f) => (
                <li key={f.family}>
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedFamily(f.family);
                      setSelectedLine(null);
                      setPly(0);
                    }}
                    className={`w-full flex items-center gap-2 py-1 text-sm text-left hover:text-accent ${
                      selectedFamily === f.family ? 'text-accent' : ''
                    }`}
                  >
                    <ColorBadge color={f.color} size="xs" />
                    <span className="truncate flex-1">{f.family}</span>
                    <span className="text-xs text-text-muted font-mono shrink-0">
                      {f.count}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </aside>

        <section className="space-y-3 min-w-0">
          {selectedLine ? (
            <LinePreview
              line={selectedLine}
              fens={fens}
              sans={sans}
              currentFen={currentFen}
              lastUci={lastUci}
              ply={ply}
              onPly={setPly}
            />
          ) : selectedFamily ? (
            <VariationsList
              family={selectedFamily}
              variations={variations}
              onPick={pickLine}
            />
          ) : (
            <div className="card p-8 text-sm text-text-muted text-center">
              Pick a family on the left, or search by name / ECO.
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function VariationsList({
  family,
  variations,
  onPick,
}: {
  family: string;
  variations: VariationEntry[];
  onPick: (line: OpeningLine) => void;
}) {
  const color = familyColor(family);
  return (
    <div className="card p-3 space-y-3">
      <div className="flex items-baseline justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <ColorBadge color={color} />
          <h2 className="text-lg font-medium truncate">{family}</h2>
        </div>
        <div className="text-xs text-text-muted shrink-0">
          {variations.length} line{variations.length === 1 ? '' : 's'}
        </div>
      </div>
      <div className="text-sm text-text-muted">
        {color === 'white'
          ? 'You play this opening with the White pieces. Pick a variation below to see how the line continues, then add it to your White repertoire.'
          : 'You play this defense with the Black pieces — White starts, and you respond. Pick a variation below to see how it goes, then add it to your Black repertoire.'}
      </div>
      <div className="flex justify-between items-center gap-2 flex-wrap">
        <div className="text-xs text-text-muted">
          Click a variation to preview, or seed a repertoire with every line
          below in one click.
        </div>
        <AddFamilyButton family={family} defaultColor={color} />
      </div>
      <ul className="divide-y divide-border max-h-[70vh] overflow-auto scrollable pr-2">
        {variations.map((v) => (
          <li key={v.name}>
            <button
              type="button"
              onClick={() => onPick(v)}
              className="w-full py-2 flex items-baseline gap-3 text-left hover:text-accent"
            >
              <span className="font-mono text-xs text-text-muted w-10 shrink-0">
                {v.eco}
              </span>
              <span className="flex-1 truncate">
                {v.variation || <em className="text-text-muted">Main line</em>}
              </span>
              <span className="text-xs text-text-muted shrink-0">
                {v.plies} ply
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ColorFilterButton({
  label,
  active,
  onClick,
  color,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  color?: Color;
}) {
  const dot = color === 'white' ? 'bg-white' : color === 'black' ? 'bg-black border border-text/40' : '';
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-1 px-2 py-1 rounded-md border ${
        active
          ? 'bg-accent/20 border-accent/50 text-accent'
          : 'border-border text-text-muted hover:text-text'
      }`}
    >
      {dot && <span className={`inline-block w-2 h-2 rounded-full ${dot}`} />}
      {label}
    </button>
  );
}

function LinePreview({
  line,
  fens,
  sans,
  currentFen,
  lastUci,
  ply,
  onPly,
}: {
  line: OpeningLine;
  fens: string[];
  sans: string[];
  currentFen: string;
  lastUci?: string;
  ply: number;
  onPly: (ply: number) => void;
}) {
  const hint = colorHint(line);

  return (
    <div className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_320px] gap-3 items-start">
      <div className="space-y-2">
        <div
          className={`flex items-center gap-2 px-3 py-2 rounded-md border ${
            hint === 'white'
              ? 'bg-white/5 border-white/30'
              : 'bg-black/30 border-black/60'
          }`}
        >
          <ColorBadge color={hint} />
          <div className="text-sm">
            {hint === 'white'
              ? 'You are White. You play this opening to attack with these moves.'
              : "You are Black. White starts; you respond with this defense."}
          </div>
        </div>
        <Board
          fen={currentFen}
          orientation={hint}
          lastMoveUci={lastUci}
          viewOnly
        />
        <div className="flex items-center gap-1 text-sm">
          <button className="btn" onClick={() => onPly(0)}>⏮</button>
          <button className="btn" onClick={() => onPly(Math.max(0, ply - 1))}>◀</button>
          <button
            className="btn"
            onClick={() => onPly(Math.min(fens.length - 1, ply + 1))}
          >
            ▶
          </button>
          <button className="btn" onClick={() => onPly(fens.length - 1)}>⏭</button>
          <div className="ml-auto text-text-muted text-xs">
            Ply {ply}/{fens.length - 1}
          </div>
        </div>
      </div>

      <aside className="space-y-3">
        <div className="card p-3 space-y-1">
          <div className="text-xs uppercase tracking-wide text-text-muted flex justify-between items-center">
            <span className="truncate">{line.family}</span>
            <span className="font-mono">{line.eco}</span>
          </div>
          <div className="text-sm">
            {line.variation || <em className="text-text-muted">Main line</em>}
          </div>
        </div>

        <MoveListPreview sans={sans} currentPly={ply} onPly={onPly} />

        <AddToRepertoirePanel line={line} defaultColor={hint} />
      </aside>
    </div>
  );
}

function MoveListPreview({
  sans,
  currentPly,
  onPly,
}: {
  sans: string[];
  currentPly: number;
  onPly: (ply: number) => void;
}) {
  return (
    <div className="card p-3 space-y-1">
      <div className="text-xs uppercase tracking-wide text-text-muted">Moves</div>
      <div className="flex flex-wrap gap-x-2 gap-y-0.5 font-mono text-sm">
        {sans.map((san, i) => {
          const moveNumber = Math.floor(i / 2) + 1;
          const isWhite = i % 2 === 0;
          return (
            <span key={i}>
              {isWhite && (
                <span className="text-text-muted mr-0.5">{moveNumber}.</span>
              )}
              <button
                type="button"
                onClick={() => onPly(i + 1)}
                className={`hover:text-accent ${
                  currentPly === i + 1 ? 'text-accent' : ''
                }`}
              >
                {san}
              </button>
            </span>
          );
        })}
      </div>
    </div>
  );
}

function AddToRepertoirePanel({
  line,
  defaultColor,
}: {
  line: OpeningLine;
  defaultColor: Color;
}) {
  // The colour is intrinsic to the line — a Sicilian Defense is always
  // Black's prep, so we don't let the user "add it as White". This removes
  // a whole category of beginner confusion.
  const color = defaultColor;
  const [selectedId, setSelectedId] = useState<string>('');
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reps = useLiveQuery(
    () => db.repertoires.where('color').equals(color).toArray(),
    [color],
  );

  const effectiveId =
    selectedId || (reps && reps.length > 0 ? reps[0].id : '');

  async function handleAdd() {
    if (busy) return;
    setBusy(true);
    setStatus(null);
    try {
      let repId = effectiveId;
      if (!repId) {
        const name =
          color === 'white' ? 'My White Repertoire' : 'My Black Repertoire';
        const created = await createRepertoire({ name, color });
        repId = created.id;
      }
      const added = await addLineToRepertoire(repId, line);
      setStatus(
        added > 0
          ? `Added ${added} new move${added === 1 ? '' : 's'}.`
          : 'Nothing new — line already in that repertoire.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card p-3 space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-xs uppercase tracking-wide text-text-muted">
          Add to repertoire
        </div>
        <ColorBadge color={color} size="xs" />
      </div>
      <select
        className="input"
        value={effectiveId}
        onChange={(e) => setSelectedId(e.target.value)}
      >
        {reps && reps.length > 0 ? (
          reps.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))
        ) : (
          <option value="">
            (create "My {color === 'white' ? 'White' : 'Black'} Repertoire")
          </option>
        )}
      </select>
      <button
        type="button"
        className="btn-primary w-full"
        onClick={handleAdd}
        disabled={busy}
      >
        {busy ? 'Adding…' : `Add line to ${color === 'white' ? 'White' : 'Black'} repertoire`}
      </button>
      {status && <div className="text-xs text-text-muted">{status}</div>}
    </div>
  );
}

function AddFamilyButton({
  family,
  defaultColor = 'white',
}: {
  family: string;
  defaultColor?: Color;
}) {
  const [open, setOpen] = useState(false);
  const color = defaultColor;
  const [selectedId, setSelectedId] = useState<string>('');
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const reps = useLiveQuery(
    () => db.repertoires.where('color').equals(color).toArray(),
    [color],
  );

  async function handleBulkAdd() {
    let repId = selectedId || (reps && reps.length > 0 ? reps[0].id : '');
    if (!repId) {
      const name =
        color === 'white' ? 'My White Repertoire' : 'My Black Repertoire';
      const created = await createRepertoire({ name, color });
      repId = created.id;
    }
    setMsg(null);
    const total = await addFamilyToRepertoire(repId, family, (done, total) => {
      setProgress({ done, total });
    });
    setProgress(null);
    setMsg(`Added ${total} new moves across the family.`);
  }

  if (!open) {
    return (
      <button type="button" className="btn text-xs" onClick={() => setOpen(true)}>
        Add whole family to {color === 'white' ? 'White' : 'Black'} repertoire…
      </button>
    );
  }

  return (
    <div className="w-full mt-2 p-2 rounded border border-border bg-bg-raised/30 space-y-2 text-sm">
      <div className="flex items-center gap-2">
        <ColorBadge color={color} size="xs" />
        <select
          className="input flex-1"
          value={selectedId}
          onChange={(e) => setSelectedId(e.target.value)}
        >
          {reps && reps.length > 0 ? (
            reps.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))
          ) : (
            <option value="">
              (create "My {color === 'white' ? 'White' : 'Black'} Repertoire")
            </option>
          )}
        </select>
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          className="btn-primary text-xs flex-1"
          onClick={handleBulkAdd}
          disabled={progress !== null}
        >
          {progress
            ? `Adding ${progress.done}/${progress.total}…`
            : `Add all lines of "${family}"`}
        </button>
        <button type="button" className="btn text-xs" onClick={() => setOpen(false)}>
          Close
        </button>
      </div>
      {msg && <div className="text-xs text-text-muted">{msg}</div>}
    </div>
  );
}
