import { describe, expect, it } from 'vitest';
import type { OpeningLine } from '@/features/openings/library';
import { buildPersonalOpeningStats } from '@/features/openings/recommendations';
import {
  buildPickerModel,
  sanTokensFromPgn,
  type RepertoireLeaf,
} from './pickerModel';

function line(
  family: string,
  variation: string,
  uci: string[],
  share = 0.4,
  pgn = '',
): OpeningLine {
  return {
    eco: 'B10',
    name: `${family}: ${variation}`,
    family,
    variation,
    uci,
    pgn,
    globalGames: Math.round(share * 1_000_000),
    globalShare: share,
  };
}

/** A repertoire leaf. `san` is only read for repertoire-only (orphan)
 *  entries, so tests that don't care about the ribbon pass placeholders. */
function leaf(uci: string[], family: string): RepertoireLeaf {
  return { uci, san: uci.map((u) => u.slice(2, 4)), family };
}

const NO_STATS = buildPersonalOpeningStats([], 'white');

// A tiny synthetic Caro-Kann-ish family.
const ADVANCE = ['e2e4', 'c7c6', 'd2d4', 'd7d5', 'e4e5'];
const CLASSICAL = ['e2e4', 'c7c6', 'd2d4', 'd7d5', 'b1c3', 'd5e4'];
const PANOV = ['e2e4', 'c7c6', 'd2d4', 'd7d5', 'e4d5', 'c6d5', 'c2c4'];
const LIB = [
  line('Caro', 'Advance', ADVANCE, 0.5),
  line('Caro', 'Classical', CLASSICAL, 0.3),
  line('Caro', 'Panov', PANOV, 0.1),
];

