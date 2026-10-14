import { describe, expect, it } from 'vitest';
import { Chess } from 'chess.js';
import type { RepertoireNode } from '@/db/schema';
import { OPENING_LINES } from '@/data/openings.generated';
import { isLibraryLinePrefix } from '@/features/openings/library';
import {
  edgeMove,
  enumerateLinesFromNodes,
  fenKey,
  movesFrom,
  planAddMove,
  reachedPaths,
} from './lineTree';

const START = new Chess().fen();
const REP = 'r';
const id = (fen: string) => `${REP}:${fenKey(fen)}`;

type Graph = Map<string, RepertoireNode>;

function newGraph(recordPaths = true): Graph {
  const g: Graph = new Map();
  g.set(id(START), {
    id: id(START),
    repertoireId: REP,
    fen: START,
    childFens: [],
    ...(recordPaths ? { paths: [''] } : {}),
    createdAt: 0,
  });
  return g;
}

/** What `store.addLineToRepertoire` → `addMove` writes, minus Dexie. */
function addLine(g: Graph, sans: string[]): void {
  const c = new Chess();
  const path: string[] = [];
  for (const san of sans) {
    const parentFen = c.fen();
    const mv = c.move(san);
    const uci = mv.lan;
    const writes = planAddMove({
      repertoireId: REP,
      parentId: id(parentFen),
      childId: id(c.fen()),
      parentFen,
      childFen: c.fen(),
      uci,
      san: mv.san,
      parentPathKey: path.join(' '),
      now: 0,
      parent: g.get(id(parentFen)),
      child: g.get(id(c.fen())),
    });
    for (const w of writes) g.set(w.id, w);
    path.push(uci);
  }
}

/** The pre-fix `addMove`: no `paths`, and `childFens` deduped by the FULL
 *  FEN, so a second move order lists a shared child again under its own
 *  counters. This is the shape of every repertoire already stored. */
function addLineLegacy(g: Graph, uciLine: readonly string[]): void {
  const c = new Chess();
  for (const uci of uciLine) {
    const parentFen = c.fen();
    const mv = c.move(uci);
    const childFen = c.fen();
    const parent = g.get(id(parentFen))!;
    if (!parent.childFens.includes(childFen)) {
      parent.childFens.push(childFen);
      parent.mainChildFen ??= childFen;
    }
    if (!g.has(id(childFen))) {
      g.set(id(childFen), {
        id: id(childFen),
        repertoireId: REP,
        fen: childFen,
        parentFen,
        moveUci: uci,
        moveSan: mv.san,
        childFens: [],
        createdAt: 0,
      });
    }
  }
}

const noBook = () => false;
const lines = (g: Graph, book: (k: string) => boolean = noBook) =>
  enumerateLinesFromNodes([...g.values()], START, book);
const sans = (g: Graph, book?: (k: string) => boolean) =>
  lines(g, book).map((l) => l.san.join(' '));

const ITALIAN = ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4'];
const KNIGHT_FIRST_RUY = ['Nf3', 'Nc6', 'e4', 'e5', 'Bb5'];

