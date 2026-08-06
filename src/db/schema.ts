import Dexie, { type EntityTable } from 'dexie';

export type Color = 'white' | 'black';
export type GameResult = 'win' | 'loss' | 'draw' | 'unknown';
export type AnalysisStatus = 'pending' | 'running' | 'done' | 'error';
export type Classification =
  | 'brilliant'
  | 'best'
  | 'excellent'
  | 'good'
  | 'book'
  | 'inaccuracy'
  | 'miss'
  | 'mistake'
  | 'blunder';

/** Game phase derived from remaining material + move number. */
export type Phase = 'opening' | 'middlegame' | 'endgame';

/**
 * Tactical motifs attached to a mistake. Kept as a closed union so UI
 * can map each to an icon/label. Any motif can be contributed by either
 * the local heuristic detector or an external source (e.g. Lichess tags).
 */
export type Motif =
  | 'hangingPiece'
  | 'fork'
  | 'pin'
  | 'skewer'
  | 'discoveredAttack'
  | 'backRank'
  | 'overloadedDefender'
  | 'trappedPiece'
  | 'missedMate'
  | 'allowedMate'
  | 'missedFork'
  | 'missedPin'
  | 'missedSkewer'
  | 'missedBackRank'
  | 'weakKing'
  | 'lostMaterial'
  | 'other';

export interface Game {
  id: string;
  url: string;
  source: 'chesscom' | 'lichess' | 'pgn';
  username: string;
  userColor: Color;
  opponent: string;
  opponentRating?: number;
  userRating?: number;
  result: GameResult;
  timeControl: string;
  timeClass?: 'bullet' | 'blitz' | 'rapid' | 'daily' | 'classical' | string;
  endTime: number;
  opening?: string;
  eco?: string;
  pgn: string;
  fen?: string;
  importedAt: number;
  analysisStatus: AnalysisStatus;
  analysisError?: string;
  accuracy?: { white: number; black: number };
  /** Cached per-game stats derived from PGN clocks at analysis time so
   *  the dashboard's "Hours played" tile doesn't have to re-parse every
   *  PGN on every render. Both are populated by the analyzer when a game
   *  finishes (`saveAnalyzedTimeStats`) and by a one-shot version-stamped
   *  backfill for games analyzed before this code shipped
   *  (`backfillUserTimeStats`). Absent on unanalyzed games and on
   *  pre-backfill done games — `totalSecondsPlayed` then falls back to
   *  the original PGN regex path so behaviour stays identical.
   *
   *  Why both fields:
   *    - `userTimeSec` is the authoritative number when `%clk` is in the
   *      PGN. Daily / correspondence games are stored as `undefined`,
   *      not `0`, so the dashboard can distinguish "we deliberately
   *      excluded this game" from "this game took zero seconds".
   *    - `userPlyCount` enables the no-clock fallback heuristic (half
   *      base + per-move offset, capped at 2× base) without re-running
   *      the regex; for clock-rich PGNs we still store it for free since
   *      we already iterated the moves. */
  userTimeSec?: number;
  userPlyCount?: number;
  /** How many `brilliant` moves the *user* played in this game. Cached
   *  onto the game row so the Games table can badge brilliancies from
   *  the light projection — the classifications themselves live in the
   *  separate `analyses` table, and reading every analysis row per
   *  render is exactly the cost `listGamesLight` exists to avoid.
   *
   *  Same denormalization + lifecycle as `accuracy`: written by the
   *  queue when a game finishes analysis, refreshed by the boot
   *  recompute pass (so a change to the brilliant rules re-stamps the
   *  library), and backfilled once for games analyzed before this
   *  shipped.
   *
   *  `undefined` means "not known yet" (unanalyzed, or analyzed before
   *  the backfill ran) and renders no badge; `0` means "analyzed, no
   *  brilliancies". Keeping those distinct is what lets the backfill be
   *  idempotent without re-reading already-stamped rows. Only the
   *  user's own moves count — a badge for the opponent's brilliancy
   *  would be actively misleading. */
  brilliantCount?: number;
}

export interface MoveEval {
  ply: number;
  san: string;
  uci?: string;
  fenBefore: string;
  fenAfter: string;
  evalCpBefore: number;
  evalCpAfter: number;
  winrateBefore: number;
  winrateAfter: number;
  bestMoveUci?: string;
  bestMoveSan?: string;
  bestEvalCp?: number;
  /** Principal variation (UCI) for the position BEFORE the move. Used to
   *  reconstruct "what the engine wanted" for puzzle generation. */
  bestPvUci?: string[];
  mateInBefore?: number;
  mateInAfter?: number;
  classification: Classification;
  depth: number;
  /** Phase this move was played in. */
  phase?: Phase;
  /** Remaining clock of the mover after the move, in seconds. Extracted
   *  from PGN `%clk` comments; absent if the PGN has no clock info. */
  clockAfter?: number;
  /** Seconds spent on this move, if derivable from clocks. */
  timeSpent?: number;
  /** Motifs attached to a mistake/blunder/inaccuracy/miss. Empty for
   *  good/best moves. Comes from the heuristic detector. */
  motifs?: Motif[];
}

