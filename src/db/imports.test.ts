import { describe, expect, it } from 'vitest';
import { isImportComplete } from './imports';

describe('isImportComplete', () => {
  const oct2026 = { year: 2026, month: 10 };

  it('treats a missing record as needing an import', () => {
    expect(isImportComplete(undefined)).toBe(false);
  });

  // The bug: any record counted as done, so the month being played in
  // was never offered again and "Sync newest" picked old months instead.
  it('keeps the current month open however recently it was imported', () => {
    const importedAt = Date.UTC(2026, 9, 14, 12); // 14 Oct 2026
    expect(isImportComplete({ ...oct2026, importedAt })).toBe(false);
  });

  it('keeps a past month open when its import predates the month end', () => {
    const importedAt = Date.UTC(2026, 9, 31, 23, 59);
    expect(isImportComplete({ ...oct2026, importedAt })).toBe(false);
  });

  // Chess.com caches archives, so an import just after midnight can still
  // miss the month's last games.
  it('waits out the grace period after the month ends', () => {
    expect(
      isImportComplete({ ...oct2026, importedAt: Date.UTC(2026, 10, 1, 1) }),
    ).toBe(false);
    expect(
      isImportComplete({ ...oct2026, importedAt: Date.UTC(2026, 10, 2, 1) }),
    ).toBe(true);
  });

  it('handles December rolling into the next year', () => {
    const dec = { year: 2025, month: 12 };
    expect(isImportComplete({ ...dec, importedAt: Date.UTC(2025, 11, 31) })).toBe(false);
    expect(isImportComplete({ ...dec, importedAt: Date.UTC(2026, 0, 3) })).toBe(true);
  });
});
