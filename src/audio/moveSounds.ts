/**
 * Move sounds: the chess.com-style cue set (move, capture, castle,
 * promotion, check, game end, illegal), synthesized in the browser.
 *
 * **Why synthesized rather than sampled.** chess.com's audio files are their
 * copyrighted assets; shipping them here would be redistributing someone
 * else's work. So these are built from oscillators and filtered noise at
 * play time: nothing to license, nothing added to the bundle, and no network
 * request on the first move of a session. If you ever want real samples,
 * `playMoveSound` is the only function to change — decode a buffer per kind
 * and play it instead of calling `synthesize`. The rest of the app talks to
 * this module through `MoveSoundKind` and never knows the difference.
 *
 * The classifier (`classifyMoveSound`) is pure and separately tested; the
 * playback half touches Web Audio and is a no-op wherever that's missing
 * (unit tests, SSR), so importing this module is always safe.
 */

import { Chess } from 'chess.js';
import { readPersistedValue, persistedStorageKey } from '@/lib/usePersistedState';

export type MoveSoundKind =
  | 'move'
  | 'capture'
  | 'castle'
  | 'promote'
  | 'check'
  | 'gameEnd'
  | 'illegal';

/** Same key/version scheme as `usePersistedState`, so the Settings toggle
 *  and this module read and write exactly the same entry. Read
 *  synchronously here because sounds fire inside event handlers, which is
 *  also why this preference lives in localStorage rather than the (async,
 *  synced) `Settings` row. */
export const MOVE_SOUNDS_PREF_KEY = 'board.moveSounds';
const MOVE_SOUNDS_PREF_VERSION = 1;

function isBoolean(raw: unknown): raw is boolean {
  return typeof raw === 'boolean';
}

/** Are move sounds on? Defaults to true — a chess board that clicks is the
 *  expectation, and the Settings page can turn it off. */
export function moveSoundsEnabled(): boolean {
  return readPersistedValue(
    persistedStorageKey(MOVE_SOUNDS_PREF_KEY, MOVE_SOUNDS_PREF_VERSION),
    true,
    isBoolean,
  );
}

/** Count of pieces on a board, from the FEN's placement field alone. */
function pieceCount(fen: string): number {
  const placement = fen.split(' ')[0] ?? '';
  let n = 0;
  for (const ch of placement) {
    if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z')) n++;
  }
  return n;
}

export interface MoveSoundInput {
  /** Position the move was played from. Optional: without it a capture
   *  can't be detected and the move sounds like an ordinary move. */
  fenBefore?: string;
  /** Position after the move. */
  fenAfter: string;
  /** The move in UCI (`e2e4`, `e7e8q`). */
  uci: string;
}

/**
 * Which cue a move earns. Precedence, highest first:
 *
 *   gameEnd — the move ended the game (mate, stalemate, draw)
 *   check   — it gave check (beats capture, as on chess.com: a capture with
 *             check announces the check, which is the thing you must react to)
 *   promote — a pawn became a piece
 *   castle  — the king travelled two files
 *   capture — a piece left the board
 *   move    — everything else
 *
 * Falls back to `'move'` for anything unparseable, so a malformed FEN makes
 * a plain click rather than throwing inside a board render.
 */
export function classifyMoveSound(input: MoveSoundInput): MoveSoundKind {
  const { fenBefore, fenAfter, uci } = input;
  let chess: Chess;
  try {
    chess = new Chess(fenAfter);
  } catch {
    return 'move';
  }

  if (chess.isCheckmate() || chess.isDraw() || chess.isStalemate()) {
    return 'gameEnd';
  }
  if (chess.inCheck()) return 'check';
  if (uci.length >= 5) return 'promote';

  const from = uci.slice(0, 2);
  const to = uci.slice(2, 4);
  const moved = (() => {
    try {
      return chess.get(to as never);
    } catch {
      return undefined;
    }
  })();
  if (
    moved?.type === 'k' &&
    Math.abs(from.charCodeAt(0) - to.charCodeAt(0)) >= 2
  ) {
    return 'castle';
  }

  if (fenBefore && pieceCount(fenAfter) < pieceCount(fenBefore)) {
    return 'capture';
  }
  return 'move';
}

/* ----------------------------- playback ------------------------------ */

let ctx: AudioContext | null = null;
let noise: AudioBuffer | null = null;

/** Lazily created on the first sound, which is always downstream of a user
 *  gesture — browsers refuse to start audio otherwise. */
function audio(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!Ctor) return null;
  if (!ctx) {
    try {
      ctx = new Ctor();
    } catch {
      return null;
    }
  }
  // A context can be suspended by autoplay policy, or after the tab is
  // backgrounded. Resuming is idempotent and cheap.
  if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
  return ctx;
}

/** ~200 ms of white noise, reused for every percussive click. */
function noiseBuffer(c: AudioContext): AudioBuffer {
  if (noise && noise.sampleRate === c.sampleRate) return noise;
  const frames = Math.floor(c.sampleRate * 0.2);
  const buf = c.createBuffer(1, frames, c.sampleRate);
  const data = buf.getChannelData(0);
  // Deterministic pseudo-noise: a plain LCG rather than Math.random, so the
  // click sounds identical every time (and nothing here depends on the
  // global RNG).
  let seed = 0x2f6e2b1;
  for (let i = 0; i < frames; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    data[i] = (seed / 0x3fffffff) - 1;
  }
  noise = buf;
  return buf;
}

