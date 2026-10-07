import { describe, expect, it } from 'vitest';
import type { RepertoireCard, RepertoireLineStats, RepertoireNode } from '@/db/schema';
import {
  mergeSnapshots,
  nextRev,
  planRepertoireSync,
  snapshotHash,
  type RemoteRepertoireMeta,
  type RepertoireSnapshot,
  type SyncBase,
} from './repertoireDiff';

const base = (id: string, rev: number, hash: string, deleted = false): SyncBase => ({
  repertoireId: id,
  rev,
  hash,
  deleted,
});
const remote = (id: string, rev: number, deleted = false): RemoteRepertoireMeta => ({
  repertoire_id: id,
  rev,
  deleted,
});
const plan = (
  local: Record<string, string>,
  bases: SyncBase[],
  rem: RemoteRepertoireMeta[],
) =>
  planRepertoireSync({
    localHashes: new Map(Object.entries(local)),
    bases: new Map(bases.map((b) => [b.repertoireId, b])),
    remote: rem,
  });

describe('planRepertoireSync — present locally', () => {
  it('a repertoire the cloud has never seen is inserted', () => {
    expect(plan({ r: 'h1' }, [], [])).toEqual([{ kind: 'push', id: 'r', expectRev: null }]);
  });

  it('agreed and untouched on both sides: nothing to do', () => {
    expect(plan({ r: 'h1' }, [base('r', 5, 'h1')], [remote('r', 5)])).toEqual([]);
  });

  it('changed here only: compare-and-swap push at the agreed rev', () => {
    expect(plan({ r: 'h2' }, [base('r', 5, 'h1')], [remote('r', 5)])).toEqual([
      { kind: 'push', id: 'r', expectRev: 5 },
    ]);
  });

  it('changed there only: pull, no merge needed', () => {
    expect(plan({ r: 'h1' }, [base('r', 5, 'h1')], [remote('r', 9)])).toEqual([
      { kind: 'pull', id: 'r' },
    ]);
  });

  it('deleted there, untouched here: delete locally', () => {
    expect(plan({ r: 'h1' }, [base('r', 5, 'h1')], [remote('r', 9, true)])).toEqual([
      { kind: 'deleteLocal', id: 'r', remoteRev: 9 },
    ]);
  });

  it('changed on both sides: merge', () => {
    expect(plan({ r: 'h2' }, [base('r', 5, 'h1')], [remote('r', 9)])).toEqual([
      { kind: 'merge', id: 'r' },
    ]);
  });

  /** Training is not recoverable; a deletion is cheap to repeat. */
  it('deleted there but trained here since: the training survives', () => {
    expect(plan({ r: 'h2' }, [base('r', 5, 'h1')], [remote('r', 9, true)])).toEqual([
      { kind: 'push', id: 'r', expectRev: 9 },
    ]);
  });

  /** A device that has local repertoires and has never synced them: both
   *  sides "changed" relative to a base that does not exist. */
  it('no base on either side but both have it: merge rather than overwrite', () => {
    expect(plan({ r: 'h1' }, [], [remote('r', 3)])).toEqual([{ kind: 'merge', id: 'r' }]);
  });

  it('pruned from the cloud out of band: the only copy goes back up', () => {
    expect(plan({ r: 'h1' }, [base('r', 5, 'h1')], [])).toEqual([
      { kind: 'push', id: 'r', expectRev: null },
    ]);
  });
});

describe('planRepertoireSync — absent locally', () => {
  it('a restore: the cloud copy comes down', () => {
    expect(plan({}, [], [remote('r', 4)])).toEqual([{ kind: 'pull', id: 'r' }]);
  });

  it('deleted here, cloud unmoved: push a tombstone, never a row delete', () => {
    expect(plan({}, [base('r', 5, 'h1')], [remote('r', 5)])).toEqual([
      { kind: 'pushTombstone', id: 'r', expectRev: 5 },
    ]);
  });

  it('deleted here but edited elsewhere since: the edit wins', () => {
    expect(plan({}, [base('r', 5, 'h1')], [remote('r', 9)])).toEqual([{ kind: 'pull', id: 'r' }]);
  });

  it('a tombstone this device has not recorded is adopted, not pulled', () => {
    expect(plan({}, [], [remote('r', 9, true)])).toEqual([
      { kind: 'adoptBase', id: 'r', base: base('r', 9, '', true) },
    ]);
  });

  it('a tombstone already recorded is left alone', () => {
    expect(plan({}, [base('r', 9, '', true)], [remote('r', 9, true)])).toEqual([]);
  });

  it('a tombstone resurrected elsewhere comes back', () => {
    expect(plan({}, [base('r', 9, '', true)], [remote('r', 12)])).toEqual([
      { kind: 'pull', id: 'r' },
    ]);
  });

  it('gone everywhere: the stale base is dropped', () => {
    expect(plan({}, [base('r', 5, 'h1')], [])).toEqual([{ kind: 'forgetBase', id: 'r' }]);
  });
});

/* -------------------------------------------------------------- merge -- */

