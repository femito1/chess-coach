/**
 * Pure logic for the `/repertoire/:id/drill` session controller. The page
 * picks a list of selected line indices + a mode, and we tell it which
 * line index to drill next given the previous outcome. By keeping this
 * logic pure we can unit-test the three modes without spinning up the
 * full LineRunner / browser stack.
 *
 * Modes:
 *
 *   - 'sequential'         — go through the selected lines in their
 *                            given order, wrapping when the end is
 *                            reached. Predictable; matches what the
 *                            old line trainer's "Next line" button did.
 *
 *   - 'random'             — each next line is a uniform pick from the
 *                            selected set, with one rule: try not to
 *                            repeat the line we just finished if there
 *                            are >= 2 lines to choose from. Otherwise
 *                            drilling becomes "play the same line twice
 *                            in a row" too often, which the user noticed
 *                            in the old per-family shuffle.
 *
 *   - 'repeat-until-perfect' — keep cycling the selected lines until
 *                            *every* line has been completed perfectly
 *                            (no wrong moves, no hints) within the
 *                            current session. Lines that finish
 *                            imperfectly are returned to the queue;
 *                            lines that finish perfectly are crossed
 *                            off. Sessional: closing the page resets
 *                            the "perfect-this-session" set.
 *
 * The controller is a pure function over `(state, event) -> nextState`
 * — no React, no Dexie. The page wraps it in `useReducer`.
 */

export type PracticeMode = 'sequential' | 'random' | 'repeat-until-perfect';

export interface PracticeSessionState {
  mode: PracticeMode;
  /** Indices into the parent page's `lines` array. Practice never
   *  walks a line not in this set (closed under `selectedIndices`). */
  selectedIndices: number[];
  /** The line currently in the runner, or `null` when the session is
   *  finished (only happens for `repeat-until-perfect` once every
   *  selected line has been done perfectly). */
  currentIndex: number | null;
  /** Lines completed **perfectly** within this session. Used by
   *  `repeat-until-perfect` to know when to stop. Always a subset of
   *  `selectedIndices`. */
  perfectThisSession: number[];
  /** Total lines played (any outcome) within this session. Surfaced
   *  in the UI as "X plays this session". */
  sessionPlays: number;
  /** RNG seed for deterministic random mode. The page initialises
   *  this to `Date.now()` (or a test-supplied number). */
  randSeed: number;
}

export interface SessionInit {
  mode: PracticeMode;
  selectedIndices: number[];
  /** Optional seed for the random walk; tests pass a fixed number. */
  randSeed?: number;
  /** Where to start. Defaults to the first index in `selectedIndices`,
   *  or `null` if the selection is empty. */
  startAt?: number;
}

export function initSession(input: SessionInit): PracticeSessionState {
  const sel = dedupAndSort(input.selectedIndices);
  let current: number | null = null;
  if (sel.length > 0) {
    current = input.startAt != null && sel.includes(input.startAt)
      ? input.startAt
      : sel[0];
  }
  return {
    mode: input.mode,
    selectedIndices: sel,
    currentIndex: current,
    perfectThisSession: [],
    sessionPlays: 0,
    randSeed: input.randSeed ?? Date.now(),
  };
}

export interface FinishedEvent {
  type: 'finished';
  /** Was the just-finished line played without a single wrong move
   *  AND without using a hint? Maps directly to LineRunner's
   *  `onLineFinished({ perfect })`. */
  perfect: boolean;
}

export interface SkipEvent {
  type: 'skip';
}

export interface ChangeModeEvent {
  type: 'changeMode';
  mode: PracticeMode;
}

export interface ChangeSelectionEvent {
  type: 'changeSelection';
  selectedIndices: number[];
}

export interface JumpToEvent {
  type: 'jumpTo';
  index: number;
}

export type SessionEvent =
  | FinishedEvent
  | SkipEvent
  | ChangeModeEvent
  | ChangeSelectionEvent
  | JumpToEvent;

