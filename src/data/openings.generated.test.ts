import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// The generator is a build script (.mjs), imported here for its pure
// `buildBundle()` seam. It reads only committed files under data/openings/
// and touches nothing in Dexie/IndexedDB/workers, so it is safe in the
// unit tier (see vitest.config.ts conventions).
import {
  buildBundle,
  OUT_FILE,
  GENERATED_TIMESTAMP_PREFIX,
} from '../../scripts/build-openings.mjs';

/**
 * Coherence guard.
 *
 * The bug this pins: `src/data/openings.generated.ts` once shipped built
 * from an OLDER copy of `data/openings/line-popularity.tsv` than the one
 * committed beside it — 3406 of 3690 lines disagreed, so every
 * frequency-derived number in the app (opening suggestions, and now the
 * difficulty tiers) was quietly wrong. A scheduled refresh makes that
 * class of incoherence MORE likely, not less, unless something fails the
 * build when the committed bundle no longer matches its inputs.
 *
 * `openings:build` is entirely offline over committed TSVs, so we can
 * rebuild in memory and compare. The only nondeterministic part is the
 * banner's `// Generated <ISO timestamp>` line, which we strip from both
 * sides before comparing.
 *
 * If this fails: run `npm run openings:build` and commit the result.
 */
function stripTimestamp(source: string): string {
  return source
    .split('\n')
    .filter((line) => !line.startsWith(GENERATED_TIMESTAMP_PREFIX))
    .join('\n');
}

/** Both sides are ~1 MB single-line arrays, so `expect(a).toBe(b)` would
 *  dump a multi-megabyte character diff that buries the signal. Instead we
 *  locate the first divergence and quote a short window around it. */
function firstDivergence(a: string, b: string): string {
  const min = Math.min(a.length, b.length);
  let i = 0;
  while (i < min && a[i] === b[i]) i++;
  if (i === min && a.length === b.length) return '';
  const from = Math.max(0, i - 40);
  return (
    `first difference at offset ${i} ` +
    `(committed ${a.length} vs rebuilt ${b.length} chars)\n` +
    `  committed: …${a.slice(from, i + 40)}…\n` +
    `  rebuilt:   …${b.slice(from, i + 40)}…`
  );
}

describe('openings.generated.ts coherence', () => {
  it('matches a fresh rebuild from the committed TSVs', () => {
    const committed = stripTimestamp(readFileSync(OUT_FILE, 'utf8'));
    const { banner, body } = buildBundle();
    const rebuilt = stripTimestamp(banner + body);
    const diff = firstDivergence(committed, rebuilt);
    expect(
      diff,
      `openings.generated.ts is stale — run \`npm run openings:build\` and ` +
        `commit the result.\n${diff}`,
    ).toBe('');
  });
});