const node = (fen: string, childFens: string[], extra: Partial<RepertoireNode> = {}): RepertoireNode => ({
  id: `r:${fen}`,
  repertoireId: 'r',
  fen,
  childFens,
  createdAt: 1,
  ...extra,
});
const card = (fen: string, lastReviewedAt: number | undefined, reps: number): RepertoireCard => ({
  id: `r:${fen}`,
  repertoireId: 'r',
  fen,
  expectedUci: 'e2e4',
  srs: { ease: 2.5, intervalDays: 1, reps, dueAt: 0, lapses: 0, lastReviewedAt },
  createdAt: 1,
});
const stats = (id: string, n: Partial<RepertoireLineStats>): RepertoireLineStats => ({
  id,
  repertoireId: 'r',
  uciKey: 'e2e4',
  sanPreview: 'e4',
  attempts: 0,
  completions: 0,
  movesPlayed: 0,
  correctMoves: 0,
  wrongMoves: 0,
  perfectCompletions: 0,
  createdAt: 100,
  ...n,
});
const snap = (updatedAt: number, parts: Partial<RepertoireSnapshot> = {}): RepertoireSnapshot => ({
  repertoire: { id: 'r', name: `v${updatedAt}`, color: 'white', createdAt: 1, updatedAt },
  nodes: [],
  cards: [],
  lineStats: [],
  ...parts,
});

describe('mergeSnapshots', () => {
  it('takes the repertoire record from the newer side', () => {
    expect(mergeSnapshots(snap(1), snap(2)).repertoire.name).toBe('v2');
    expect(mergeSnapshots(snap(3), snap(2)).repertoire.name).toBe('v3');
  });

  it('unions nodes and their children, so neither side orphans a branch', () => {
    const a = snap(2, { nodes: [node('root', ['x']), node('x', [])] });
    const b = snap(1, { nodes: [node('root', ['y']), node('y', [])] });
    const m = mergeSnapshots(a, b);
    expect(m.nodes.map((n) => n.fen).sort()).toEqual(['root', 'x', 'y']);
    expect(m.nodes.find((n) => n.fen === 'root')!.childFens).toEqual(['x', 'y']);
  });

  it('keeps a note that only one side wrote', () => {
    const a = snap(2, { nodes: [node('root', [])] });
    const b = snap(1, { nodes: [node('root', [], { notes: 'tricky' })] });
    expect(mergeSnapshots(a, b).nodes[0].notes).toBe('tricky');
  });

  it('keeps the most recently reviewed card, whichever side it is on', () => {
    const a = snap(2, { cards: [card('p', 100, 5)] });
    const b = snap(1, { cards: [card('p', 200, 1)] });
    expect(mergeSnapshots(a, b).cards[0].srs.lastReviewedAt).toBe(200);
  });

  it('breaks a review-time tie on reps', () => {
    const a = snap(2, { cards: [card('p', undefined, 1)] });
    const b = snap(1, { cards: [card('p', undefined, 4)] });
    expect(mergeSnapshots(a, b).cards[0].srs.reps).toBe(4);
  });

  it('line-stat counters take the max field by field', () => {
    const a = snap(2, { lineStats: [stats('s', { attempts: 5, wrongMoves: 1, lastPracticedAt: 10 })] });
    const b = snap(1, { lineStats: [stats('s', { attempts: 3, wrongMoves: 4, createdAt: 50 })] });
    const s = mergeSnapshots(a, b).lineStats[0];
    expect([s.attempts, s.wrongMoves, s.lastPracticedAt, s.createdAt]).toEqual([5, 4, 10, 50]);
  });

  it('a merge of a snapshot with itself changes nothing', () => {
    const a = snap(2, {
      nodes: [node('root', ['x']), node('x', [])],
      cards: [card('x', 5, 1)],
      lineStats: [stats('s', { attempts: 2 })],
    });
    expect(snapshotHash(mergeSnapshots(a, a))).toBe(snapshotHash(a));
  });
});

describe('snapshotHash', () => {
  it('does not depend on row order or key order', () => {
    const a = snap(1, { nodes: [node('a', []), node('b', [])] });
    const b = snap(1, { nodes: [node('b', []), node('a', [])] });
    const reordered = { ...b, repertoire: { updatedAt: 1, createdAt: 1, color: 'white' as const, name: 'v1', id: 'r' } };
    expect(snapshotHash(a)).toBe(snapshotHash(reordered));
  });

  it('changes when a card is reviewed', () => {
    expect(snapshotHash(snap(1, { cards: [card('p', 1, 1)] }))).not.toBe(
      snapshotHash(snap(1, { cards: [card('p', 2, 1)] })),
    );
  });

  it('treats an absent optional field like an undefined one, as storage does', () => {
    const withUndef = snap(1, { nodes: [node('a', [], { notes: undefined })] });
    expect(snapshotHash(withUndef)).toBe(snapshotHash(snap(1, { nodes: [node('a', [])] })));
  });
});

describe('nextRev', () => {
  it('is wall-clock time, but always past the rev it replaces', () => {
    expect(nextRev(null, 1000)).toBe(1000);
    expect(nextRev(500, 1000)).toBe(1000);
    // A device whose clock runs behind still moves the rev forward.
    expect(nextRev(5000, 1000)).toBe(5001);
  });
});