export interface Analysis {
  gameId: string;
  depth: number;
  analyzedAt: number;
  engine: string;
  moves: MoveEval[];
}

/**
 * Canonical time-class values Chess.com reports. Kept narrow so the
 * filter UI renders a fixed set. Games with unrecognized classes flow
 * through as-is (stored on Game.timeClass, typed as string); the filter
 * UI only presents the canonical options.
 */
export type TimeClass = 'bullet' | 'blitz' | 'rapid' | 'daily' | 'classical';

/**
 * User-facing filter for "which time controls count as real games for
 * improvement purposes". An empty array means "no filter" (i.e. all
 * time controls). Default selection is `['rapid']` — bullet mistakes
 * are high volume / low ROI for study.
 *
 * Historically this was a single value (`TimeClass | 'all'`) but the
 * UI shifted to multi-select chips so the user can mix e.g. rapid +
 * blitz. We migrate the legacy single-value shape on read in
 * `getSettings()` (it isn't indexed, so no Dexie version bump needed).
 */
export type TimeClassSelection = TimeClass[];

/** Legacy single-value shape, still used by the type system in some
 *  pure helpers (e.g. progress charts pick *one* mode at a time). */
export type TimeClassFilter = TimeClass | 'all';

export const TIME_CLASS_ORDER: TimeClass[] = [
  'rapid',
  'blitz',
  'bullet',
  'daily',
  'classical',
];

export interface Settings {
  key: 'main';
  username: string;
  engineDepth: number;
  autoAnalyze: boolean;
  /** Puzzle solve depth for engine verification during generation. */
  puzzleGenDepth?: number;
  /** Minimum centipawn swing (from side-to-move POV) that the "best" move
   *  must gain over the played move to qualify as a puzzle source. */
  puzzleMinSwingCp?: number;
  /** Default time-class selection applied to weaknesses + puzzles
   *  pages. Stored as an array of `TimeClass` values; an empty array
   *  means "all time controls" (no filter). The Settings reader
   *  (`getSettings`) accepts the legacy single-value shape and
   *  migrates it on read. */
  timeClassFilter?: TimeClassSelection;
  /** Last version of the boot-time `recomputeClassificationsAndAccuracies`
   *  pass that ran successfully against this DB. We bump
   *  `RECOMPUTE_VERSION` in `src/db/queries.ts` whenever the classification
   *  / accuracy / motif rules change; if the stored version matches the
   *  current one, the pass is skipped on boot. This is the single biggest
   *  startup-time win for libraries with thousands of analyzed games — a
   *  full pass over 5 k games can take many seconds, and re-running it on
   *  every page reload was making the app feel frozen for the first few
   *  seconds after navigation. */
  lastRecomputeVersion?: number;
  /** Same idea for the boot-time opening-metadata refresh. Bumped only
   *  when `reparseOpeningFromPgn` changes its output for existing PGNs. */
  lastOpeningRefreshVersion?: number;
  /** Clerk user id this local DB is bound to. Set on first successful
   *  sign-in (Pass 3 of `PROJECT_STATUS.md` §10). When a *different*
   *  Clerk user signs in on the same browser profile, the profile-sync
   *  layer refuses to silently merge their data and surfaces a warning
   *  — without this we'd happily attribute one user's imported games to
   *  another's profile, which is both privacy-leaky and hard to undo.
   *  Undefined for anonymous (pre-Phase 2) DBs and for fresh installs
   *  prior to first sign-in. */
  boundClerkUserId?: string;
  /** Epoch ms when the user finished the onboarding wizard
   *  (`/onboarding`). When unset for a signed-in user, the wizard
   *  redirect fires and walks them through username confirmation +
   *  initial import. Reset to undefined when a new Clerk user binds to
   *  this device (so a fresh sign-in always lands in onboarding). */
  onboardingCompletedAt?: number;
  /** Calibrated Stockfish analysis time in milliseconds per *game*
   *  (averaged across plies) on this device, measured by the device
   *  probe (`src/engine/probe.ts`) at onboarding. Used to render honest
   *  time estimates in the import preset chooser ("~12 min") rather
   *  than guessing. Falls back to a conservative constant if the probe
   *  ever fails. */
  deviceAnalysisMsPerGame?: number;
  /** Last version of the boot-time `backfillUserTimeStats` pass that
   *  ran successfully against this DB. Same pattern as
   *  `lastRecomputeVersion` — version-stamping lets a warm boot skip
   *  the pass entirely. Bumped only when the PGN-clock derivation
   *  logic changes its output for existing games. */
  lastUserTimeBackfillVersion?: number;
  /** Last version of the boot-time `backfillBrilliantCounts` pass that
   *  ran successfully against this DB. Separate from
   *  `lastRecomputeVersion` on purpose: counting stored `brilliant`
   *  classifications is cheap, so it gets its own stamp rather than
   *  riding on the expensive full re-classification. */
  lastBrilliantBackfillVersion?: number;
  /** Epoch ms when the user dismissed the in-app "install the
   *  browser extension" promotion. Set by the dismiss button on the
   *  Settings → Browser extension card; once stamped the card
   *  collapses to a one-line "Reopen" row so the user can still
   *  reach the install link without it nagging them. Undefined =
   *  never dismissed (the default for fresh installs and for users
   *  upgrading across the 2026-05-13 release that introduced this
   *  field). Not indexed, so no Dexie version bump is required —
   *  same pattern as `onboardingCompletedAt`. */
  extensionPromoDismissedAt?: number;
  /** User-selected UI language. One of the `SupportedLocale` values
   *  in `src/i18n/index.ts` (today: `'en' | 'pt-BR'`). When undefined
   *  the i18n LanguageDetector falls back to navigator.language and
   *  then English. We store as a free-form string rather than a typed
   *  enum so adding a new locale doesn't require a schema migration —
   *  the runtime guard in `isSupportedLocale` rejects unknown values
   *  and falls back to detection. Not indexed; no Dexie version bump
   *  required (same pattern as `onboardingCompletedAt`).
   *
   *  Persistence layering: the localStorage entry written by the
   *  language picker is the load-bearing layer (read synchronously
   *  during i18next init before React mounts, so the very first paint
   *  is in the right language). This Dexie field is the secondary
   *  source-of-truth that will sync across devices once Phase 2 ships;
   *  for now it's mirrored from localStorage by the picker, and a
   *  one-shot hydration pass writes it back to localStorage on app
   *  boot so a freshly-installed device picks up the cloud-side
   *  preference once Settings finishes loading. */
  locale?: string;
  /** Default Stockfish strength used by the "Play it out vs engine"
   *  free-play flow on the practice page (kicked off from the inline
   *  CTA when an opening line completes). One of:
   *    - `'max'`  — full-strength Stockfish (depth 14, no limit).
   *    - `'2000'` / `'1600'` / `'1200'` — `UCI_LimitStrength=true` plus
   *       a Skill Level + capped depth tuned to roughly that Elo. The
   *       runtime mapping lives in `src/engine/freePlayEngine.ts`
   *       (`strengthToOptions`) and is unit-tested.
   *  Optional + non-indexed: same migration-free shape as `locale` /
   *  `extensionPromoDismissedAt`. The Dexie v10 → v11 bump only exists
   *  to satisfy the project rule that all new persistent fields go
   *  through a version bump; the v11 `.stores(...)` block is identical
   *  to v10. Unrecognised values fall through to `'max'` via
   *  `strengthToOptions` so corrupted rows or a future cloud-sync of an
   *  unknown level can't softlock the play page. */
  freePlayStrength?: 'max' | '2000' | '1600' | '1200';
}

