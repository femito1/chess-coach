import { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Chess } from 'chess.js';
import {
  db,
  getSettings,
  updateSettings,
  type Motif,
  type Puzzle,
  type TimeClassFilter,
} from '@/db/schema';
import { Board } from '@/components/Board';
import { regeneratePuzzles } from './generate';
import { gradeSrs, isDue, newSrsState, summarizeIntervals, type Grade } from '@/srs/sm2';
import { MOTIF_LABEL, MOTIF_ORDER } from '@/engine/motifs';
import { TimeClassFilterSelect } from '@/components/TimeClassFilter';

type Filter = 'due' | 'all' | 'unsolved';

export function PuzzlesPage() {
  const puzzles = useLiveQuery(() => db.puzzles.toArray(), []);
  const [filter, setFilter] = useState<Filter>('due');
  const [motifFilter, setMotifFilter] = useState<Motif | 'all'>('all');
  const [timeClassFilter, setTimeClassFilter] = useState<TimeClassFilter>('rapid');
  const [generating, setGenerating] = useState(false);
  const [generateMsg, setGenerateMsg] = useState<string | null>(null);

  useEffect(() => {
    void getSettings().then((s) => {
      if (s.timeClassFilter) setTimeClassFilter(s.timeClassFilter);
    });
  }, []);

  useEffect(() => {
    // Generate puzzles on first visit if none exist, so the page
    // isn't empty for users who analyzed games before this feature.
    void (async () => {
      if (!puzzles || puzzles.length > 0) return;
      const s = await getSettings();
      setGenerating(true);
      const n = await regeneratePuzzles(s.puzzleMinSwingCp ?? 200);
      setGenerateMsg(n === 0 ? 'No puzzle-worthy mistakes found yet.' : `Generated ${n} puzzles.`);
      setGenerating(false);
    })();
  }, [puzzles]);

  const filtered = useMemo(() => {
    if (!puzzles) return [];
    let list = puzzles;
    if (timeClassFilter !== 'all') {
      list = list.filter((p) => p.timeClass === timeClassFilter);
    }
    if (filter === 'due') list = list.filter((p) => isDue(p.srs));
    else if (filter === 'unsolved') list = list.filter((p) => !p.srs || p.srs.reps === 0);
    if (motifFilter !== 'all') list = list.filter((p) => p.motifs.includes(motifFilter));
    return [...list].sort((a, b) => (a.srs?.dueAt ?? 0) - (b.srs?.dueAt ?? 0));
  }, [puzzles, filter, motifFilter, timeClassFilter]);

  const availableMotifs = useMemo(() => {
    if (!puzzles) return [];
    // Only count motifs on puzzles that survive the time-class filter,
    // otherwise the dropdown lists motifs that produce zero results.
    const scoped =
      timeClassFilter === 'all'
        ? puzzles
        : puzzles.filter((p) => p.timeClass === timeClassFilter);
    const set = new Set<Motif>();
    for (const p of scoped) for (const m of p.motifs) set.add(m);
    return MOTIF_ORDER.filter((m) => set.has(m));
  }, [puzzles, timeClassFilter]);

  const [currentIdx, setCurrentIdx] = useState(0);
  useEffect(() => {
    setCurrentIdx(0);
  }, [filter, motifFilter, timeClassFilter]);

  function onTimeClassChange(next: TimeClassFilter) {
    setTimeClassFilter(next);
    void updateSettings({ timeClassFilter: next });
  }

  const current = filtered[currentIdx];

  async function onGenerate() {
    setGenerating(true);
    setGenerateMsg(null);
    const s = await getSettings();
    const n = await regeneratePuzzles(s.puzzleMinSwingCp ?? 200);
    setGenerateMsg(
      n === 0 ? 'No new puzzles; all candidates already exist.' : `Added ${n} new puzzles.`,
    );
    setGenerating(false);
  }

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Puzzles</h1>
          <p className="text-sm text-text-muted">
            Generated from your own blunders, mistakes, and misses. Solve them, space them out.
          </p>
        </div>
        <div className="flex gap-2">
          <button type="button" className="btn" onClick={onGenerate} disabled={generating}>
            {generating ? 'Generating…' : 'Regenerate'}
          </button>
        </div>
      </div>

      {generateMsg && <div className="text-xs text-text-muted">{generateMsg}</div>}

      <div className="card p-3 flex flex-wrap gap-2 text-sm">
        <TimeClassFilterSelect
          value={timeClassFilter}
          onChange={onTimeClassChange}
          available={puzzles ?? []}
        />
        <select
          className="input w-auto"
          value={filter}
          onChange={(e) => setFilter(e.target.value as Filter)}
        >
          <option value="due">Due now</option>
          <option value="unsolved">Never solved</option>
          <option value="all">All</option>
        </select>
        <select
          className="input w-auto"
          value={motifFilter}
          onChange={(e) => setMotifFilter(e.target.value as Motif | 'all')}
        >
          <option value="all">All motifs</option>
          {availableMotifs.map((m) => (
            <option key={m} value={m}>
              {MOTIF_LABEL[m]}
            </option>
          ))}
        </select>
        <div className="ml-auto text-text-muted self-center">
          {filtered.length} puzzle{filtered.length === 1 ? '' : 's'}
        </div>
      </div>

      {current ? (
        <PuzzleSolver
          puzzle={current}
          onGraded={() => {
            if (currentIdx + 1 < filtered.length) setCurrentIdx(currentIdx + 1);
          }}
          hasNext={currentIdx + 1 < filtered.length}
        />
      ) : (
        <div className="card p-8 text-center text-text-muted">
          {puzzles && puzzles.length > 0
            ? 'Nothing due. Check back later or switch to "All".'
            : 'No puzzles yet. Import and analyze some games first.'}
        </div>
      )}
    </div>
  );
}

