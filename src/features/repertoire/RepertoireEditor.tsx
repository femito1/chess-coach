import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { Chess } from 'chess.js';
import { db, type RepertoireNode } from '@/db/schema';
import { Board } from '@/components/Board';
import {
  addMove,
  childrenOf,
  deleteNode,
  importPgn,
  nodeId,
  setNoteOnNode,
} from './store';
import { analyzeGaps } from './gaps';
import {
  addFamilyToRepertoire,
  addLineToRepertoire,
  colorHint,
  familyColor,
  searchOpenings,
  type VariationEntry,
} from '@/features/openings/library';
import { ColorBadge } from '@/features/openings/ColorBadge';
import type { Color } from '@/db/schema';

export function RepertoireEditor() {
  const { id } = useParams<{ id: string }>();
  const repertoire = useLiveQuery(() => (id ? db.repertoires.get(id) : undefined), [id]);
  const rootFen = useMemo(() => new Chess().fen(), []);
  const [currentFen, setCurrentFen] = useState(rootFen);
  const [pathFens, setPathFens] = useState<string[]>([rootFen]);
  const [children, setChildren] = useState<RepertoireNode[]>([]);
  const [currentNode, setCurrentNode] = useState<RepertoireNode | null>(null);
  const [pgnText, setPgnText] = useState('');
  const [pgnMsg, setPgnMsg] = useState<string | null>(null);
  const [note, setNote] = useState('');

  async function refresh(fen: string) {
    if (!id) return;
    const kids = await childrenOf(id, fen);
    setChildren(kids);
    const n = await db.repertoireNodes.get(nodeId(id, fen));
    setCurrentNode(n ?? null);
    setNote(n?.notes ?? '');
  }

  useEffect(() => {
    void refresh(currentFen);
  }, [id, currentFen]);

  function navigateToChild(node: RepertoireNode) {
    setCurrentFen(node.fen);
    setPathFens((prev) => [...prev, node.fen]);
  }

  function navigateBack() {
    setPathFens((prev) => {
      if (prev.length <= 1) return prev;
      const next = prev.slice(0, -1);
      setCurrentFen(next[next.length - 1]);
      return next;
    });
  }

  function navigateToRoot() {
    setPathFens([rootFen]);
    setCurrentFen(rootFen);
  }

  async function onBoardMove(m: { from: string; to: string; promotion?: string }) {
    if (!id) return;
    const uci = m.from + m.to + (m.promotion ?? '');
    const added = await addMove(id, currentFen, uci);
    if (added) {
      setCurrentFen(added.fen);
      setPathFens((prev) => [...prev, added.fen]);
    }
  }

  async function handleDelete(node: RepertoireNode) {
    if (!id) return;
    if (!confirm(`Delete this line (starting with ${node.moveSan ?? node.fen})?`)) return;
    await deleteNode(id, node.fen);
    await refresh(currentFen);
  }

  async function handleImportPgn() {
    if (!id || !pgnText.trim()) return;
    setPgnMsg('Importing…');
    const n = await importPgn(id, pgnText.trim());
    setPgnMsg(n === 0 ? 'No moves imported (bad PGN?)' : `Added ${n} moves.`);
    setPgnText('');
    await refresh(currentFen);
  }

  async function saveNote() {
    if (!id) return;
    await setNoteOnNode(id, currentFen, note);
  }

  if (!id) return <div>Missing id.</div>;
  if (repertoire === undefined) return <div className="text-text-muted">Loading…</div>;
  if (!repertoire) return <div className="text-text-muted">Repertoire not found.</div>;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <Link to="/repertoire" className="btn text-xs">← Back</Link>
        <div className="flex-1 min-w-0">
          <h1 className="text-lg font-semibold truncate flex items-center gap-2">
            {repertoire.name}
            <ColorBadge color={repertoire.color} size="xs" />
          </h1>
          <div className="text-xs text-text-muted">
            {pathFens.length - 1} plies deep
          </div>
        </div>
        <Link
          to={`/repertoire/${id}/lines`}
          className="btn text-xs"
          title="Play through full opening lines from move 1"
        >
          Play lines
        </Link>
        <Link
          to={`/repertoire/${id}/train`}
          className="btn-primary text-xs"
          title="Spaced-repetition card drills"
        >
          Card drill
        </Link>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_380px] gap-4 items-start">
        <div className="space-y-3">
          <Board
            fen={currentFen}
            orientation={repertoire.color}
            viewOnly={false}
            onMove={onBoardMove}
          />
          <div className="flex gap-2 text-xs">
            <button type="button" className="btn" onClick={navigateToRoot}>
              ⏮ Start
            </button>
            <button
              type="button"
              className="btn"
              onClick={navigateBack}
              disabled={pathFens.length <= 1}
            >
              ◀ Back
            </button>
            <div className="ml-auto self-center text-text-muted">
              Play a move on the board to add it to the repertoire.
            </div>
          </div>

          <div className="card p-3 space-y-2">
            <div className="text-xs uppercase tracking-wide text-text-muted">Notes</div>
            <textarea
              className="input min-h-[80px]"
              placeholder="Memory hooks for this position — plans, key ideas, traps."
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
            <div className="flex justify-end">
              <button type="button" className="btn text-xs" onClick={saveNote}>
                Save note
              </button>
            </div>
          </div>
        </div>

        <aside className="space-y-3">
          <div className="card p-3 space-y-2">
            <div className="text-xs uppercase tracking-wide text-text-muted">Lines from here</div>
            {children.length === 0 ? (
              <div className="text-sm text-text-muted">
                No moves yet from this position. Play one on the board.
              </div>
            ) : (
              <ul className="divide-y divide-border">
                {children.map((c) => (
                  <li key={c.id} className="py-1.5 flex items-center gap-2">
                    <button
                      type="button"
                      className="flex-1 text-left font-mono hover:text-accent"
                      onClick={() => navigateToChild(c)}
                    >
                      {c.moveSan ?? '(start)'}
                      {currentNode?.mainChildFen === c.fen && (
                        <span className="ml-1 text-[10px] text-accent">main</span>
                      )}
                    </button>
                    <button
                      type="button"
                      className="text-xs text-blunder hover:underline"
                      onClick={() => handleDelete(c)}
                    >
                      Delete
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="card p-3 space-y-2">
            <div className="text-xs uppercase tracking-wide text-text-muted">Import PGN</div>
            <textarea
              className="input min-h-[120px] font-mono text-xs"
              placeholder="Paste PGN lines here. Mainline only, for now."
              value={pgnText}
              onChange={(e) => setPgnText(e.target.value)}
            />
            <div className="flex justify-between items-center">
              <span className="text-xs text-text-muted">{pgnMsg}</span>
              <button
                type="button"
                className="btn text-xs"
                onClick={handleImportPgn}
                disabled={!pgnText.trim()}
              >
                Import
              </button>
            </div>
          </div>

          <LibraryPicker
            repertoireId={id}
            color={repertoire.color}
            onAdded={() => void refresh(currentFen)}
          />

          <GapsPanel repertoireId={id} rootFen={rootFen} color={repertoire.color} />
        </aside>
      </div>
    </div>
  );
}

function LibraryPicker({
  repertoireId,
  color,
  onAdded,
}: {
  repertoireId: string;
  color: Color;
  onAdded: () => void;
}) {
  const [query, setQuery] = useState('');
  const [showOtherColor, setShowOtherColor] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // Hide lines that belong to the OTHER side by default — adding a Sicilian
  // Defense to a White repertoire just buries useless cards in your queue.
  const allResults: VariationEntry[] = useMemo(
    () => (query.trim().length >= 2 ? searchOpenings(query, 60) : []),
    [query],
  );
  const results = useMemo(
    () =>
      showOtherColor
        ? allResults.slice(0, 20)
        : allResults.filter((r) => colorHint(r) === color).slice(0, 20),
    [allResults, color, showOtherColor],
  );
  const hiddenForColor = allResults.length - results.length;

  async function addLine(line: VariationEntry) {
    setBusy(line.name);
    setStatus(null);
    const added = await addLineToRepertoire(repertoireId, line);
    setBusy(null);
    setStatus(
      added > 0
        ? `Added ${added} move${added === 1 ? '' : 's'} from "${line.name}".`
        : `"${line.name}" is already in this repertoire.`,
    );
    onAdded();
  }

  async function addFamily(family: string) {
    setBusy(`family:${family}`);
    setStatus(null);
    const added = await addFamilyToRepertoire(repertoireId, family);
    setBusy(null);
    setStatus(
      added > 0
        ? `Added ${added} new move${added === 1 ? '' : 's'} from "${family}".`
        : `"${family}" family already covered.`,
    );
    onAdded();
  }

  // Collapse "show whole family" actions to one per unique family in the
  // result set, so a Najdorf search offers one bulk-add button.
  const families = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const r of results) {
      if (!seen.has(r.family)) {
        seen.add(r.family);
        out.push(r.family);
      }
    }
    return out;
  }, [results]);

  return (
    <div className="card p-3 space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-xs uppercase tracking-wide text-text-muted">
          Add from library
        </div>
        <ColorBadge color={color} size="xs" />
      </div>
      <input
        className="input"
        placeholder='Search 3,600+ lines (e.g. "Najdorf", "Caro-Kann", "B90")'
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {hiddenForColor > 0 && !showOtherColor && (
        <button
          type="button"
          onClick={() => setShowOtherColor(true)}
          className="text-xs text-text-muted hover:text-text underline-offset-2 hover:underline"
        >
          {hiddenForColor} more result{hiddenForColor === 1 ? '' : 's'} for the
          other side hidden — show anyway
        </button>
      )}
      {results.length > 0 && (
        <>
          {families.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {families.slice(0, 4).map((f) => {
                const fc = familyColor(f);
                const mismatch = fc !== color;
                return (
                  <button
                    key={f}
                    type="button"
                    className={`btn text-xs ${mismatch ? 'opacity-60' : ''}`}
                    disabled={busy === `family:${f}`}
                    onClick={() => void addFamily(f)}
                    title={
                      mismatch
                        ? `"${f}" is normally a ${fc === 'white' ? 'White' : 'Black'} opening — adding here will be off-color`
                        : undefined
                    }
                  >
                    {busy === `family:${f}` ? `Adding ${f}…` : `+ All "${f}"`}
                  </button>
                );
              })}
            </div>
          )}
          <ul className="max-h-56 overflow-auto divide-y divide-border">
            {results.map((r) => {
              const lc = colorHint(r);
              const mismatch = lc !== color;
              return (
                <li
                  key={r.name}
                  className="py-1.5 flex items-center gap-2 text-sm"
                >
                  <ColorBadge color={lc} size="xs" />
                  <span className="font-mono text-xs text-text-muted w-10 shrink-0">
                    {r.eco}
                  </span>
                  <span
                    className={`flex-1 min-w-0 truncate ${mismatch ? 'text-text-muted' : ''}`}
                    title={
                      mismatch
                        ? `"${r.name}" is a ${lc === 'white' ? 'White' : 'Black'} opening — heads-up before adding to your ${color} repertoire`
                        : undefined
                    }
                  >
                    {r.name}
                  </span>
                  <span className="text-xs text-text-muted shrink-0">
                    {r.plies}p
                  </span>
                  <button
                    type="button"
                    className="text-xs text-accent hover:underline shrink-0"
                    disabled={busy === r.name}
                    onClick={() => void addLine(r)}
                  >
                    {busy === r.name ? '…' : 'Add'}
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}
      {status && <div className="text-xs text-text-muted">{status}</div>}
    </div>
  );
}

function GapsPanel({
  repertoireId,
  rootFen,
  color,
}: {
  repertoireId: string;
  rootFen: string;
  color: 'white' | 'black';
}) {
  const gaps = useLiveQuery(async () => {
    return analyzeGaps({ repertoireId, rootFen, color });
  }, [repertoireId, rootFen, color]);

  if (!gaps) return null;

  return (
    <div className="card p-3 space-y-2">
      <div className="flex items-baseline justify-between">
        <div className="text-xs uppercase tracking-wide text-text-muted">Gap analysis</div>
        <div className="text-xs text-text-muted">{gaps.totalGames} analyzed games</div>
      </div>
      {gaps.lines.length === 0 ? (
        <div className="text-sm text-text-muted">
          Your games either all match your prep or you have no games imported for this color yet.
        </div>
      ) : (
        <ul className="divide-y divide-border text-sm max-h-72 overflow-auto">
          {gaps.lines.slice(0, 15).map((g, i) => (
            <li key={i} className="py-1.5 space-y-0.5">
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-mono truncate">{g.pathSan.join(' ')}</span>
                <span className="text-xs text-text-muted">×{g.frequency}</span>
              </div>
              <div className="text-xs text-text-muted truncate">
                Opponent's first off-book move: <span className="font-mono">{g.missingSan}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
