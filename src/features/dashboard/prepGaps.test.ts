import { describe, expect, it } from 'vitest';
import type { GameResult } from '@/db/schema';
import {
  MAX_WIN_RATE_FOR_GAP,
  MIN_GAMES_FOR_GAP,
  SAMPLES_PER_CANDIDATE,
  openingGroupKey,
  rankGapCandidates,
  truncateVariation,
  type GameForGaps,
} from './prepGaps';

let seq = 0;

/** One game, only the fields stage 1 reads. */
function game(
  result: GameResult,
  opening: string | undefined,
  userColor: 'white' | 'black' = 'black',
): GameForGaps {
  return { id: `g${++seq}`, opening, userColor, result };
}

/** `n` games of one result in one opening. */
function games(
  n: number,
  result: GameResult,
  opening: string | undefined,
  userColor: 'white' | 'black' = 'black',
): GameForGaps[] {
  return Array.from({ length: n }, () => game(result, opening, userColor));
}

/** The two ways `parseOpeningFromEcoUrl` spells one opening, depending on
 *  whether Chess.com's slug carried a trailing move sequence. */
const ADVANCE_WITH_MOVE = 'Caro Kann Defense Advance Variation: 4.Nf3';
const ADVANCE_BARE = 'Caro Kann Defense: Advance Variation';

describe('openingGroupKey', () => {
  it('collapses the two spellings of one opening onto one key', () => {
    // The regression this whole design turns on: the colon lands in a
    // different place for the same opening, so splitting on it would file
    // these under two families and hide the record.
    expect(openingGroupKey(ADVANCE_WITH_MOVE)).toBe(
      'Caro Kann Defense Advance Variation',
    );
    expect(openingGroupKey(ADVANCE_BARE)).toBe(
      'Caro Kann Defense Advance Variation',
    );
    expect(openingGroupKey(ADVANCE_WITH_MOVE)).toBe(openingGroupKey(ADVANCE_BARE));
  });

  it('strips a move tail after either punctuation', () => {
    expect(openingGroupKey('Sicilian Defense Najdorf Variation: 6.Be2')).toBe(
      'Sicilian Defense Najdorf Variation',
    );
    expect(openingGroupKey('Sicilian Defense: Najdorf Variation, 6.Be2')).toBe(
      'Sicilian Defense Najdorf Variation',
    );
  });

  it('leaves a name with no punctuation alone', () => {
    // The marker scan finds nothing when the marker word ends the slug.
    expect(openingGroupKey('Italian Game Two Knights Defense')).toBe(
      'Italian Game Two Knights Defense',
    );
    expect(openingGroupKey('Caro Kann Defense')).toBe('Caro Kann Defense');
  });

  it('keeps variation words that merely follow a comma', () => {
    expect(openingGroupKey('Sicilian Defense: Open, Classical')).toBe(
      'Sicilian Defense Open Classical',
    );
  });

  it('is empty for a missing name', () => {
    expect(openingGroupKey(undefined)).toBe('');
    expect(openingGroupKey('')).toBe('');
    expect(openingGroupKey('   ')).toBe('');
  });
});

describe('truncateVariation', () => {
  const deep = 'Advance Variation, Van der Wiel Attack, Dreyev Defense';

  it('keeps the requested number of comma segments', () => {
    expect(truncateVariation(deep, 1)).toBe('Advance Variation');
    expect(truncateVariation(deep, 2)).toBe('Advance Variation, Van der Wiel Attack');
  });

  it('keeps the whole label when asked for more depth than it has', () => {
    expect(truncateVariation(deep, 3)).toBe(deep);
    expect(truncateVariation(deep, 9)).toBe(deep);
  });

  it('collapses to the family level at depth 0 or below', () => {
    expect(truncateVariation(deep, 0)).toBe('');
    expect(truncateVariation('Advance Variation', -1)).toBe('');
  });
});

