import { describe, expect, it } from 'vitest';
import type { OpeningLine } from './library';
import { buildPersonalOpeningStats } from './recommendations';
import {
  scoreLine,
  tiersForFamily,
  type Tier,
} from './difficulty';

/** Build a synthetic line of the given ply length. UCI content doesn't
 *  matter for scoring except its length and the shared prefix, so we
 *  generate distinct legal-looking tokens. `share` is globalShare. */
function line(
  family: string,
  plies: number,
  share: number,
  uciSeed: string[] = [],
): OpeningLine {
  const uci =
    uciSeed.length === plies
      ? uciSeed
      : Array.from({ length: plies }, (_, i) => `m${i}${family[0] ?? 'x'}`);
  return {
    eco: 'C00',
    name: `${family} ${plies}p`,
    family,
    variation: `${plies}p`,
    uci,
    pgn: '',
    globalGames: Math.round(share * 1_000_000),
    globalShare: share,
  };
}

const NO_STATS = buildPersonalOpeningStats([], 'white');
// Tests pin behaviour, not the bundle's current measured depth, so they
// inject the measured-predicate explicitly rather than depend on
// `MEASURED_PARENT_DEPTH` (which changes every data refresh).
const MEASURED: (l: { uci: string[] }) => boolean = () => true;
const ESTIMATED: (l: { uci: string[] }) => boolean = () => false;

describe('scoreLine', () => {
  it('scores a deeper line harder, all else equal', () => {
    const shallow = scoreLine(line('F', 4, 0.5), NO_STATS, MEASURED);
    const deep = scoreLine(line('F', 16, 0.5), NO_STATS, MEASURED);
    expect(deep.score).toBeGreaterThan(shallow.score);
  });

  it('scores a rarer (lower-share) line harder, all else equal', () => {
    const common = scoreLine(line('F', 8, 0.9), NO_STATS, MEASURED);
    const rare = scoreLine(line('F', 8, 0.05), NO_STATS, MEASURED);
    expect(rare.score).toBeGreaterThan(common.score);
  });

  it('labels extreme shares as forced or rare (when measured)', () => {
    expect(scoreLine(line('F', 8, 0.95), NO_STATS, MEASURED).forcedness).toBe('forced');
    expect(scoreLine(line('F', 8, 0.03), NO_STATS, MEASURED).forcedness).toBe('rare');
    expect(scoreLine(line('F', 8, 0.5), NO_STATS, MEASURED).forcedness).toBeNull();
  });

  it('depth and rarity are independent — a deep forced move need not be rare', () => {
    // The property full-depth measurement buys us: a 28-ply forced line
    // has a HIGH share, so it is not treated as rare despite its depth.
    const deepForced = scoreLine(line('F', 28, 0.99), NO_STATS, MEASURED);
    const deepRare = scoreLine(line('F', 28, 0.02), NO_STATS, MEASURED);
    expect(deepRare.score).toBeGreaterThan(deepForced.score);
    expect(deepForced.forcedness).toBe('forced');
  });

  it('treats zero recorded games as no rarity signal, not maximal rarity', () => {
    // globalGames === 0 is an absence of data (nothing recorded at that
    // position), so it must not score as "the rarest possible line". Two
    // zero-game lines of the same depth score identically regardless of
    // their nominal share, and neither gets a rare/forced chip.
    const zeroA: OpeningLine = { ...line('F', 12, 0), globalGames: 0, globalShare: 0 };
    const zeroB: OpeningLine = { ...line('F', 12, 0.5), globalGames: 0, globalShare: 0.5 };
    const a = scoreLine(zeroA, NO_STATS, MEASURED);
    const b = scoreLine(zeroB, NO_STATS, MEASURED);
    expect(a.score).toBe(b.score);
    expect(a.forcedness).toBeNull();
    // And a zero-game line must not outrank a genuinely measured rare one
    // purely for lacking data.
    const measuredRare = scoreLine(line('F', 12, 0.02), NO_STATS, MEASURED);
    expect(a.score).toBeLessThan(measuredRare.score);
  });

  it('ignores share entirely for an ESTIMATED line — no rarity, no label', () => {
    // Beyond the snapshot's measured depth, share is a depth-decayed
    // estimate, so it must not move the score or produce a forced/rare
    // chip. Two lines that differ ONLY in (estimated) share must score
    // identically, on depth alone.
    const a = scoreLine(line('F', 12, 0.9), NO_STATS, ESTIMATED);
    const b = scoreLine(line('F', 12, 0.02), NO_STATS, ESTIMATED);
    expect(a.score).toBe(b.score);
    expect(a.forcedness).toBeNull();
    expect(b.forcedness).toBeNull();
  });

  it('exposure lowers a line’s score; a losing record blunts that', () => {
    const uci = ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'g8f6', 'd2d3'];
    const cold = scoreLine(
      { ...line('F', 7, 0.4), uci },
      NO_STATS,
    );
    const winStats = buildPersonalOpeningStats(
      Array.from({ length: 12 }, () => ({
        userColor: 'white' as const,
        pgn: '1. e4 e5 2. Nf3 Nc6 3. Bc4 Nf6 4. d3',
        result: 'win' as const,
      })),
      'white',
    );
    const loseStats = buildPersonalOpeningStats(
      Array.from({ length: 12 }, () => ({
        userColor: 'white' as const,
        pgn: '1. e4 e5 2. Nf3 Nc6 3. Bc4 Nf6 4. d3',
        result: 'loss' as const,
      })),
      'white',
    );
    const warmWin = scoreLine({ ...line('F', 7, 0.4), uci }, winStats);
    const warmLose = scoreLine({ ...line('F', 7, 0.4), uci }, loseStats);

    // Familiarity always makes a line easier than never having seen it…
    expect(warmWin.score).toBeLessThan(cold.score);
    expect(warmLose.score).toBeLessThan(cold.score);
    // …but winning it is easier than losing it.
    expect(warmWin.score).toBeLessThan(warmLose.score);
    expect(warmWin.record?.games).toBe(12);
  });
});

