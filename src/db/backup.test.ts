import { describe, expect, it } from 'vitest';

/**
 * `isGzipBlob` is the load-bearing piece behind backup-format
 * detection: it lets `restoreBackup` keep working on legacy `.json`
 * backups produced before compression shipped, while picking up the
 * new `.json.gz` format transparently. Get it wrong in either
 * direction and either a fresh user with an old backup gets a
 * "BulkError: invalid format" on restore (false negative on gzip),
 * or — much worse — a plain JSON file gets passed through
 * `DecompressionStream` and explodes (false positive on gzip).
 *
 * The detector is two bytes wide. We test:
 *   - true on a real gzipped blob (round-trip via `CompressionStream`),
 *   - false on plain dexie-export JSON (which always starts with `{`),
 *   - false on tiny / empty blobs that can't possibly be gzip,
 *   - false on a blob that *coincidentally* starts with `0x1f` but
 *     not `0x8b` (the second byte must also match — keeps the
 *     detector honest if dexie-export ever changes shape).
 *
 * NOTE: the detector is re-implemented locally rather than imported
 * from `./backup` because importing the production module drags
 * `dexie-export-import` into the unit-test runtime, and that module
 * does `self.X = ...` at load time — it's a browser bundle that
 * doesn't evaluate cleanly in Node. Same convention as the sibling
 * `queries.test.ts`: the helper is one line; the value is locking
 * the *behaviour*. If a future refactor changes the detector we
 * update both copies — the integration test (`backup.mjs`) exercises
 * the real production function inside the dev-server browser, so
 * any divergence between the two surfaces immediately.
 */
async function isGzipBlob(blob: Blob): Promise<boolean> {
  if (blob.size < 2) return false;
  const head = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
  return head[0] === 0x1f && head[1] === 0x8b;
}

function makeBlob(bytes: number[]): Blob {
  return new Blob([new Uint8Array(bytes)]);
}

async function gzipBlob(input: Blob): Promise<Blob> {
  const piped = input.stream().pipeThrough(new CompressionStream('gzip'));
  return new Response(piped).blob();
}

describe('isGzipBlob', () => {
  it('returns true for a real gzip-encoded blob', async () => {
    const json = new Blob(['{"formatName":"dexie","formatVersion":1}']);
    const gz = await gzipBlob(json);
    expect(await isGzipBlob(gz)).toBe(true);
  });

  it('returns false for plain dexie-export-import JSON output (starts with `{`)', async () => {
    const json = new Blob(['{"formatName":"dexie","formatVersion":1,"data":[]}']);
    expect(await isGzipBlob(json)).toBe(false);
  });

  it('returns false for an empty blob', async () => {
    expect(await isGzipBlob(new Blob([]))).toBe(false);
  });

  it('returns false for a 1-byte blob (cannot match a 2-byte magic header)', async () => {
    expect(await isGzipBlob(makeBlob([0x1f]))).toBe(false);
  });

  it('returns false when only the first magic byte matches', async () => {
    // 0x1f followed by something other than 0x8b — must NOT be
    // mistaken for gzip, otherwise we'd hand random bytes to
    // DecompressionStream and throw a confusing error mid-restore.
    expect(await isGzipBlob(makeBlob([0x1f, 0x00]))).toBe(false);
    expect(await isGzipBlob(makeBlob([0x1f, 0x7b]))).toBe(false);
  });

  it('returns false when only the second magic byte matches', async () => {
    expect(await isGzipBlob(makeBlob([0x00, 0x8b]))).toBe(false);
  });

  it('returns true when the first two bytes are exactly the gzip magic header', async () => {
    // Edge case: a 2-byte blob that happens to be the magic header
    // but nothing after it. The detector intentionally only inspects
    // the first two bytes — full validation is delegated to
    // DecompressionStream, which will reject malformed payloads with
    // its own error. We just need to *route* the blob.
    expect(await isGzipBlob(makeBlob([0x1f, 0x8b]))).toBe(true);
  });
});