describe('rankGapCandidates', () => {
  it('merges both spellings into one candidate', () => {
    const out = rankGapCandidates([
      ...games(5, 'loss', ADVANCE_WITH_MOVE),
      ...games(3, 'loss', ADVANCE_BARE),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].groupName).toBe('Caro Kann Defense Advance Variation');
    expect(out[0].games).toBe(8);
    expect(out[0].losses).toBe(8);
  });

  it(`requires at least ${MIN_GAMES_FOR_GAP} decided games`, () => {
    expect(
      rankGapCandidates(games(MIN_GAMES_FOR_GAP - 1, 'loss', ADVANCE_BARE)),
    ).toEqual([]);
    expect(
      rankGapCandidates(games(MIN_GAMES_FOR_GAP, 'loss', ADVANCE_BARE)),
    ).toHaveLength(1);
  });

  it(`excludes anything at or above a ${MAX_WIN_RATE_FOR_GAP} win rate`, () => {
    // 4 wins + 1 draw + 5 losses = exactly 0.45, which is not a gap.
    expect(
      rankGapCandidates([
        ...games(4, 'win', ADVANCE_BARE),
        ...games(1, 'draw', ADVANCE_BARE),
        ...games(5, 'loss', ADVANCE_BARE),
      ]),
    ).toEqual([]);
    // 4 wins + 6 losses = 0.40, which is.
    expect(
      rankGapCandidates([
        ...games(4, 'win', ADVANCE_BARE),
        ...games(6, 'loss', ADVANCE_BARE),
      ]),
    ).toHaveLength(1);
  });

  it('ranks by points dropped, not by win rate', () => {
    // The Advance loses more games; the Panov loses a bigger share of a
    // smaller sample. The one costing more points comes first.
    const out = rankGapCandidates([
      ...games(8, 'loss', ADVANCE_BARE),
      ...games(3, 'win', ADVANCE_BARE),
      ...games(4, 'loss', 'Caro Kann Defense: Panov Attack'),
      ...games(1, 'win', 'Caro Kann Defense: Panov Attack'),
    ]);
    expect(out.map((c) => c.groupName)).toEqual([
      'Caro Kann Defense Advance Variation',
      'Caro Kann Defense Panov Attack',
    ]);
    expect(out[0].pointsDropped).toBe(8);
    expect(out[1].pointsDropped).toBe(4);
    // ...even though the Panov's win rate is the worse of the two.
    expect(out[1].winRate).toBeLessThan(out[0].winRate);
  });

  it('scores a draw as half a point dropped', () => {
    const out = rankGapCandidates([
      ...games(4, 'loss', ADVANCE_BARE),
      ...games(2, 'draw', ADVANCE_BARE),
    ]);
    expect(out[0].pointsDropped).toBe(5);
    expect(out[0].winRate).toBeCloseTo(1 / 6);
  });

  it('keeps the two colours apart, because repertoires are per-colour', () => {
    const out = rankGapCandidates([
      ...games(6, 'loss', ADVANCE_BARE, 'black'),
      ...games(5, 'loss', ADVANCE_BARE, 'white'),
    ]);
    expect(out).toHaveLength(2);
    expect(out.map((c) => c.color)).toEqual(['black', 'white']);
    expect(out.map((c) => c.games)).toEqual([6, 5]);
  });

  it('ignores games with no usable opening name', () => {
    expect(rankGapCandidates(games(6, 'loss', undefined))).toEqual([]);
    expect(rankGapCandidates(games(6, 'loss', ''))).toEqual([]);
  });

  it('excludes unknown results from the denominator entirely', () => {
    // 4 losses + 4 unknowns must read as 4 games, not 8 — otherwise the
    // row claims a sample it doesn't have.
    const out = rankGapCandidates([
      ...games(4, 'loss', ADVANCE_BARE),
      ...games(4, 'unknown', ADVANCE_BARE),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].games).toBe(4);
    expect(out[0].losses).toBe(4);
  });

  it('samples lost games, capped, so stage 2 reads few PGNs', () => {
    const out = rankGapCandidates([
      ...games(2, 'win', ADVANCE_BARE),
      ...games(6, 'loss', ADVANCE_BARE),
    ]);
    expect(out[0].sampleGameIds).toHaveLength(SAMPLES_PER_CANDIDATE);
  });

  it('drops a candidate with no lost game to sample', () => {
    // A losing record always contains a loss, so the guard is only
    // reachable with the ceiling raised: an all-draw group then clears the
    // win-rate filter but has no losing game to resolve the line from.
    expect(
      rankGapCandidates(games(6, 'draw', ADVANCE_BARE), { maxWinRate: 0.9 }),
    ).toEqual([]);
    const withLoss = rankGapCandidates(
      [...games(6, 'draw', ADVANCE_BARE), ...games(1, 'loss', ADVANCE_BARE)],
      { maxWinRate: 0.9 },
    );
    expect(withLoss).toHaveLength(1);
    expect(withLoss[0].sampleGameIds).toHaveLength(1);
  });

  it('honours the limit', () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      games(5, 'loss', `Family ${i} Defense: Some Variation`),
    ).flat();
    expect(rankGapCandidates(many, { limit: 3 })).toHaveLength(3);
  });
});