/** A filtered noise burst — the "wood" in a piece landing. */
function click(
  c: AudioContext,
  out: AudioNode,
  at: number,
  opts: { gain: number; freq: number; decay: number; q?: number },
): void {
  const src = c.createBufferSource();
  src.buffer = noiseBuffer(c);
  const band = c.createBiquadFilter();
  band.type = 'bandpass';
  band.frequency.value = opts.freq;
  band.Q.value = opts.q ?? 1.2;
  const env = c.createGain();
  env.gain.setValueAtTime(opts.gain, at);
  env.gain.exponentialRampToValueAtTime(0.0001, at + opts.decay);
  src.connect(band).connect(env).connect(out);
  src.start(at);
  src.stop(at + opts.decay + 0.02);
}

/** A short pitched body — the "thump" under the click, or a blip/tone. */
function tone(
  c: AudioContext,
  out: AudioNode,
  at: number,
  opts: {
    gain: number;
    freq: number;
    decay: number;
    type?: OscillatorType;
    endFreq?: number;
  },
): void {
  const osc = c.createOscillator();
  osc.type = opts.type ?? 'sine';
  osc.frequency.setValueAtTime(opts.freq, at);
  if (opts.endFreq != null) {
    osc.frequency.exponentialRampToValueAtTime(opts.endFreq, at + opts.decay);
  }
  const env = c.createGain();
  env.gain.setValueAtTime(0.0001, at);
  env.gain.exponentialRampToValueAtTime(opts.gain, at + 0.005);
  env.gain.exponentialRampToValueAtTime(0.0001, at + opts.decay);
  osc.connect(env).connect(out);
  osc.start(at);
  osc.stop(at + opts.decay + 0.02);
}

/** Master level. Deliberately low: this fires on every move, and a board
 *  that clicks loudly gets muted by the user within a minute. */
const MASTER_GAIN = 0.28;

function synthesize(c: AudioContext, kind: MoveSoundKind): void {
  const master = c.createGain();
  master.gain.value = MASTER_GAIN;
  master.connect(c.destination);
  const t0 = c.currentTime + 0.001;

  switch (kind) {
    case 'move':
      click(c, master, t0, { gain: 0.9, freq: 1250, decay: 0.055 });
      tone(c, master, t0, { gain: 0.35, freq: 190, decay: 0.07 });
      break;
    case 'capture':
      // Lower, grittier, a touch longer — something left the board.
      click(c, master, t0, { gain: 1, freq: 620, decay: 0.1, q: 0.7 });
      click(c, master, t0 + 0.012, { gain: 0.6, freq: 1500, decay: 0.06 });
      tone(c, master, t0, { gain: 0.4, freq: 120, decay: 0.11 });
      break;
    case 'castle':
      // Two pieces, so two clicks.
      click(c, master, t0, { gain: 0.75, freq: 1250, decay: 0.05 });
      tone(c, master, t0, { gain: 0.3, freq: 190, decay: 0.06 });
      click(c, master, t0 + 0.085, { gain: 0.85, freq: 1100, decay: 0.055 });
      tone(c, master, t0 + 0.085, { gain: 0.32, freq: 170, decay: 0.07 });
      break;
    case 'promote':
      click(c, master, t0, { gain: 0.6, freq: 1250, decay: 0.05 });
      tone(c, master, t0, { gain: 0.28, freq: 660, decay: 0.09 });
      tone(c, master, t0 + 0.075, { gain: 0.3, freq: 990, decay: 0.12 });
      break;
    case 'check':
      click(c, master, t0, { gain: 0.7, freq: 1400, decay: 0.05 });
      tone(c, master, t0 + 0.01, { gain: 0.3, freq: 950, decay: 0.08 });
      tone(c, master, t0 + 0.085, { gain: 0.28, freq: 1300, decay: 0.1 });
      break;
    case 'gameEnd':
      tone(c, master, t0, { gain: 0.3, freq: 660, decay: 0.16 });
      tone(c, master, t0 + 0.13, { gain: 0.3, freq: 550, decay: 0.16 });
      tone(c, master, t0 + 0.26, { gain: 0.32, freq: 440, decay: 0.26 });
      break;
    case 'illegal':
      // Low buzz. Distinct from every "something happened" cue above,
      // because it means the opposite: nothing happened.
      tone(c, master, t0, {
        gain: 0.22,
        freq: 150,
        endFreq: 110,
        decay: 0.13,
        type: 'square',
      });
      break;
  }
}

/**
 * Play a cue. Silent when the user has turned sounds off, and a no-op
 * (never a throw) when Web Audio isn't available — a board render must not
 * fail because audio is unavailable or the tab is muted by policy.
 */
export function playMoveSound(kind: MoveSoundKind): void {
  if (!moveSoundsEnabled()) return;
  try {
    const c = audio();
    if (!c) return;
    synthesize(c, kind);
  } catch {
    // Audio is a nicety; never let it break the board.
  }
}

/** Play the cue a move deserves. Convenience wrapper over the two halves. */
export function playMove(input: MoveSoundInput): void {
  playMoveSound(classifyMoveSound(input));
}