/* =======================================================================
 *  Puzzles
 * =======================================================================
 *
 *  A puzzle is a position extracted from one of the user's own mistakes,
 *  with a known engine solution line. It's reviewed with SM-2 spaced
 *  repetition on its own schedule (independent of repertoire cards).
 */
export interface Puzzle {
  /** Stable id derived from (gameId + ply). */
  id: string;
  /** Game this puzzle was extracted from. */
  gameId: string;
  /** Ply index (1-based) of the mistake within the game. */
  ply: number;
  /** FEN of the position the user needs to solve (side-to-move = mover
   *  who made the mistake in the original game). */
  fen: string;
  /** Solution line in UCI, starting from `fen`. Even-indexed moves are
   *  the solver's; odd-indexed are opponent replies. Length >= 1. */
  solutionUci: string[];
  /** Same line in SAN (same length as solutionUci). */
  solutionSan: string[];
  /** cp eval after the solution vs cp eval after the actual played move,
   *  both from the solver's POV. Bigger = more decisive puzzle. */
  swingCp: number;
  /** Motifs attached at generation time. */
  motifs: Motif[];
  /** ISO time generated. */
  generatedAt: number;
  /** SM-2 state. Populated lazily on first review. */
  srs?: SrsState;
  /** Tags for filtering ("from-blunder", "from-miss", etc). */
  tags: string[];
  /** Game metadata snapshot for UI convenience. */
  gameUrl?: string;
  opponent?: string;
  /** Denormalized from the source game so the puzzles page can filter
   *  by time-class without a secondary table join. */
  timeClass?: string;
}

export interface SrsState {
  /** Ease factor, 1.3–2.5ish. */
  ease: number;
  /** Interval in days. */
  intervalDays: number;
  /** Number of successful reviews in a row. */
  reps: number;
  /** Epoch ms of next due date. */
  dueAt: number;
  /** Epoch ms of last review. */
  lastReviewedAt?: number;
  /** Number of times this item has lapsed (rated 'again'). */
  lapses: number;
}

