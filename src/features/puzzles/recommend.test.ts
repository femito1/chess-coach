import { describe, expect, it } from 'vitest';
import type { Motif } from '@/db/schema';
import type { MistakeRow } from './mistakes';
import {
  HALF_LIFE_DAYS,
  MAX_MOTIFS,
  MIN_SHARE,
  RATING_WINDOW,
  DEFAULT_CENTER_RATING,
  ratingWindowFor,
  estimateUserRating,
  RATING_SAMPLE_GAMES,
  recommendationPlan,
  scoreMotifs,
} from './recommend';

const NOW = Date.UTC(2026, 7, 31);
const DAY = 86_400_000;

/** Minimal MistakeRow — only the fields the scorer reads matter, but we
 *  build the full shape so the test breaks if the contract changes. It has
 *  earned that once already: trimming the row's dead mini-board fields failed
 *  here first, which is exactly the intent. */
function mistake(opts: {
  motifs: Motif[];
  daysAgo: number;
  winrateDrop?: number;
}): MistakeRow {
  return {
    gameId: `g${opts.daysAgo}-${opts.motifs.join('+')}`,
    ply: 21,
    gameDate: NOW - opts.daysAgo * DAY,
    opening: undefined,
    eco: undefined,
    motifs: opts.motifs,
    phase: 'middlegame',
    inTimeTrouble: false,
    winrateDrop: opts.winrateDrop ?? 0.5,
  };
}

describe('scoreMotifs — recency decay', () => {
  it('halves a motif’s weight every HALF_LIFE_DAYS', () => {
    const fresh = scoreMotifs([mistake({ motifs: ['fork'], daysAgo: 0 })], NOW);
    const aged = scoreMotifs(
      [mistake({ motifs: ['fork'], daysAgo: HALF_LIFE_DAYS })],
      NOW,
    );
    expect(aged[0].score / fresh[0].score).toBeCloseTo(0.5, 5);
  });

  it('all but discards a motif last missed ~4 months ago', () => {
    // The behaviour the feature exists for: "I don't want to be doing a
    // puzzle motif that I messed up on 4 months ago and am now good at."
    const recent = mistake({ motifs: ['fork'], daysAgo: 3 });
    const old = mistake({ motifs: ['pin'], daysAgo: 120 });
    const scores = scoreMotifs([recent, old], NOW);

    const fork = scores.find((s) => s.motif === 'fork')!;
    const pin = scores.find((s) => s.motif === 'pin')!;
    // 120 days ≈ 4 half-lives → 2^-4 ≈ 6% of a same-day mistake.
    expect(pin.score / fork.score).toBeLessThan(0.1);
    expect(fork.share).toBeGreaterThan(0.9);
  });

  it('ranks a single recent blunder above many stale ones', () => {
    const rows = [
      mistake({ motifs: ['fork'], daysAgo: 2 }),
      ...Array.from({ length: 10 }, (_, i) =>
        mistake({ motifs: ['pin'], daysAgo: 150 + i }),
      ),
    ];
    const scores = scoreMotifs(rows, NOW);
    expect(scores[0].motif).toBe('fork');
    // And the raw count still reports honestly, undecayed.
    expect(scores.find((s) => s.motif === 'pin')!.mistakeCount).toBe(10);
  });

  it('treats a future gameDate as age zero rather than amplifying it', () => {
    // Clock skew between the client and Chess.com's endTime is real; a
    // negative age must not produce a weight > 1 and let one game dominate.
    const skewed = scoreMotifs([mistake({ motifs: ['fork'], daysAgo: -30 })], NOW);
    const sameDay = scoreMotifs([mistake({ motifs: ['fork'], daysAgo: 0 })], NOW);
    expect(skewed[0].score).toBeCloseTo(sameDay[0].score, 10);
  });
});