function PuzzleSolver({
  puzzle,
  onGraded,
  hasNext,
}: {
  puzzle: Puzzle;
  onGraded: () => void;
  hasNext: boolean;
}) {
  const [fen, setFen] = useState(puzzle.fen);
  const [solvedIdx, setSolvedIdx] = useState(0);
  const [status, setStatus] = useState<'solving' | 'wrong' | 'solved'>('solving');
  const [attempts, setAttempts] = useState(0);
  const [showSolution, setShowSolution] = useState(false);
  const [lastUci, setLastUci] = useState<string | undefined>(undefined);

  useEffect(() => {
    setFen(puzzle.fen);
    setSolvedIdx(0);
    setStatus('solving');
    setAttempts(0);
    setShowSolution(false);
    setLastUci(undefined);
  }, [puzzle.id]);

  const solverColor = puzzle.fen.split(' ')[1] === 'w' ? 'white' : 'black';

  function onMove(m: { from: string; to: string; promotion?: string }): boolean {
    if (status !== 'solving') return false;
    const expected = puzzle.solutionUci[solvedIdx];
    if (!expected) return false;
    const uci = m.from + m.to + (m.promotion ?? '');
    const expectedNoProm = expected.slice(0, 4);
    const match = uci.slice(0, 4) === expectedNoProm;
    if (!match) {
      setAttempts((n) => n + 1);
      setStatus('wrong');
      return false;
    }
    const c = new Chess();
    try {
      c.load(fen);
      c.move({ from: m.from, to: m.to, promotion: m.promotion });
    } catch {
      return false;
    }
    const nextIdx = solvedIdx + 1;
    setLastUci(uci);
    // Auto-play opponent reply if present.
    if (nextIdx < puzzle.solutionUci.length) {
      const reply = puzzle.solutionUci[nextIdx];
      try {
        c.move({
          from: reply.slice(0, 2),
          to: reply.slice(2, 4),
          promotion: reply.slice(4, 5) || undefined,
        });
        setFen(c.fen());
        setLastUci(reply);
        setSolvedIdx(nextIdx + 1);
      } catch {
        setFen(c.fen());
        setSolvedIdx(nextIdx);
      }
    } else {
      setFen(c.fen());
      setSolvedIdx(nextIdx);
    }
    if (nextIdx + 1 >= puzzle.solutionUci.length || nextIdx >= puzzle.solutionUci.length - 1) {
      // Done when the user has made their final move of the line.
      if (nextIdx >= puzzle.solutionUci.length || nextIdx === puzzle.solutionUci.length - 1) {
        // If the solution ends with the user's move (odd length), solved.
        // Otherwise we've just played an opponent reply above.
      }
    }
    if (nextIdx >= puzzle.solutionUci.length) {
      setStatus('solved');
    } else if (nextIdx + 1 === puzzle.solutionUci.length && puzzle.solutionUci.length % 2 === 1) {
      // Solver just played the last move of an odd-length line.
      setStatus('solved');
    }
    return true;
  }

  async function grade(grade: Grade) {
    const newState = gradeSrs(puzzle.srs ?? newSrsState(), grade);
    await db.puzzles.update(puzzle.id, { srs: newState });
    if (hasNext) onGraded();
  }

  function retry() {
    setFen(puzzle.fen);
    setSolvedIdx(0);
    setStatus('solving');
    setLastUci(undefined);
  }

  function revealAndFail() {
    setShowSolution(true);
    setStatus('wrong');
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_340px] gap-4 items-start">
      <div className="space-y-3">
        <Board
          fen={fen}
          orientation={solverColor}
          lastMoveUci={lastUci}
          viewOnly={status === 'solved' || status === 'wrong'}
          onMove={(m) => onMove(m)}
        />
        <div className="flex items-center justify-between">
          <div className="text-sm">
            {status === 'solving' && (
              <span className="text-text-muted">
                {solverColor === 'white' ? 'White' : 'Black'} to move. Find the best line.
                {attempts > 0 && <span className="text-blunder"> · {attempts} wrong so far</span>}
              </span>
            )}
            {status === 'wrong' && (
              <span className="text-blunder">
                Not quite. {showSolution ? 'Full solution shown on the right.' : 'Try again or reveal.'}
              </span>
            )}
            {status === 'solved' && <span className="text-good">Solved!</span>}
          </div>
          <div className="flex gap-1">
            {status === 'wrong' && !showSolution && (
              <>
                <button type="button" className="btn text-xs" onClick={retry}>
                  Retry
                </button>
                <button type="button" className="btn text-xs" onClick={revealAndFail}>
                  Reveal
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      <aside className="space-y-3">
        <div className="card p-3 space-y-2 text-sm">
          <div className="flex justify-between items-baseline">
            <div className="text-xs uppercase tracking-wide text-text-muted">Source</div>
            <div className="text-xs text-text-muted">swing {(puzzle.swingCp / 100).toFixed(1)}</div>
          </div>
          <div>
            vs <span className="font-medium">{puzzle.opponent}</span>
          </div>
          <div className="flex flex-wrap gap-1">
            {puzzle.motifs.map((m) => (
              <span
                key={m}
                className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-bg-raised text-text-muted"
              >
                {MOTIF_LABEL[m]}
              </span>
            ))}
          </div>
          <div className="text-xs text-text-muted">
            {puzzle.srs
              ? `Due every ${summarizeIntervals(puzzle.srs.intervalDays)}, ease ${puzzle.srs.ease.toFixed(2)}, ${puzzle.srs.lapses} lapses`
              : 'Never reviewed.'}
          </div>
        </div>

        {(status === 'solved' || showSolution) && (
          <div className="card p-3 space-y-1 text-sm">
            <div className="text-xs uppercase tracking-wide text-text-muted">Solution</div>
            <div className="font-mono text-text">
              {puzzle.solutionSan.map((s, i) => (
                <span
                  key={i}
                  className={i % 2 === 0 ? 'text-good' : 'text-text-muted'}
                >
                  {s}
                  {i < puzzle.solutionSan.length - 1 ? ' ' : ''}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* SRS grading is only meaningful when the user finished the
            puzzle's solution. Showing it after a wrong move would just
            tempt the user to grade themselves "Easy" on a missed puzzle.
            "Reveal" still routes through the wrong-state path, so on
            reveal we surface a single "Mark again" button below for
            scheduling, without offering Hard/Good/Easy. */}
        {status === 'solved' && (
          <div className="card p-3 space-y-2">
            <div className="text-xs uppercase tracking-wide text-text-muted">How well did you know it?</div>
            <div className="grid grid-cols-2 gap-2">
              <GradeButton label="Again" grade="again" onGrade={grade} tone="bad" />
              <GradeButton label="Hard" grade="hard" onGrade={grade} />
              <GradeButton label="Good" grade="good" onGrade={grade} />
              <GradeButton label="Easy" grade="easy" onGrade={grade} tone="good" />
            </div>
          </div>
        )}
        {status === 'wrong' && showSolution && (
          <div className="card p-3 space-y-2">
            <div className="text-xs uppercase tracking-wide text-text-muted">
              Lapse logged
            </div>
            <div className="text-xs text-text-muted">
              You revealed the answer, so this puzzle gets re-queued for
              another go soon.
            </div>
            <button
              type="button"
              className="btn border-blunder/40 text-blunder hover:bg-blunder/10 w-full"
              onClick={() => grade('again')}
            >
              Schedule again
            </button>
          </div>
        )}
      </aside>
    </div>
  );
}

function GradeButton({
  label,
  grade,
  onGrade,
  tone,
}: {
  label: string;
  grade: Grade;
  onGrade: (g: Grade) => void;
  tone?: 'good' | 'bad';
}) {
  const cls =
    tone === 'good'
      ? 'border-good/40 text-good hover:bg-good/10'
      : tone === 'bad'
        ? 'border-blunder/40 text-blunder hover:bg-blunder/10'
        : '';
  return (
    <button type="button" onClick={() => onGrade(grade)} className={`btn ${cls}`}>
      {label}
    </button>
  );
}