export function reduceSession(
  state: PracticeSessionState,
  event: SessionEvent,
): PracticeSessionState {
  switch (event.type) {
    case 'finished': {
      const sessionPlays = state.sessionPlays + 1;
      const perfect = event.perfect;
      let perfectThisSession = state.perfectThisSession;
      if (
        state.mode === 'repeat-until-perfect' &&
        perfect &&
        state.currentIndex != null &&
        !perfectThisSession.includes(state.currentIndex)
      ) {
        perfectThisSession = [...perfectThisSession, state.currentIndex];
      }
      const next = pickNext(
        { ...state, perfectThisSession, sessionPlays },
      );
      return {
        ...state,
        sessionPlays,
        perfectThisSession,
        currentIndex: next,
      };
    }
    case 'skip': {
      // Skip = treat as a non-perfect finish that doesn't bump session
      // plays (the user explicitly *didn't* play it). Same routing
      // logic — pick the next line per mode.
      const next = pickNext(state);
      return { ...state, currentIndex: next };
    }
    case 'changeMode': {
      // Reset the perfect-this-session set when transitioning to or
      // from `repeat-until-perfect` so the UI doesn't keep stale
      // crosses from a previous mode.
      return {
        ...state,
        mode: event.mode,
        perfectThisSession: [],
        currentIndex: state.currentIndex ?? state.selectedIndices[0] ?? null,
      };
    }
    case 'changeSelection': {
      const sel = dedupAndSort(event.selectedIndices);
      // Drop any "perfect" entries the user removed from the selection.
      const perfectThisSession = state.perfectThisSession.filter((i) =>
        sel.includes(i),
      );
      // If the current line was deselected (or the selection is now
      // empty) jump to the next valid one.
      let currentIndex: number | null = state.currentIndex;
      if (currentIndex == null || !sel.includes(currentIndex)) {
        currentIndex = sel.length > 0 ? sel[0] : null;
      }
      return {
        ...state,
        selectedIndices: sel,
        perfectThisSession,
        currentIndex,
      };
    }
    case 'jumpTo': {
      if (!state.selectedIndices.includes(event.index)) return state;
      return { ...state, currentIndex: event.index };
    }
  }
}

/**
 * Pure picker shared by `finished` + `skip`. Returns the next line
 * index given the just-updated state, or `null` if the session is
 * complete (only possible in `repeat-until-perfect`).
 */
function pickNext(state: PracticeSessionState): number | null {
  const { mode, selectedIndices: sel, perfectThisSession } = state;
  if (sel.length === 0) return null;

  if (mode === 'sequential') {
    if (state.currentIndex == null) return sel[0];
    const pos = sel.indexOf(state.currentIndex);
    if (pos < 0) return sel[0];
    return sel[(pos + 1) % sel.length];
  }

  if (mode === 'random') {
    if (sel.length === 1) return sel[0];
    // Mulberry32 \u2014 deterministic, fast, seedable so tests are
    // reproducible. Mutating the seed in `state.randSeed` would be
    // ideal but reducers must be pure; we derive a fresh sample by
    // advancing the seed *deterministically* via the count of session
    // plays, so two calls for the same `(seed, sessionPlays)` always
    // return the same index. That's good enough for a UI random walk.
    let candidate = sampleIndex(
      state.randSeed + state.sessionPlays,
      sel.length,
    );
    if (sel[candidate] === state.currentIndex) {
      candidate = (candidate + 1) % sel.length;
    }
    return sel[candidate];
  }

  // 'repeat-until-perfect'
  const pending = sel.filter((i) => !perfectThisSession.includes(i));
  if (pending.length === 0) return null;
  // Walk the queue cyclically: prefer something other than the line
  // we just finished if there are alternatives.
  const cur = state.currentIndex;
  if (cur == null) return pending[0];
  const after = pending.find((i) => sel.indexOf(i) > sel.indexOf(cur));
  if (after != null) return after;
  return pending[0];
}

function sampleIndex(seed: number, modulus: number): number {
  // Mulberry32 in one expression: avalanches a 32-bit seed enough for
  // UI purposes. Out-of-line tests pin the exact mapping; if you ever
  // want to change the algorithm, update the tests too.
  let s = seed | 0;
  s = (s + 0x6d2b79f5) | 0;
  let t = Math.imul(s ^ (s >>> 15), 1 | s);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  const r = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return Math.floor(r * modulus);
}

function dedupAndSort(indices: number[]): number[] {
  const seen = new Set<number>();
  for (const i of indices) {
    if (Number.isInteger(i) && i >= 0) seen.add(i);
  }
  return Array.from(seen).sort((a, b) => a - b);
}

/**
 * Surfaced label for the mode picker. Kept here (not in the page) so
 * unit tests can pin the wording.
 */
export const PRACTICE_MODE_LABEL: Record<PracticeMode, string> = {
  sequential: 'Sequential',
  random: 'Shuffle',
  'repeat-until-perfect': 'Repeat until perfect',
};

export const PRACTICE_MODE_DESCRIPTION: Record<PracticeMode, string> = {
  sequential:
    'Play the selected lines in order, wrapping back to the first when you reach the end.',
  random:
    'Pick a random selected line each time. Avoids repeating the same line twice in a row when possible.',
  'repeat-until-perfect':
    'Cycle the selected lines, crossing each one off only when you finish it without a single wrong move or hint. Session ends when every selected line is perfect.',
};