/* =======================================================================
 *  Repertoire
 * =======================================================================
 *
 *  A repertoire is a directed tree of positions, keyed by FEN *and* the
 *  move that reaches that position. We store it flat: every node carries
 *  its parent FEN + the move that led here. The root node has no parent.
 *  Each repertoire is scoped to a side-to-study ('white' or 'black').
 */
/**
 * Distinguishes repertoires that the user "owns" by family (the
 * dominant case after the family-first refactor — every Sicilian line
 * lives inside one "Sicilian Defense" repertoire) from legacy
 * free-form repertoires that pre-date the refactor (kept for
 * backwards-compat, surfaced in the UI under a "Custom" group).
 *
 * A v10 migration walks every existing Repertoire and stamps `kind`
 * to `'family'` when the lines all belong to a single family, or
 * `'custom'` when they're mixed / when the user explicitly created
 * the repertoire via the legacy "New repertoire" button.
 */
export type RepertoireKind = 'family' | 'custom';

export interface Repertoire {
  id: string;
  name: string;
  color: Color;
  /** Optional high-level description ("My Sicilian Najdorf repertoire"). */
  description?: string;
  /** What this repertoire collects. `'family'` (the new default) means
   *  every line belongs to a single openings-library family — the
   *  practice page knows how to drill these by family / variation /
   *  shuffled and cross-references each line against the openings
   *  library for ECO + variation labels. `'custom'` is the legacy
   *  free-form bucket: a tree of moves the user assembled themselves,
   *  not bound to any specific family. Optional for backwards-compat
   *  with v9 rows; absent → treat as `'custom'`. */
  kind?: RepertoireKind;
  /** When `kind === 'family'`, the canonical family name from the
   *  openings library (`OpeningLine.family`). Used for grouping in the
   *  list page and as the title in the practice page. Always paired
   *  with `kind === 'family'`; left undefined for `'custom'`. */
  family?: string;
  createdAt: number;
  updatedAt: number;
  /** Timestamp of the last time the user clicked "Add every line of
   *  <family>" on the openings page and the bulk-add finished. Used by
   *  the openings page to disable the bulk-add button on subsequent
   *  visits with a "All lines added" label so the user doesn't burn a
   *  click on a no-op. Cleared implicitly when the repertoire row is
   *  deleted (the field travels with the row). Optional + non-indexed;
   *  doesn't require a Dexie version bump because it's only consumed
   *  in JS. */
  bulkLoadedAt?: number;
  /** Guided learning keeps a deliberately small active subset even when
   *  the underlying tree contains many imported lines. Optional and
   *  unindexed, so existing repertoires remain valid without migration. */
  learningMode?: 'guided' | 'all';
  /** Full UCI sequences (space-joined) selected for guided practice. */
  activeLineKeys?: string[];
}

export interface RepertoireNode {
  /** Composite id: `${repertoireId}:${fen}`. Keeps node lookup O(1). */
  id: string;
  repertoireId: string;
  /** FEN of the position this node represents. Used for lookup by board. */
  fen: string;
  /** Parent FEN, or undefined for the root. */
  parentFen?: string;
  /** UCI of the move leading from parentFen to fen. Undefined for root. */
  moveUci?: string;
  /** SAN of the same move. */
  moveSan?: string;
  /** List of child FENs — redundant with parent pointers but lets us walk
   *  down a tree without a full table scan. */
  childFens: string[];
  /** Free-form notes the user attaches to this position. */
  notes?: string;
  /** For the SIDE being studied: the "main" line out of this node. All
   *  other children are alternatives. */
  mainChildFen?: string;
  createdAt: number;
}

/** SRS card for a single "your-move" position in a repertoire. The card
 *  key is (repertoireId, fen) because the same position can appear in
 *  multiple repertoires. */
export interface RepertoireCard {
  id: string; // `${repertoireId}:${fen}`
  repertoireId: string;
  fen: string;
  /** Expected UCI response from this position (the one in your prep). */
  expectedUci: string;
  srs: SrsState;
  createdAt: number;
}

/**
 * Aggregate stats for one *full* repertoire line (root → leaf path) seen
 * by the user in the line trainer. Lines are identified by the full UCI
 * sequence joined with spaces — that is stable as long as the user
 * doesn't reorder children, which is fine for a personal tool.
 *
 * Tracks how many times the line was attempted/completed and a per-move
 * accuracy roll-up so the user can see "I screw up this Najdorf line a
 * lot" at a glance.
 */
