// Type surface for the openings build script, consumed by the unit-tier
// coherence test (`src/data/openings.generated.test.ts`). The script
// itself stays plain JS (.mjs); this only declares its public exports so
// `tsc` doesn't treat the import as `any`.

export interface BuiltBundle {
  banner: string;
  body: string;
  records: unknown[];
  families: unknown[];
  skipped: number;
  unranked: number;
}

/** Reads the committed TSVs and returns the exact text of
 *  `openings.generated.ts`, split into a timestamped banner and a
 *  deterministic body. */
export function buildBundle(): BuiltBundle;

/** Absolute path to the committed generated bundle. */
export const OUT_FILE: string;

/** Prefix of the banner's nondeterministic `// Generated <ISO>` line. */
export const GENERATED_TIMESTAMP_PREFIX: string;

/** Parse a line-popularity TSV into a map keyed by space-joined UCI. */
export function parseLinePopularityTsv(
  text: string,
): Map<string, { globalGames: number; globalShare: number }>;
