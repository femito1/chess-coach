import { describe, expect, it } from 'vitest';
import {
  candidateGameIdsForUrl,
  candidateMonths,
  extractChessComGameId,
  monthArchiveUrl,
} from './urlShape';

describe('extractChessComGameId', () => {
  it('extracts the id from a page-shape URL', () => {
    expect(
      extractChessComGameId('https://www.chess.com/game/live/146284294300'),
    ).toBe('146284294300');
  });
  it('extracts the id from an api-shape URL', () => {
    expect(
      extractChessComGameId('https://www.chess.com/live/game/146284294300'),
    ).toBe('146284294300');
  });
  it('extracts the id from a daily/correspondence URL', () => {
    expect(
      extractChessComGameId('https://www.chess.com/game/daily/123456789'),
    ).toBe('123456789');
  });
  it('extracts the id from the bare /game/<id> shape (current 2026-05 chess.com URL)', () => {
    // Confirmed by user diagnostic on 2026-05-08: chess.com routes
    // finished games to `https://www.chess.com/game/<id>` (no `live/`
    // segment). This regression-guards that the regex picks up the
    // bare shape even though it shares the `/game/` prefix with
    // `/game/live/` and `/game/daily/`.
    expect(
      extractChessComGameId('https://www.chess.com/game/168426791620'),
    ).toBe('168426791620');
  });
  it('does NOT mis-extract from /game/live/<id> as a bare /game/<id>', () => {
    // Anchored — the more-specific alternatives (`game/live/`,
    // `live/game/`, `game/daily/`) come first in the regex so they
    // win over the bare `game/` fallback. Without ordering this test
    // would pass anyway, but pinning it locks the regex shape.
    expect(
      extractChessComGameId('https://www.chess.com/game/live/12345'),
    ).toBe('12345');
  });
  it('returns undefined for unknown shapes', () => {
    expect(extractChessComGameId('https://www.chess.com/home')).toBeUndefined();
    expect(extractChessComGameId('not-a-url')).toBeUndefined();
    expect(extractChessComGameId('')).toBeUndefined();
    // `/game-explorer/<id>` is a real chess.com URL that we MUST NOT
    // confuse with a finished game.
    expect(
      extractChessComGameId('https://www.chess.com/game-explorer/123'),
    ).toBeUndefined();
  });
});

describe('candidateGameIdsForUrl', () => {
  // Use a tiny deterministic stand-in hash so the test pins behaviour
  // rather than coupling to FNV-1a output. The real production hash
  // (`gameIdFromUrl`) is pinned by `importer.test.ts`.
  const fakeHash = (s: string) => `H(${s})`;

  it('returns one id for an unrecognised URL shape', () => {
    expect(candidateGameIdsForUrl('https://example.com/x', fakeHash)).toEqual([
      'H(https://example.com/x)',
    ]);
  });
  it('returns every known shape variant when given a /game/live/ URL', () => {
    // Order: input first (so the most-likely match comes first when
    // we walk the list), then every other shape we know about.
    const ids = candidateGameIdsForUrl(
      'https://www.chess.com/game/live/12345',
      fakeHash,
    );
    expect(ids).toEqual([
      'H(https://www.chess.com/game/live/12345)',
      'H(https://www.chess.com/live/game/12345)',
      'H(https://www.chess.com/game/12345)',
    ]);
  });
  it('returns every known shape variant when given a /live/game/ URL', () => {
    const ids = candidateGameIdsForUrl(
      'https://www.chess.com/live/game/12345',
      fakeHash,
    );
    expect(ids).toEqual([
      'H(https://www.chess.com/live/game/12345)',
      'H(https://www.chess.com/game/live/12345)',
      'H(https://www.chess.com/game/12345)',
    ]);
  });
  it('returns every known shape variant when given a bare /game/ URL', () => {
    // The 2026-05 chess.com shape. Critically, this includes
    // `/game/live/<id>` so a re-click after a months-old import (when
    // chess.com used /game/live/) still hits the IndexedDB cache.
    const ids = candidateGameIdsForUrl(
      'https://www.chess.com/game/12345',
      fakeHash,
    );
    expect(ids).toEqual([
      'H(https://www.chess.com/game/12345)',
      'H(https://www.chess.com/game/live/12345)',
      'H(https://www.chess.com/live/game/12345)',
    ]);
  });
  it('dedupes when the input URL has no recognised shape', () => {
    const ids = candidateGameIdsForUrl('https://www.chess.com/home', fakeHash);
    expect(ids).toEqual(['H(https://www.chess.com/home)']);
  });
});

describe('candidateMonths', () => {
  // Pin "now" so the test is deterministic regardless of when it runs.
  // 15 March 2026, 12:00 UTC.
  const now = new Date(Date.UTC(2026, 2, 15, 12, 0, 0));

  it('falls back to current + previous month when no hint is given', () => {
    const months = candidateMonths(undefined, now);
    expect(months).toEqual([
      { year: 2026, month: 3 },
      { year: 2026, month: 2 },
    ]);
  });
  it('puts the hint month first, then current, then previous', () => {
    // Hint is 10 January 2026.
    const hint = Date.UTC(2026, 0, 10);
    const months = candidateMonths(hint, now);
    expect(months).toEqual([
      { year: 2026, month: 1 },
      { year: 2026, month: 3 },
      { year: 2026, month: 2 },
    ]);
  });
  it('dedupes when the hint coincides with current month', () => {
    const hint = Date.UTC(2026, 2, 1); // also March 2026
    const months = candidateMonths(hint, now);
    expect(months).toEqual([
      { year: 2026, month: 3 },
      { year: 2026, month: 2 },
    ]);
  });
  it('dedupes when the hint coincides with previous month', () => {
    const hint = Date.UTC(2026, 1, 28); // February 2026
    const months = candidateMonths(hint, now);
    expect(months).toEqual([
      { year: 2026, month: 2 },
      { year: 2026, month: 3 },
    ]);
  });
  it('handles December → previous-year January correctly', () => {
    const jan = new Date(Date.UTC(2026, 0, 5, 0, 0, 0));
    const months = candidateMonths(undefined, jan);
    expect(months).toEqual([
      { year: 2026, month: 1 },
      { year: 2025, month: 12 },
    ]);
  });
  it('ignores invalid hint timestamps', () => {
    expect(candidateMonths(0, now)).toEqual([
      { year: 2026, month: 3 },
      { year: 2026, month: 2 },
    ]);
    expect(candidateMonths(NaN, now)).toEqual([
      { year: 2026, month: 3 },
      { year: 2026, month: 2 },
    ]);
    expect(candidateMonths(-1, now)).toEqual([
      { year: 2026, month: 3 },
      { year: 2026, month: 2 },
    ]);
  });
});

describe('monthArchiveUrl', () => {
  it('zero-pads single-digit months', () => {
    expect(monthArchiveUrl('hero', 2026, 3)).toBe(
      'https://api.chess.com/pub/player/hero/games/2026/03',
    );
  });
  it('passes through two-digit months', () => {
    expect(monthArchiveUrl('hero', 2026, 11)).toBe(
      'https://api.chess.com/pub/player/hero/games/2026/11',
    );
  });
  it('URL-encodes the username', () => {
    expect(monthArchiveUrl('user with space', 2026, 1)).toContain(
      'user%20with%20space',
    );
  });
});
