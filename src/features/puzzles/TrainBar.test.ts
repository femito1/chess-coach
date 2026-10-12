import { describe, expect, it } from 'vitest';
import { RATING_MAX, RATING_MIN } from '@/data/puzzles.meta.generated';
import { RATING_ANCHOR, centerFor, isDifficulty, snapRating } from './TrainBar';

describe('snapRating', () => {
  it('rounds a typed rating to the nearest anchor', () => {
    expect(snapRating(1523)).toBe(1500);
    expect(snapRating(1525)).toBe(1550);
    expect(snapRating(1574)).toBe(1550);
    expect(snapRating(1500)).toBe(1500);
  });

  it('clamps to anchors inside the corpus range', () => {
    // "1" is what the field holds on the way to typing "1500"; committed on
    // its own it must land on the floor, not below it.
    expect(snapRating(1)).toBe(RATING_MIN);
    expect(snapRating(99_999)).toBe(Math.floor(RATING_MAX / RATING_ANCHOR) * RATING_ANCHOR);
    expect(snapRating(RATING_MIN) % RATING_ANCHOR).toBe(0);
  });

  it('produces a value the persisted difficulty accepts', () => {
    expect(isDifficulty(`fix:${snapRating(1777)}`)).toBe(true);
    expect(centerFor(`fix:${snapRating(1777)}`, 1200)).toBe(1800);
  });
});