describe('enumerateLinesFromNodes :: transpositions', () => {
  it('drills each move order with its own moves and its own continuation', () => {
    // The reviewer's repro: the second order reaches 1.e4 e5 2.Nf3 Nc6 with
    // other move counters (halfmove 0 vs 2). A full-FEN lookup dropped the
    // whole second line; following every edge of the shared node would
    // cross them into four lines.
    const g = newGraph();
    addLine(g, ITALIAN);
    addLine(g, KNIGHT_FIRST_RUY);
    expect(sans(g).sort()).toEqual(['Nf3 Nc6 e4 e5 Bb5', 'e4 e5 Nf3 Nc6 Bc4']);
  });

  it('crosses move orders only when the user added both', () => {
    const g = newGraph();
    addLine(g, ITALIAN);
    addLine(g, KNIGHT_FIRST_RUY);
    addLine(g, ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5']);
    expect(sans(g).sort()).toEqual([
      'Nf3 Nc6 e4 e5 Bb5',
      'e4 e5 Nf3 Nc6 Bb5',
      'e4 e5 Nf3 Nc6 Bc4',
    ]);
  });

  it('ends a move order at the shared position when only the other one continues', () => {
    const g = newGraph();
    addLine(g, ITALIAN);
    addLine(g, ['Nf3', 'Nc6', 'e4', 'e5']);
    expect(sans(g).sort()).toEqual(['Nf3 Nc6 e4 e5', 'e4 e5 Nf3 Nc6 Bc4']);
  });

  it("carries each line's own FENs, counters included", () => {
    const g = newGraph();
    addLine(g, ITALIAN);
    addLine(g, KNIGHT_FIRST_RUY);
    for (const line of lines(g)) {
      const c = new Chess();
      expect(line.fens[0]).toBe(START);
      line.uci.forEach((u, i) => {
        c.move(u);
        expect(line.fens[i + 1]).toBe(c.fen());
      });
    }
  });

  it('bulk-adding a transposition-heavy family drills exactly the lines added', () => {
    // QGD: 171 library lines; before the fix 64 of them could not be drilled.
    const family = OPENING_LINES.filter((l) => l.family === "Queen's Gambit Declined");
    const g = newGraph();
    for (const l of family) addLine(g, sanList(l.uci));
    const keys = family.map((l) => l.uci.join(' '));
    const maximal = keys.filter((k) => !keys.some((o) => o.startsWith(`${k} `)));
    const got = lines(g).map((l) => l.uci.join(' '));
    expect(new Set(got)).toEqual(new Set(maximal));
  });
});

function sanList(uci: readonly string[]): string[] {
  const c = new Chess();
  return uci.map((u) => c.move(u).san);
}

describe('enumerateLinesFromNodes :: rows written before move orders were recorded', () => {
  it('heals the repro: a book move order is followed through the shared position', () => {
    const g = newGraph(false);
    addLineLegacy(g, ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4']);
    addLineLegacy(g, ['g1f3', 'b8c6', 'e2e4', 'e7e5', 'f1b5']);
    const book = new Set([
      'g1f3', 'g1f3 b8c6', 'g1f3 b8c6 e2e4', 'g1f3 b8c6 e2e4 e7e5',
      'g1f3 b8c6 e2e4 e7e5 f1b5',
    ]);
    expect(sans(g, (k) => book.has(k)).sort()).toEqual([
      'Nf3 Nc6 e4 e5 Bb5',
      'e4 e5 Nf3 Nc6 Bc4',
    ]);
  });

  it('stops before the shared position rather than splice in a move order it cannot verify', () => {
    const g = newGraph(false);
    addLineLegacy(g, ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4']);
    addLineLegacy(g, ['g1f3', 'b8c6', 'e2e4', 'e7e5', 'f1b5']);
    // The old walk emitted "Nf3 Nc6 e4 Nc6 Bc4"-style splices here (the
    // shared node's first-order move); none of these may contain one.
    expect(sans(g).sort()).toEqual(['Nf3 Nc6 e4', 'e4 e5 Nf3 Nc6 Bc4']);
  });

  it('leaves every bulk-added library line drillable, and the upgrade keeps them', () => {
    const family = OPENING_LINES.filter((l) => l.family === "Queen's Gambit Declined");
    const g = newGraph(false);
    for (const l of family) addLineLegacy(g, l.uci);
    const before = lines(g, isLibraryLinePrefix).map((l) => l.uci.join(' '));
    for (const l of family) {
      const k = l.uci.join(' ');
      expect(before.some((o) => o === k || o.startsWith(`${k} `)), k).toBe(true);
    }

    // `store.upgradeLegacyPaths`: record what the fallback reached, after
    // which the exact rule must show precisely the same lines.
    const reached = reachedPaths([...g.values()], START, isLibraryLinePrefix);
    for (const [nid, paths] of reached) g.set(nid, { ...g.get(nid)!, paths });
    const after = lines(g, noBook).map((l) => l.uci.join(' '));
    expect(new Set(after)).toEqual(new Set(before));
  });
});

describe('edgeMove / movesFrom', () => {
  it('re-derives the move along a transposed edge instead of using the stored one', () => {
    const g = newGraph();
    addLine(g, ITALIAN);
    addLine(g, KNIGHT_FIRST_RUY);
    const c = new Chess();
    for (const m of ['Nf3', 'Nc6', 'e4']) c.move(m);
    const before = g.get(id(c.fen()))!;
    c.move('e5');
    const shared = g.get(id(c.fen()))!;
    // Stored move is the Italian order's last move into it: 2...Nc6.
    expect(shared.moveSan).toBe('Nc6');
    expect(edgeMove(before.fen, shared)).toMatchObject({ uci: 'e7e5', san: 'e5', fen: c.fen() });
    const byKey = new Map([...g.values()].map((n) => [fenKey(n.fen), n]));
    expect(movesFrom(before, byKey)).toEqual(['e7e5']);
    expect(movesFrom(shared, byKey).sort()).toEqual(['f1b5', 'f1c4']);
  });
});

describe('planAddMove', () => {
  it('lists a transposed child once, by key, and records the new move order on it', () => {
    const g = newGraph();
    addLine(g, ['d4', 'd5', 'c4', 'e6']);
    addLine(g, ['c4', 'e6', 'd4', 'd5']);
    const c = new Chess();
    for (const m of ['d4', 'd5', 'c4', 'e6']) c.move(m);
    const shared = g.get(id(c.fen()))!;
    expect(shared.paths).toEqual(['d2d4 d7d5 c2c4 e7e6', 'c2c4 e7e6 d2d4 d7d5']);
    for (const n of g.values()) {
      const keys = n.childFens.map(fenKey);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  it('without a known move order, adds the move under every recorded one', () => {
    const g = newGraph();
    addLine(g, ITALIAN.slice(0, 4));
    addLine(g, KNIGHT_FIRST_RUY.slice(0, 4));
    const c = new Chess();
    for (const m of ITALIAN.slice(0, 4)) c.move(m);
    const parentFen = c.fen();
    const shared = g.get(id(parentFen))!;
    const mv = c.move('Bb5');
    for (const w of planAddMove({
      repertoireId: REP,
      parentId: shared.id,
      childId: id(c.fen()),
      parentFen,
      childFen: c.fen(),
      uci: mv.lan,
      san: mv.san,
      now: 0,
      parent: shared,
    })) g.set(w.id, w);
    expect(sans(g).sort()).toEqual(['Nf3 Nc6 e4 e5 Bb5', 'e4 e5 Nf3 Nc6 Bb5']);
  });
});
