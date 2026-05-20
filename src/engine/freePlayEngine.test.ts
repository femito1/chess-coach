import { describe, expect, it } from 'vitest';
import { strengthToOptions, FREE_PLAY_STRENGTHS } from './freePlayEngine';

/**
 * Pure-mapping tests for the strength → UCI-options table that drives
 * the free-play opponent worker. These cases lock the contract that:
 *
 *   - "max" disables UCI_LimitStrength so Stockfish plays at full
 *     strength and we don't accidentally cap a user who wants the
 *     real engine.
 *   - The capped levels (2000 / 1600 / 1200) all flip
 *     UCI_LimitStrength on, with Skill Level monotonically decreasing
 *     and search depth monotonically decreasing. Both knobs matter:
 *     Skill Level alone with depth=22 still produces near-perfect
 *     play because the deep search rediscovers the best move; capping
 *     depth keeps the weaker level from "leaking" through.
 *   - Unknown levels (corrupted Settings row, future cloud-sync
 *     value) fall through to "max" so the page can't softlock.
 *
 * The runtime hook (`pickEngineMove`) exercising the real worker is
 * not unit-tested — it requires a Worker + WASM and lives in the
 * integration tier. This pure mapping is what we want regression-
 * guarded at the cheapest layer.
 */
describe('strengthToOptions', () => {
  it('returns full-strength config for "max"', () => {
    expect(strengthToOptions('max')).toEqual({
      level: 'max',
      limitStrength: false,
      skill: 20,
      depth: 14,
    });
  });

  it('returns capped config for "2000"', () => {
    const r = strengthToOptions('2000');
    expect(r.level).toBe('2000');
    expect(r.limitStrength).toBe(true);
    expect(r.skill).toBe(15);
    expect(r.depth).toBe(10);
  });

  it('returns capped config for "1600"', () => {
    const r = strengthToOptions('1600');
    expect(r.level).toBe('1600');
    expect(r.limitStrength).toBe(true);
    expect(r.skill).toBe(10);
    expect(r.depth).toBe(8);
  });

  it('returns capped config for "1200"', () => {
    const r = strengthToOptions('1200');
    expect(r.level).toBe('1200');
    expect(r.limitStrength).toBe(true);
    expect(r.skill).toBe(5);
    expect(r.depth).toBe(6);
  });

  it('falls back to "max" for unknown strings', () => {
    expect(strengthToOptions('grandmaster').level).toBe('max');
    expect(strengthToOptions('').level).toBe('max');
    expect(strengthToOptions('1500').level).toBe('max');
  });

  it('falls back to "max" for undefined', () => {
    expect(strengthToOptions(undefined).level).toBe('max');
  });

  it('Skill Level decreases monotonically as the cap drops', () => {
    const max = strengthToOptions('max');
    const e2000 = strengthToOptions('2000');
    const e1600 = strengthToOptions('1600');
    const e1200 = strengthToOptions('1200');
    expect(max.skill).toBeGreaterThanOrEqual(e2000.skill);
    expect(e2000.skill).toBeGreaterThan(e1600.skill);
    expect(e1600.skill).toBeGreaterThan(e1200.skill);
  });

  it('depth decreases monotonically as the cap drops', () => {
    expect(strengthToOptions('max').depth).toBeGreaterThan(
      strengthToOptions('2000').depth,
    );
    expect(strengthToOptions('2000').depth).toBeGreaterThan(
      strengthToOptions('1600').depth,
    );
    expect(strengthToOptions('1600').depth).toBeGreaterThan(
      strengthToOptions('1200').depth,
    );
  });

  it('every FREE_PLAY_STRENGTHS entry maps cleanly', () => {
    for (const level of FREE_PLAY_STRENGTHS) {
      const r = strengthToOptions(level);
      expect(r.level).toBe(level);
      expect(r.skill).toBeGreaterThanOrEqual(0);
      expect(r.skill).toBeLessThanOrEqual(20);
      expect(r.depth).toBeGreaterThan(0);
    }
  });
});