describe('scoreMotifs — severity', () => {
  it('weights a game-losing blunder above a minor inaccuracy', () => {
    const severe = scoreMotifs(
      [mistake({ motifs: ['fork'], daysAgo: 0, winrateDrop: 1 })],
      NOW,
    );
    const minor = scoreMotifs(
      [mistake({ motifs: ['fork'], daysAgo: 0, winrateDrop: 0 })],
      NOW,
    );
    expect(severe[0].score).toBeGreaterThan(minor[0].score);
    // Floor 0.5 + drop → 1.5 vs 0.5, i.e. exactly 3x.
    expect(severe[0].score / minor[0].score).toBeCloseTo(3, 5);
  });

  it('clamps an out-of-range winrateDrop', () => {
    const wild = scoreMotifs(
      [mistake({ motifs: ['fork'], daysAgo: 0, winrateDrop: 99 })],
      NOW,
    );
    const capped = scoreMotifs(
      [mistake({ motifs: ['fork'], daysAgo: 0, winrateDrop: 1 })],
      NOW,
    );
    expect(wild[0].score).toBeCloseTo(capped[0].score, 10);
  });
});

describe('scoreMotifs — exclusions', () => {
  it('excludes `other`, which has no themes to drill', () => {
    const scores = scoreMotifs(
      [mistake({ motifs: ['other', 'fork'], daysAgo: 1 })],
      NOW,
    );
    expect(scores.map((s) => s.motif)).toEqual(['fork']);
  });

  it('returns nothing when every mistake is unnameable', () => {
    expect(scoreMotifs([mistake({ motifs: ['other'], daysAgo: 1 })], NOW)).toEqual([]);
  });

  it('is empty for no mistakes at all', () => {
    expect(scoreMotifs([], NOW)).toEqual([]);
  });

  it('credits every motif on a multi-motif mistake', () => {
    const scores = scoreMotifs(
      [mistake({ motifs: ['fork', 'hangingPiece'], daysAgo: 0 })],
      NOW,
    );
    expect(scores.map((s) => s.motif).sort()).toEqual(['fork', 'hangingPiece']);
    expect(scores[0].score).toBeCloseTo(scores[1].score, 10);
  });

  it('reports lastSeenAt as the most recent contributing mistake', () => {
    const scores = scoreMotifs(
      [
        mistake({ motifs: ['fork'], daysAgo: 40 }),
        mistake({ motifs: ['fork'], daysAgo: 5 }),
      ],
      NOW,
    );
    expect(scores[0].lastSeenAt).toBe(NOW - 5 * DAY);
  });

  it('shares sum to 1 across scored motifs', () => {
    const scores = scoreMotifs(
      [
        mistake({ motifs: ['fork'], daysAgo: 1 }),
        mistake({ motifs: ['pin'], daysAgo: 4 }),
        mistake({ motifs: ['skewer'], daysAgo: 9 }),
      ],
      NOW,
    );
    expect(scores.reduce((a, s) => a + s.share, 0)).toBeCloseTo(1, 10);
  });
});

describe('ratingWindowFor', () => {
  it('centres on the user rating', () => {
    expect(ratingWindowFor(1650)).toEqual({
      lo: 1650 - RATING_WINDOW,
      hi: 1650 + RATING_WINDOW,
    });
  });

  it('falls back to the documented default when rating is unknown', () => {
    expect(ratingWindowFor(undefined)).toEqual({
      lo: DEFAULT_CENTER_RATING - RATING_WINDOW,
      hi: DEFAULT_CENTER_RATING + RATING_WINDOW,
    });
    expect(ratingWindowFor(Number.NaN)).toEqual(ratingWindowFor(undefined));
  });
});

describe('estimateUserRating', () => {
  const g = (endTime: number, userRating?: number) => ({ endTime, userRating });

  it('takes the median, not the mean', () => {
    // Mean would be 1500; median is 1200. A single outlier must not drag it.
    const games = [g(5, 1100), g(4, 1200), g(3, 2200)];
    expect(estimateUserRating(games)).toBe(1200);
  });

  it('samples only the most recent games', () => {
    // 20 recent games at 1600, plus older ones at 800. The old ones must not
    // pull the estimate down — the window should track current form.
    const recent = Array.from({ length: RATING_SAMPLE_GAMES }, (_, i) =>
      g(1_000_000 - i, 1600),
    );
    const ancient = Array.from({ length: 50 }, (_, i) => g(1_000 - i, 800));
    expect(estimateUserRating([...ancient, ...recent])).toBe(1600);
  });

  it('ignores games with no rating', () => {
    expect(estimateUserRating([g(3), g(2, 1500), g(1)])).toBe(1500);
  });

  it('returns undefined when nothing carries a rating', () => {
    expect(estimateUserRating([g(3), g(2), g(1)])).toBeUndefined();
    expect(estimateUserRating([])).toBeUndefined();
  });

  it('ignores non-finite ratings', () => {
    expect(estimateUserRating([g(2, Number.NaN), g(1, 1400)])).toBe(1400);
  });

  it('feeds a sane window into ratingWindowFor', () => {
    const rating = estimateUserRating([g(2, 1750), g(1, 1750)])!;
    expect(ratingWindowFor(rating)).toEqual({
      lo: 1750 - RATING_WINDOW,
      hi: 1750 + RATING_WINDOW,
    });
  });
});