export interface RepertoireLineStats {
  /** Composite: `${repertoireId}:${ucisJoined}`. */
  id: string;
  repertoireId: string;
  /** UCI sequence joined with single spaces. */
  uciKey: string;
  /** First N SAN tokens, cached for display. */
  sanPreview: string;
  /** Family/opening-name guess at the time stats were created (best-effort
   *  match against the openings library). Empty if unknown. */
  family?: string;
  /** Times the user has STARTED this line (clicking into it counts once). */
  attempts: number;
  /** Times the user reached the final ply without skipping. */
  completions: number;
  /** Total user moves attempted in this line across all sessions. */
  movesPlayed: number;
  /** User moves that matched the prep on first try. */
  correctMoves: number;
  /** User moves that did NOT match the prep (wrong tries). */
  wrongMoves: number;
  /** Number of attempts where the user finished without a single wrong move. */
  perfectCompletions: number;
  /** Last time the user saw this line. */
  lastPracticedAt?: number;
  createdAt: number;
}

/* =======================================================================
 *  Engine eval cache
 * =======================================================================
 *
 *  Stockfish results keyed by `(fen, depth)` so repeated positions —
 *  shared opening prefixes across a month of games, replays of the same
 *  endgame, etc. — don't re-pay the engine cost. Reads are tolerant of
 *  *deeper* hits: a depth-20 cached result satisfies a depth-16 query,
 *  matching the determinism contract documented in CLAUDE.md.
 *
 *  This table is intentionally a pure cache — nothing else in the app
 *  reads it for correctness, so we can wipe it at any time without
 *  losing user-visible state.
 */
export interface EvalCacheEntry {
  /** `${fen}|${depth}` — primary key. */
  key: string;
  /** Position FEN as Stockfish saw it (full FEN including counters). */
  fen: string;
  /** Search depth that produced this result. */
  depth: number;
  bestMoveUci: string | null;
  scoreCp: number | null;
  scoreMate: number | null;
  /** Principal variation (UCI). Capped to 10 plies on write to keep
   *  rows small; consumers that want more should re-analyze. */
  pv: string[];
  /** Epoch ms — used by future eviction policies; nothing reads it yet. */
  savedAt: number;
}

/* =======================================================================
 *  Import records (per-archive sync metadata)
 * =======================================================================
 *
 *  One row per (username, archive URL) pair. Lets the Import page show
 *  "✓ imported, 45 games, 3 days ago" next to each Chess.com month and
 *  drives the "Sync newest" one-click that auto-imports any month newer
 *  than the latest record for the current username.
 *
 *  Records are upserted at the end of each successful per-archive import.
 *  Source is kept open ('chesscom' today; 'lichess'/'pgn' later) so the
 *  same table works once we add other importers.
 */
export interface ImportRecord {
  /** Composite key: `${source}:${username}:${archiveUrl}`. */
  id: string;
  source: 'chesscom' | 'lichess' | 'pgn';
  username: string;
  /** Provider archive URL (e.g. Chess.com /pub/player/u/games/YYYY/MM). */
  archiveUrl: string;
  /** Year/month for sorting + display. */
  year: number;
  month: number;
  /** Last time this archive was pulled. */
  importedAt: number;
  /** Games returned by the API on the last pull. */
  gameCount: number;
  /** Of those, how many were new (added) on the last pull. */
  added: number;
  /** Of those, how many were already in the DB (skipped). */
  skipped: number;
}

/* =======================================================================
 *  Notes (annotations on positions)
 * =======================================================================
 */
export interface PositionNote {
  /** Composite: `${fen}`. We strip halfmove/fullmove from the FEN so that
   *  transpositions share a note. */
  fenKey: string;
  /** Original FEN that produced this note (for display/debugging). */
  fen: string;
  text: string;
  createdAt: number;
  updatedAt: number;
  /** Optional back-links: which games this position appears in. */
  gameIds?: string[];
}

export class CoachDB extends Dexie {
  games!: EntityTable<Game, 'id'>;
  analyses!: EntityTable<Analysis, 'gameId'>;
  settings!: EntityTable<Settings, 'key'>;
  puzzles!: EntityTable<Puzzle, 'id'>;
  repertoires!: EntityTable<Repertoire, 'id'>;
  repertoireNodes!: EntityTable<RepertoireNode, 'id'>;
  repertoireCards!: EntityTable<RepertoireCard, 'id'>;
  repertoireLineStats!: EntityTable<RepertoireLineStats, 'id'>;
  notes!: EntityTable<PositionNote, 'fenKey'>;
  evalCache!: EntityTable<EvalCacheEntry, 'key'>;
  importRecords!: EntityTable<ImportRecord, 'id'>;

