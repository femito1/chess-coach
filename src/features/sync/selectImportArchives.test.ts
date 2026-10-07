import { describe, expect, it } from 'vitest';
import { selectImportArchives } from './selectImportArchives';

const base = 'https://api.chess.com/pub/player/someone/games';
const archives = [
  `${base}/2025/12`,
  `${base}/2026/01`,
  `${base}/2026/07`,
  `${base}/2026/08`,
  `${base}/2026/09`,
  `${base}/2026/10`,
];

const utc = (iso: string) => new Date(iso).getTime();

describe('selectImportArchives', () => {
  it('re-reads the anchor month and the one before it, newest first', () => {
    expect(selectImportArchives(archives, utc('2026-10-03T12:00:00Z'))).toEqual([
      `${base}/2026/10`,
      `${base}/2026/09`,
    ]);
  });

  /** The reason the rule is anchored rather than "last N months". */
  it('heals a gap: every archive after a stale anchor is selected', () => {
    expect(selectImportArchives(archives, utc('2026-08-20T12:00:00Z'))).toEqual([
      `${base}/2026/10`,
      `${base}/2026/09`,
      `${base}/2026/08`,
      `${base}/2026/07`,
    ]);
  });

  it('steps back across a year boundary', () => {
    expect(selectImportArchives(archives, utc('2026-01-02T00:00:00Z'))).toEqual([
      `${base}/2026/10`,
      `${base}/2026/09`,
      `${base}/2026/08`,
      `${base}/2026/07`,
      `${base}/2026/01`,
      `${base}/2025/12`,
    ]);
  });

  /** The laptop's timezone must not move the anchor: 23:30 on 30 Sep in
   *  Rome is still September, but 00:30 on 1 Oct in UTC+2 is 22:30 UTC on
   *  30 Sep — September, not October. */
  it('reads the anchor month in UTC', () => {
    expect(selectImportArchives(archives, utc('2026-10-01T00:30:00+02:00'))).toEqual([
      `${base}/2026/10`,
      `${base}/2026/09`,
      `${base}/2026/08`,
    ]);
  });

  it('never makes a first import on its own', () => {
    expect(selectImportArchives(archives, null)).toEqual([]);
    expect(selectImportArchives(archives, Number.NaN)).toEqual([]);
  });

  it('drops archive URLs it cannot parse', () => {
    expect(
      selectImportArchives([`${base}/2026/10`, 'https://example.com/junk'], utc('2026-10-05T00:00:00Z')),
    ).toEqual([`${base}/2026/10`]);
  });
});