describe('recommendationPlan', () => {
  const many = [
    ...Array.from({ length: 8 }, () => mistake({ motifs: ['fork'], daysAgo: 1 })),
    ...Array.from({ length: 6 }, () => mistake({ motifs: ['pin'], daysAgo: 2 })),
    ...Array.from({ length: 4 }, () => mistake({ motifs: ['backRank'], daysAgo: 3 })),
  ];

  it('allocates exactly queueLength slots', () => {
    for (const queueLength of [1, 5, 20, 23, 100]) {
      const plan = recommendationPlan({
        rows: many,
        now: NOW,
        userRating: 1500,
        queueLength,
      });
      const total = plan.allocation.reduce((a, x) => a + x.count, 0);
      expect(total, `queueLength=${queueLength}`).toBe(queueLength);
    }
  });

  it('allocates proportionally to share, strongest motif first', () => {
    const plan = recommendationPlan({
      rows: many,
      now: NOW,
      userRating: 1500,
      queueLength: 18,
    });
    expect(plan.motifs[0].motif).toBe('fork');
    const forkSlots = plan.allocation.find((a) => a.motif === 'fork')!.count;
    const backSlots = plan.allocation.find((a) => a.motif === 'backRank')!.count;
    expect(forkSlots).toBeGreaterThan(backSlots);
  });

  it('unions the themes of the selected motifs', () => {
    const plan = recommendationPlan({
      rows: many,
      now: NOW,
      userRating: 1500,
      queueLength: 20,
    });
    expect(plan.themes).toContain('fork');
    expect(plan.themes).toContain('pin');
    expect(plan.themes).toContain('backRankMate');
    // De-duplicated.
    expect(new Set(plan.themes).size).toBe(plan.themes.length);
  });

  it('drops motifs below the share floor', () => {
    const rows = [
      ...Array.from({ length: 50 }, () => mistake({ motifs: ['fork'], daysAgo: 1 })),
      // One very stale pin — real evidence, but nowhere near the floor.
      mistake({ motifs: ['pin'], daysAgo: 300 }),
    ];
    const plan = recommendationPlan({ rows, now: NOW, userRating: 1500, queueLength: 10 });
    expect(plan.motifs.map((m) => m.motif)).toEqual(['fork']);
    expect(plan.motifs[0].share).toBeGreaterThan(MIN_SHARE);
  });

  it('caps the motif count at MAX_MOTIFS', () => {
    const spread: Motif[] = [
      'fork',
      'pin',
      'skewer',
      'backRank',
      'hangingPiece',
      'trappedPiece',
      'discoveredAttack',
    ];
    const rows = spread.map((m) => mistake({ motifs: [m], daysAgo: 1 }));
    const plan = recommendationPlan({ rows, now: NOW, userRating: 1500, queueLength: 20 });
    expect(plan.motifs.length).toBe(MAX_MOTIFS);
  });

  it('returns an empty plan with no usable history, keeping the rating window', () => {
    const plan = recommendationPlan({
      rows: [mistake({ motifs: ['other'], daysAgo: 1 })],
      now: NOW,
      userRating: 1700,
      queueLength: 20,
    });
    expect(plan.motifs).toEqual([]);
    expect(plan.allocation).toEqual([]);
    expect(plan.themes).toEqual([]);
    // The caller falls back to a tier, but the window must still be sane.
    expect(plan.ratingLo).toBe(1700 - RATING_WINDOW);
    expect(plan.ratingHi).toBe(1700 + RATING_WINDOW);
  });

  it('never allocates a negative or fractional count', () => {
    const plan = recommendationPlan({
      rows: many,
      now: NOW,
      userRating: 1500,
      queueLength: 7,
    });
    for (const a of plan.allocation) {
      expect(Number.isInteger(a.count)).toBe(true);
      expect(a.count).toBeGreaterThanOrEqual(0);
    }
  });
});