  constructor() {
    super('chess-coach');
    this.version(1).stores({
      games:
        'id, url, username, endTime, analysisStatus, timeClass, eco, result',
      analyses: 'gameId, analyzedAt, depth',
      settings: 'key',
    });
    this.version(2)
      .stores({
        games:
          'id, url, username, endTime, analysisStatus, timeClass, eco, result',
        analyses: 'gameId, analyzedAt, depth',
        settings: 'key',
      })
      .upgrade(async (tx) => {
        await tx.table('games').toCollection().modify((g: Record<string, unknown>) => {
          delete g.chessComAccuracy;
        });
      });
    // v3: Phase 2 — add puzzles, repertoires, notes. No backfill needed;
    // the queue's boot pass will re-classify old analyses and attach
    // motifs/phase/clocks from stored PGNs on next review.
    this.version(3).stores({
      games:
        'id, url, username, endTime, analysisStatus, timeClass, eco, result',
      analyses: 'gameId, analyzedAt, depth',
      settings: 'key',
      puzzles: 'id, gameId, generatedAt, *motifs, *tags, [srs.dueAt+id]',
      repertoires: 'id, color, updatedAt',
      repertoireNodes: 'id, repertoireId, fen, parentFen',
      repertoireCards: 'id, repertoireId, fen, [srs.dueAt+id]',
      notes: 'fenKey, updatedAt',
    });
    // v4: per-line training stats (attempts, accuracy) for the lines
    // trainer. New empty table, nothing to migrate.
    this.version(4).stores({
      games:
        'id, url, username, endTime, analysisStatus, timeClass, eco, result',
      analyses: 'gameId, analyzedAt, depth',
      settings: 'key',
      puzzles: 'id, gameId, generatedAt, *motifs, *tags, [srs.dueAt+id]',
      repertoires: 'id, color, updatedAt',
      repertoireNodes: 'id, repertoireId, fen, parentFen',
      repertoireCards: 'id, repertoireId, fen, [srs.dueAt+id]',
      repertoireLineStats: 'id, repertoireId, lastPracticedAt, family',
      notes: 'fenKey, updatedAt',
    });
    // v5: persistent engine eval cache so the analysis queue dedupes
    // FEN+depth lookups across games (huge for shared opening prefixes).
    // New empty table — nothing to backfill.
    this.version(5).stores({
      games:
        'id, url, username, endTime, analysisStatus, timeClass, eco, result',
      analyses: 'gameId, analyzedAt, depth',
      settings: 'key',
      puzzles: 'id, gameId, generatedAt, *motifs, *tags, [srs.dueAt+id]',
      repertoires: 'id, color, updatedAt',
      repertoireNodes: 'id, repertoireId, fen, parentFen',
      repertoireCards: 'id, repertoireId, fen, [srs.dueAt+id]',
      repertoireLineStats: 'id, repertoireId, lastPracticedAt, family',
      notes: 'fenKey, updatedAt',
      evalCache: 'key, fen, depth, savedAt',
    });
    // v6: per-archive import metadata so the Import page can show what's
    // already been pulled and offer a one-click "Sync newest". New empty
    // table — nothing to backfill (older imports just look "never synced"
    // until the user re-clicks them, which is an idempotent no-op).
    this.version(6).stores({
      games:
        'id, url, username, endTime, analysisStatus, timeClass, eco, result',
      analyses: 'gameId, analyzedAt, depth',
      settings: 'key',
      puzzles: 'id, gameId, generatedAt, *motifs, *tags, [srs.dueAt+id]',
      repertoires: 'id, color, updatedAt',
      repertoireNodes: 'id, repertoireId, fen, parentFen',
      repertoireCards: 'id, repertoireId, fen, [srs.dueAt+id]',
      repertoireLineStats: 'id, repertoireId, lastPracticedAt, family',
      notes: 'fenKey, updatedAt',
      evalCache: 'key, fen, depth, savedAt',
      importRecords: 'id, source, username, archiveUrl, importedAt, [username+archiveUrl]',
    });
    // v7: no shape change — added optional `boundClerkUserId` to the
    // `Settings` row for Phase 2 auth (PROJECT_STATUS.md §10). Dexie
    // doesn't index that field, so nothing in `.stores(...)` differs
    // from v6. The version bump exists purely so existing DBs surface
    // the new field as `undefined` (the type contract) rather than
    // remaining stuck at the v6 type. Empty `.upgrade()` is fine —
    // there's nothing to backfill: a missing `boundClerkUserId` is
    // exactly how we represent "this DB has never seen a sign-in", and
    // the profile-sync reducer treats that case as the first-sign-in
    // path.
    this.version(7).stores({
      games:
        'id, url, username, endTime, analysisStatus, timeClass, eco, result',
      analyses: 'gameId, analyzedAt, depth',
      settings: 'key',
      puzzles: 'id, gameId, generatedAt, *motifs, *tags, [srs.dueAt+id]',
      repertoires: 'id, color, updatedAt',
      repertoireNodes: 'id, repertoireId, fen, parentFen',
      repertoireCards: 'id, repertoireId, fen, [srs.dueAt+id]',
      repertoireLineStats: 'id, repertoireId, lastPracticedAt, family',
      notes: 'fenKey, updatedAt',
      evalCache: 'key, fen, depth, savedAt',
      importRecords: 'id, source, username, archiveUrl, importedAt, [username+archiveUrl]',
    });
    // v8: same story as v7 — added `onboardingCompletedAt` and
    // `deviceAnalysisMsPerGame` to `Settings`. Neither is indexed, so
    // `.stores(...)` is unchanged. Existing DBs surface the new fields
    // as undefined; the onboarding gate treats that as "user has not
    // completed onboarding yet" and redirects them through the wizard,
    // which is the desired behaviour for users who upgraded across the
    // Phase 2 boundary.
    this.version(8).stores({
      games:
        'id, url, username, endTime, analysisStatus, timeClass, eco, result',
      analyses: 'gameId, analyzedAt, depth',
      settings: 'key',
      puzzles: 'id, gameId, generatedAt, *motifs, *tags, [srs.dueAt+id]',
      repertoires: 'id, color, updatedAt',
      repertoireNodes: 'id, repertoireId, fen, parentFen',
      repertoireCards: 'id, repertoireId, fen, [srs.dueAt+id]',
      repertoireLineStats: 'id, repertoireId, lastPracticedAt, family',
      notes: 'fenKey, updatedAt',
      evalCache: 'key, fen, depth, savedAt',
      importRecords: 'id, source, username, archiveUrl, importedAt, [username+archiveUrl]',
    });
    // v9: added `Game.userTimeSec` + `Game.userPlyCount` (cached PGN
    // clock-derived stats so the dashboard doesn't re-parse every PGN
    // on every render) and `Settings.lastUserTimeBackfillVersion` (skip
    // stamp for the one-shot backfill pass). None of those fields are
    // indexed, so `.stores(...)` is identical to v8 — Dexie just needs
    // the version bump so the type contract advances. Existing rows
    // surface `userTimeSec`/`userPlyCount` as `undefined`; the backfill
    // pass populates them on next boot, and the dashboard's
    // `totalSecondsPlayed` already prefers the cached fields and falls
    // back to PGN-parsing when missing, so behaviour is identical
    // before, during, and after the backfill.
    this.version(9).stores({
      games:
        'id, url, username, endTime, analysisStatus, timeClass, eco, result',
      analyses: 'gameId, analyzedAt, depth',
      settings: 'key',
      puzzles: 'id, gameId, generatedAt, *motifs, *tags, [srs.dueAt+id]',
      repertoires: 'id, color, updatedAt',
      repertoireNodes: 'id, repertoireId, fen, parentFen',
      repertoireCards: 'id, repertoireId, fen, [srs.dueAt+id]',
      repertoireLineStats: 'id, repertoireId, lastPracticedAt, family',
      notes: 'fenKey, updatedAt',
      evalCache: 'key, fen, depth, savedAt',
      importRecords: 'id, source, username, archiveUrl, importedAt, [username+archiveUrl]',
    });
    // v10: introduce `Repertoire.kind` + `Repertoire.family` for the
    // family-first refactor (PROJECT_STATUS.md §4). Neither field is
    // indexed, so `.stores(...)` is unchanged from v9 — the version
    // bump exists so the type contract advances and so we can run a
    // one-shot migration that **wipes** every legacy repertoire and
    // its dependent rows.
    //
    // Why wipe instead of migrate? The pre-v10 model was one big
    // 'My White Repertoire' / 'My Black Repertoire' bucket that mixed
    // multiple openings (e.g. Najdorf + French + Caro-Kann all in one
    // black repertoire). The new model is one repertoire per
    // openings-library family, and there is no robust way to
    // *automatically* split a mixed bucket back into its families
    // without inspecting every node tree, guessing which lines belong
    // together, and inventing names for the result. Anything we
    // generate would be wrong some of the time. Per the design
    // decision in PASS4_PLAN.md, we ship a clean break: nuke the
    // legacy rows and let the user rebuild via the openings library
    // (one click per family, fast).
    //
    // Wipe scope:
    //   - `repertoires`               — every row.
    //   - `repertoireNodes`           — every row (entire tree).
    //   - `repertoireCards`           — every SRS card; user loses
    //                                   spaced-repetition history but
    //                                   re-builds quickly via the
    //                                   library + new practice page.
    //   - `repertoireLineStats`       — every per-line stat row.
    //
    // We deliberately do NOT touch `games`, `analyses`, `puzzles`,
    // `settings`, `evalCache`, `notes`, or `importRecords`. The user's
    // analyzed game library + puzzle history + Clerk binding survive
    // the upgrade unchanged.
    //
    // Pattern note: the upgrade hook follows the safe pattern (see
    // CLAUDE.md gotcha) — we use `tx.table(...).clear()` inside the
    // upgrade transaction Dexie hands us, rather than reading rows
    // and writing them back. `.clear()` is a single IDB op that's
    // safe to call from inside an upgrade.
    this.version(10)
      .stores({
        games:
          'id, url, username, endTime, analysisStatus, timeClass, eco, result',
        analyses: 'gameId, analyzedAt, depth',
        settings: 'key',
        puzzles: 'id, gameId, generatedAt, *motifs, *tags, [srs.dueAt+id]',
        repertoires: 'id, color, updatedAt',
        repertoireNodes: 'id, repertoireId, fen, parentFen',
        repertoireCards: 'id, repertoireId, fen, [srs.dueAt+id]',
        repertoireLineStats: 'id, repertoireId, lastPracticedAt, family',
        notes: 'fenKey, updatedAt',
        evalCache: 'key, fen, depth, savedAt',
        importRecords:
          'id, source, username, archiveUrl, importedAt, [username+archiveUrl]',
      })
      .upgrade(async (tx) => {
        await tx.table('repertoires').clear();
        await tx.table('repertoireNodes').clear();
        await tx.table('repertoireCards').clear();
        await tx.table('repertoireLineStats').clear();
      });

    // v11: introduces `Settings.freePlayStrength` for the
    // "Play it out vs engine" practice-page free-play flow. The field
    // is optional + non-indexed, so the schema strings are identical
    // to v10 and there's no upgrade hook needed — Dexie carries the
    // existing row forward and any read-side default lives in the
    // strength-mapping helper. We bump anyway because the project
    // convention (CLAUDE.md) is that all new persistent Settings
    // fields go through a Dexie version bump so the schema history
    // makes the addition discoverable without diffing the interface.
    this.version(11).stores({
      games:
        'id, url, username, endTime, analysisStatus, timeClass, eco, result',
      analyses: 'gameId, analyzedAt, depth',
      settings: 'key',
      puzzles: 'id, gameId, generatedAt, *motifs, *tags, [srs.dueAt+id]',
      repertoires: 'id, color, updatedAt',
      repertoireNodes: 'id, repertoireId, fen, parentFen',
      repertoireCards: 'id, repertoireId, fen, [srs.dueAt+id]',
      repertoireLineStats: 'id, repertoireId, lastPracticedAt, family',
      notes: 'fenKey, updatedAt',
      evalCache: 'key, fen, depth, savedAt',
      importRecords:
        'id, source, username, archiveUrl, importedAt, [username+archiveUrl]',
    });
  }
}

