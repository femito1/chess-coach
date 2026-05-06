import { describe, expect, it } from 'vitest';
import { emailLocalPart, suggestUsernameCandidates } from './suggestUsername';

describe('suggestUsernameCandidates', () => {
  it('orders username > firstName > emailLocalPart and drops empty', () => {
    expect(
      suggestUsernameCandidates({
        username: 'magnus',
        firstName: 'Magnus',
        primaryEmailLocalPart: 'm.carlsen',
      }),
    ).toEqual(['magnus', 'm.carlsen']); // firstName collapses with username after lowercasing-and-trimming-and-dedup
  });

  it('keeps firstName-lowercased when it differs from username', () => {
    expect(
      suggestUsernameCandidates({
        username: 'gmhikaru',
        firstName: 'Hikaru',
        primaryEmailLocalPart: 'hikaru.nakamura',
      }),
    ).toEqual(['gmhikaru', 'hikaru', 'hikaru.nakamura']);
  });

  it('drops candidates shorter than 3 characters', () => {
    expect(
      suggestUsernameCandidates({
        username: 'a',
        firstName: 'Bo',
        primaryEmailLocalPart: 'co',
      }),
    ).toEqual([]);
  });

  it('handles missing fields gracefully', () => {
    expect(suggestUsernameCandidates({})).toEqual([]);
    expect(
      suggestUsernameCandidates({ username: undefined, firstName: null }),
    ).toEqual([]);
  });

  it('dedupes case-insensitively', () => {
    expect(
      suggestUsernameCandidates({
        username: 'MagnusC',
        firstName: 'magnusc',
        primaryEmailLocalPart: 'magnusc',
      }),
    ).toEqual(['MagnusC']);
  });

  it('returns only the valid candidates when some are too short', () => {
    expect(
      suggestUsernameCandidates({
        username: 'm',
        firstName: 'Magnus',
        primaryEmailLocalPart: 'mc',
      }),
    ).toEqual(['magnus']);
  });

  it('trims surrounding whitespace', () => {
    expect(
      suggestUsernameCandidates({
        username: '  magnus  ',
        firstName: undefined,
        primaryEmailLocalPart: undefined,
      }),
    ).toEqual(['magnus']);
  });
});

describe('emailLocalPart', () => {
  it('extracts the segment before @', () => {
    expect(emailLocalPart('alice@example.com')).toBe('alice');
  });

  it('returns undefined for malformed input', () => {
    expect(emailLocalPart('no-at-sign')).toBeUndefined();
    expect(emailLocalPart('@no-local')).toBeUndefined();
    expect(emailLocalPart('')).toBeUndefined();
    expect(emailLocalPart(null)).toBeUndefined();
    expect(emailLocalPart(undefined)).toBeUndefined();
  });

  it('trims surrounding whitespace and rejects whitespace-only', () => {
    expect(emailLocalPart('  alice@example.com')).toBe('alice');
    expect(emailLocalPart('   @example.com')).toBeUndefined();
  });
});