describe('buildPickerModel', () => {
  it('marks exactly the library lines the repertoire already holds', () => {
    const leaves: RepertoireLeaf[] = [leaf(ADVANCE, 'Caro')];
    const [fam] = buildPickerModel({
      repertoireLeaves: leaves,
      libraryByFamily: new Map([['Caro', LIB]]),
      personal: NO_STATS,
    });
    expect(fam.entries).toHaveLength(3);
    const advance = fam.entries.find((e) => e.variation === 'Advance')!;
    const panov = fam.entries.find((e) => e.variation === 'Panov')!;
    expect(advance.inRepertoire).toBe(true);
    expect(advance.repertoireIndex).toBe(0);
    expect(panov.inRepertoire).toBe(false);
    expect(panov.repertoireIndex).toBeNull();
  });

  it('treats a library line as in-repertoire when a leaf EXTENDS it', () => {
    // The repertoire stores a deeper line; the shallow library variation
    // is a prefix of it and should read as already added.
    const deeper = [...CLASSICAL, 'b1e4', 'b8d7']; // extends CLASSICAL by 2 ply
    const leaves: RepertoireLeaf[] = [leaf(deeper, 'Caro')];
    const [fam] = buildPickerModel({
      repertoireLeaves: leaves,
      libraryByFamily: new Map([['Caro', LIB]]),
      personal: NO_STATS,
    });
    const classical = fam.entries.find((e) => e.variation === 'Classical')!;
    expect(classical.inRepertoire).toBe(true);
    expect(classical.repertoireIndex).toBe(0);
    // …but the match is NOT exact, so drilling it via the session would
    // test two moves past what this entry describes. Callers must drill
    // such an entry as a standalone line instead.
    expect(classical.leafIsExact).toBe(false);
  });

  it('marks leafIsExact only when the leaf IS the line', () => {
    const leaves: RepertoireLeaf[] = [
      leaf(ADVANCE, 'Caro'), // exactly the Advance line
      leaf([...PANOV, 'g8f6'], 'Caro'), // extends Panov
    ];
    const [fam] = buildPickerModel({
      repertoireLeaves: leaves,
      libraryByFamily: new Map([['Caro', LIB]]),
      personal: NO_STATS,
    });
    expect(fam.entries.find((e) => e.variation === 'Advance')!.leafIsExact).toBe(true);
    expect(fam.entries.find((e) => e.variation === 'Panov')!.leafIsExact).toBe(false);
    // A line with no matching leaf at all is neither in-repertoire nor exact.
    const classical = fam.entries.find((e) => e.variation === 'Classical')!;
    expect(classical.inRepertoire).toBe(false);
    expect(classical.leafIsExact).toBe(false);
  });

  it('points at the SHORTEST matching leaf for drilling', () => {
    // Two leaves both extend Advance; the shorter one wins as drill target.
    const short = ADVANCE; // index 0 after depth-sort
    const long = [...ADVANCE, 'g8f6', 'b1c3'];
    const leaves: RepertoireLeaf[] = [
      leaf(long, 'Caro'), // caller index 0
      leaf(short, 'Caro'), // caller index 1
    ];
    const [fam] = buildPickerModel({
      repertoireLeaves: leaves,
      libraryByFamily: new Map([['Caro', LIB]]),
      personal: NO_STATS,
    });
    const advance = fam.entries.find((e) => e.variation === 'Advance')!;
    // Shortest matching leaf is `short`, whose caller index is 1.
    expect(advance.repertoireIndex).toBe(1);
  });

  it('surfaces library lines the repertoire does NOT have, as discoverable', () => {
    const [fam] = buildPickerModel({
      repertoireLeaves: [],
      libraryByFamily: new Map([['Caro', LIB]]),
      personal: NO_STATS,
    });
    expect(fam.entries.every((e) => !e.inRepertoire)).toBe(true);
    expect(fam.entries.map((e) => e.variation).sort()).toEqual([
      'Advance',
      'Classical',
      'Panov',
    ]);
  });

  it('assigns every entry a tier and a ply count', () => {
    const [fam] = buildPickerModel({
      repertoireLeaves: [],
      libraryByFamily: new Map([['Caro', LIB]]),
      personal: NO_STATS,
    });
    for (const e of fam.entries) {
      expect(['easy', 'medium', 'hard']).toContain(e.tier);
      expect(e.plies).toBe(e.uci.length);
    }
  });

  it('keeps repertoire-only (non-library) lines, marked in-repertoire', () => {
    const custom = ['g1f3', 'd7d5', 'g2g3']; // not in LIB
    // Two families result: Caro (library) + Custom (orphan leaf).
    const customFam = buildPickerModel({
      repertoireLeaves: [leaf(custom, 'Custom')],
      libraryByFamily: new Map([['Caro', LIB]]),
      personal: NO_STATS,
    }).find((f) => f.family === 'Custom')!;
    expect(customFam.entries).toHaveLength(1);
    expect(customFam.entries[0].inRepertoire).toBe(true);
    expect(customFam.entries[0].repertoireIndex).toBe(0);
  });

  it('orders in-repertoire entries before library-only within a family', () => {
    const leaves: RepertoireLeaf[] = [leaf(PANOV, 'Caro')];
    const [fam] = buildPickerModel({
      repertoireLeaves: leaves,
      libraryByFamily: new Map([['Caro', LIB]]),
      personal: NO_STATS,
    });
    expect(fam.entries[0].inRepertoire).toBe(true);
    expect(fam.entries[0].variation).toBe('Panov');
  });

  it('reads SAN off the library line PGN', () => {
    const [fam] = buildPickerModel({
      repertoireLeaves: [],
      libraryByFamily: new Map([
        [
          'Caro',
          [line('Caro', 'Advance', ADVANCE, 0.5, '1. e4 c6 2. d4 d5 3. e5')],
        ],
      ]),
      personal: NO_STATS,
    });
    expect(fam.entries[0].san).toEqual(['e4', 'c6', 'd4', 'd5', 'e5']);
  });

  it('flags same-named entries within a family so the UI can show moves', () => {
    // The shape the ECO data actually has: one name, several depths, and
    // here the deeper one is NOT a continuation of the shallower.
    const closedShort = ['e2e4', 'c7c5', 'b1c3'];
    const closedDeep = ['e2e4', 'c7c5', 'b1c3', 'e7e6', 'g2g3'];
    const [fam] = buildPickerModel({
      repertoireLeaves: [],
      libraryByFamily: new Map([
        [
          'Sicilian',
          [
            line('Sicilian', 'Closed', closedShort),
            line('Sicilian', 'Closed', closedDeep),
            line('Sicilian', 'Alapin', ['e2e4', 'c7c5', 'c2c3']),
          ],
        ],
      ]),
      personal: NO_STATS,
    });
    const closed = fam.entries.filter((e) => e.variation === 'Closed');
    expect(closed).toHaveLength(2);
    expect(closed.every((e) => e.sharesLabel)).toBe(true);
    expect(fam.entries.find((e) => e.variation === 'Alapin')!.sharesLabel).toBe(
      false,
    );
  });

  it('treats differently-cased duplicates of a label as a collision', () => {
    const [fam] = buildPickerModel({
      repertoireLeaves: [],
      libraryByFamily: new Map([
        [
          'Semi-Slav',
          [
            line('Semi-Slav', 'Main Line', ['d2d4', 'd7d5']),
            line('Semi-Slav', 'Main line', ['d2d4', 'd7d5', 'c2c4']),
          ],
        ],
      ]),
      personal: NO_STATS,
    });
    expect(fam.entries.every((e) => e.sharesLabel)).toBe(true);
  });

  it('marks repertoire-only entries custom, with their own SAN', () => {
    const custom = ['g1f3', 'd7d5', 'g2g3'];
    const customFam = buildPickerModel({
      repertoireLeaves: [{ uci: custom, san: ['Nf3', 'd5', 'g3'], family: 'Custom' }],
      libraryByFamily: new Map([['Caro', LIB]]),
      personal: NO_STATS,
    }).find((f) => f.family === 'Custom')!;
    const entry = customFam.entries[0];
    // No library row backs it, so it has no name and no ECO to show — the
    // UI must not caption it "mainline".
    expect(entry.isCustom).toBe(true);
    expect(entry.variation).toBe('');
    expect(entry.eco).toBe('');
    expect(entry.san).toEqual(['Nf3', 'd5', 'g3']);
  });

  it('builds a lowercased search haystack of name, ECO and moves', () => {
    const [fam] = buildPickerModel({
      repertoireLeaves: [],
      libraryByFamily: new Map([
        [
          'Caro',
          [line('Caro', 'Panov Attack', PANOV, 0.1, '1. e4 c6 2. d4 d5 3. exd5 cxd5 4. c4')],
        ],
      ]),
      personal: NO_STATS,
    });
    const { searchText } = fam.entries[0];
    expect(searchText).toContain('panov attack');
    expect(searchText).toContain('b10');
    expect(searchText).toContain('exd5');
    expect(searchText).toBe(searchText.toLowerCase());
  });
});

describe('sanTokensFromPgn', () => {
  it('drops move numbers and keeps castling', () => {
    expect(sanTokensFromPgn('1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. O-O')).toEqual([
      'e4',
      'e5',
      'Nf3',
      'Nc6',
      'Bb5',
      'a6',
      'O-O',
    ]);
  });

  it('handles black-first ellipsis numbering and empty input', () => {
    expect(sanTokensFromPgn('1... c5 2. Nf3')).toEqual(['c5', 'Nf3']);
    expect(sanTokensFromPgn('')).toEqual([]);
    expect(sanTokensFromPgn('   ')).toEqual([]);
  });
});