export const db = new CoachDB();

export async function getSettings(): Promise<Settings> {
  const existing = await db.settings.get('main');
  if (existing) {
    // Legacy single-value shape (`'rapid'` / `'all'` / `undefined`)
    // gets normalized to a `TimeClassSelection` here so call sites
    // can assume the array shape without a Dexie migration. The
    // Settings table isn't indexed by this field so re-writing
    // legacy rows in-place is safe.
    const raw = existing.timeClassFilter as unknown;
    const normalized = normalizeTimeClassSelection(raw);
    if (!Array.isArray(raw)) {
      const migrated: Settings = { ...existing, timeClassFilter: normalized };
      await db.settings.put(migrated);
      return migrated;
    }
    return existing;
  }
  const defaults: Settings = {
    key: 'main',
    username: '',
    engineDepth: 16,
    autoAnalyze: true,
    puzzleGenDepth: 18,
    puzzleMinSwingCp: 200,
    timeClassFilter: ['rapid'],
  };
  await db.settings.put(defaults);
  return defaults;
}

/**
 * Normalize whatever lives at `Settings.timeClassFilter` to the canonical
 * array shape:
 *   - `undefined` / `null`      → `['rapid']` (legacy default)
 *   - `'all'`                   → `[]` (= all time classes / no filter)
 *   - `'rapid'` / 'blitz' / etc → `['rapid']`
 *   - `[]`                      → `[]`
 *   - `['rapid','blitz']`       → `['rapid','blitz']` (deduped, ordered)
 *
 * Exported because the same migration runs at the *page* layer when a
 * component reads its own piece of Settings (we don't always go through
 * `getSettings`).
 */
export function normalizeTimeClassSelection(raw: unknown): TimeClassSelection {
  const VALID: TimeClass[] = ['rapid', 'blitz', 'bullet', 'daily', 'classical'];
  if (raw == null) return ['rapid'];
  if (Array.isArray(raw)) {
    const seen = new Set<string>();
    const out: TimeClass[] = [];
    for (const v of raw) {
      if (typeof v !== 'string') continue;
      if (!VALID.includes(v as TimeClass)) continue;
      if (seen.has(v)) continue;
      seen.add(v);
      out.push(v as TimeClass);
    }
    return out;
  }
  if (typeof raw === 'string') {
    if (raw === 'all') return [];
    if (VALID.includes(raw as TimeClass)) return [raw as TimeClass];
  }
  return ['rapid'];
}

export async function updateSettings(patch: Partial<Omit<Settings, 'key'>>): Promise<void> {
  const current = await getSettings();
  await db.settings.put({ ...current, ...patch });
}
