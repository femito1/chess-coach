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
 * improvement purposes". Defaults to 'rapid' — bullet mistakes are high
 * volume / low ROI for study.
 */
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
  /** Default time-class filter applied to weaknesses + puzzles pages. */
  timeClassFilter?: TimeClassFilter;
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
export interface Repertoire {
  id: string;
  name: string;
  color: Color;
  /** Optional high-level description ("My Sicilian Najdorf repertoire"). */
  description?: string;
  createdAt: number;
  updatedAt: number;
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
  }
}

export const db = new CoachDB();

export async function getSettings(): Promise<Settings> {
  const existing = await db.settings.get('main');
  if (existing) return existing;
  const defaults: Settings = {
    key: 'main',
    username: '',
    engineDepth: 16,
    autoAnalyze: true,
    puzzleGenDepth: 18,
    puzzleMinSwingCp: 200,
    timeClassFilter: 'rapid',
  };
  await db.settings.put(defaults);
  return defaults;
}

export async function updateSettings(patch: Partial<Omit<Settings, 'key'>>): Promise<void> {
  const current = await getSettings();
  await db.settings.put({ ...current, ...patch });
}