describe('tiersForFamily', () => {
  function tierOf(map: Map<string, ReturnType<typeof scoreLine>>, l: OpeningLine): Tier {
    return map.get(l.uci.join(' '))!.tier;
  }

  it('spreads a family across all three tiers by its own distribution', () => {
    const fam = [
      line('F', 4, 0.9),
      line('F', 5, 0.8),
      line('F', 6, 0.7),
      line('F', 10, 0.4),
      line('F', 12, 0.3),
      line('F', 16, 0.1),
    ];
    const tiers = tiersForFamily(fam, NO_STATS, MEASURED);
    const values = fam.map((l) => tierOf(tiers, l));
    expect(values).toContain('easy');
    expect(values).toContain('medium');
    expect(values).toContain('hard');
    // Shallow/common lines land easy; deep/rare land hard.
    expect(tierOf(tiers, fam[0])).toBe('easy');
    expect(tierOf(tiers, fam[5])).toBe('hard');
  });

  it('is family-relative: the same line tiers differently across families', () => {
    // A 10-ply, 0.4-share line is the HARDEST in a shallow family…
    const shallowFam = [
      line('A', 3, 0.9),
      line('A', 4, 0.8),
      line('A', 10, 0.4, ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']),
    ];
    // …and the EASIEST in a deep family.
    const deepFam = [
      line('B', 10, 0.4, ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']),
      line('B', 18, 0.2),
      line('B', 24, 0.05),
    ];
    const probe = line('X', 10, 0.4, ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']);
    const key = probe.uci.join(' ');

    const shallowTiers = tiersForFamily(shallowFam, NO_STATS, MEASURED);
    const deepTiers = tiersForFamily(deepFam, NO_STATS, MEASURED);
    expect(shallowTiers.get(key)!.tier).toBe('hard');
    expect(deepTiers.get(key)!.tier).toBe('easy');
  });

  it('does not throw or collapse on families too small for terciles', () => {
    const one = tiersForFamily([line('S', 6, 0.5)], NO_STATS, MEASURED);
    expect(one.size).toBe(1);
    expect(['easy', 'medium', 'hard']).toContain([...one.values()][0].tier);

    const two = tiersForFamily([line('S', 3, 0.95), line('S', 20, 0.02)], NO_STATS, MEASURED);
    // Absolute thresholds: a short forced line is easy, a long rare one hard.
    const vals = [...two.values()].map((d) => d.tier);
    expect(vals).toContain('easy');
    expect(vals).toContain('hard');
  });

  it('assigns every line one of the three tiers', () => {
    const fam = Array.from({ length: 15 }, (_, i) => line('F', i + 2, (i % 5) / 5));
    const tiers = tiersForFamily(fam, NO_STATS, MEASURED);
    for (const d of tiers.values()) {
      expect(['easy', 'medium', 'hard']).toContain(d.tier);
    }
  });
});
