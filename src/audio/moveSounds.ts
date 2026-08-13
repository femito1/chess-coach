/**
 * Move sounds: five cues, one impact each.
 *
 * **Shape of the design, and why.** The first version layered a click over a
 * ringing tone, played castling as two clicks 85 ms apart, and used little
 * melodic runs for promotion and game end. The verdict was blunt and right:
 * doubled sounds, chimes, and no clear moment of impact. So every cue here is
 * a *single* burst of filtered noise with an instant attack — one audible
 * event, landing exactly when the piece does. There are no oscillators in
 * this file at all, which makes a chime structurally impossible.
 *
 * The cue set:
 *
 *   move       — a short mid-high tock
 *   capture    — the same tock, louder and a little lower
 *   check      — bright, resonant, cutting; unmistakably not a move
 *   mate       — low and long; the only cue that rings
 *   brilliant  — bright with a fast upward sweep, still one hit
 *   illegal    — dull low thud, for a move the board refused
 *
 * Castling and promotion deliberately have no cue of their own: they're
 * moves, and a second click to mark them was the thing that read as doubled.
 *
 * **Why synthesized rather than sampled.** chess.com's audio files are their
 * copyrighted assets; shipping them here would be redistributing someone
 * else's work. Generating the cues costs no bundle weight and no request on
 * the first move of a session. Swapping in real samples means changing
 * `playMoveSound` alone — callers only ever name a `MoveSoundKind`.
 *
 * The classifier (`classifyMoveSound`) is pure and separately tested; the
 * playback half touches Web Audio and is a no-op wherever that's missing
 * (unit tests, SSR), so importing this module is always safe.
 */

import { Chess } from 'chess.js';
import type { Classification } from '@/db/schema';
import { readPersistedValue, persistedStorageKey } from '@/lib/usePersistedState';

export type MoveSoundKind =
  | 'move'
  | 'capture'
  | 'check'
  | 'mate'
  | 'brilliant'
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
  /** Engine judgement of the move, where the surface has one (review,
   *  free play). Only `'brilliant'` changes the cue. */
  classification?: Classification;
}

/**
 * Which cue a move earns. Precedence, highest first:
 *
 *   mate      — the move ended the game. Stalemate and draws share this cue:
 *               "the game is over" is the thing to convey, and a separate
 *               draw sound would be a fourth timbre nobody asked for.
 *   brilliant — flagged brilliant by the analysis. Above check because it's
 *               the rarer, more remarkable fact about the move; below mate
 *               because a finished game outranks a compliment.
 *   check     — beats capture, as requested: a capture that gives check
 *               announces the check, since that's what must be answered.
 *   capture   — a piece left the board.
 *   move      — everything else, including castling and promotion.
 *
 * Falls back to `'move'` for anything unparseable, so a malformed FEN makes
 * a plain click rather than throwing inside a board render.
 */
export function classifyMoveSound(input: MoveSoundInput): MoveSoundKind {
  const { fenBefore, fenAfter, classification } = input;
  let chess: Chess;
  try {
    chess = new Chess(fenAfter);
  } catch {
    return 'move';
  }

  if (chess.isCheckmate() || chess.isDraw() || chess.isStalemate()) {
    return 'mate';
  }
  if (classification === 'brilliant') return 'brilliant';
  if (chess.inCheck()) return 'check';
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

/** ~600 ms of white noise, reused by every cue (`mate` is the longest). */
function noiseBuffer(c: AudioContext): AudioBuffer {
  if (noise && noise.sampleRate === c.sampleRate) return noise;
  const frames = Math.floor(c.sampleRate * 0.6);
  const buf = c.createBuffer(1, frames, c.sampleRate);
  const data = buf.getChannelData(0);
  // Deterministic pseudo-noise: a plain LCG rather than Math.random, so a
  // given cue sounds identical every time.
  let seed = 0x2f6e2b1;
  for (let i = 0; i < frames; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    data[i] = seed / 0x3fffffff - 1;
  }
  noise = buf;
  return buf;
}

interface Impact {
  /** Peak level, 0..1, before the master gain. */
  gain: number;
  /** Centre of the resonant band — the cue's apparent pitch. */
  freq: number;
  /** Resonance. Higher is more pitched and bell-like, lower is more of a
   *  dry click. */
  q: number;
  /** Seconds to silence. */
  decay: number;
  /** Optional band sweep, giving a rising "shine" within the one hit. */
  sweepTo?: number;
}

/**
 * The whole synthesizer: one noise burst, one filter, one envelope that
 * starts at full level. Instant attack is what makes the moment of impact
 * legible; every cue differs only in the four numbers above.
 */
function impact(c: AudioContext, out: AudioNode, at: number, spec: Impact): void {
  const src = c.createBufferSource();
  src.buffer = noiseBuffer(c);
  const band = c.createBiquadFilter();
  band.type = 'bandpass';
  band.frequency.setValueAtTime(spec.freq, at);
  band.Q.value = spec.q;
  if (spec.sweepTo != null) {
    band.frequency.exponentialRampToValueAtTime(
      spec.sweepTo,
      at + spec.decay * 0.7,
    );
  }
  const env = c.createGain();
  env.gain.setValueAtTime(spec.gain, at);
  env.gain.exponentialRampToValueAtTime(0.0001, at + spec.decay);
  src.connect(band).connect(env).connect(out);
  src.start(at);
  src.stop(at + spec.decay + 0.02);
}

/** One spec per cue. Capture is deliberately the move spec with more level
 *  and slightly less brightness — "the same sound, a bit louder", as asked. */
const CUES: Record<MoveSoundKind, Impact> = {
  move: { gain: 0.6, freq: 1900, q: 1.6, decay: 0.045 },
  capture: { gain: 0.95, freq: 1500, q: 1.4, decay: 0.055 },
  check: { gain: 0.75, freq: 3000, q: 6, decay: 0.09 },
  mate: { gain: 0.95, freq: 320, q: 3.5, decay: 0.5 },
  brilliant: { gain: 0.8, freq: 1300, q: 5, decay: 0.18, sweepTo: 3600 },
  illegal: { gain: 0.5, freq: 220, q: 2, decay: 0.12 },
};

/** Master level. Loud enough that the cue is unmistakable, low enough that a
 *  sound on every move doesn't get the whole feature muted. */
const MASTER_GAIN = 0.5;

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
    const master = c.createGain();
    master.gain.value = MASTER_GAIN;
    master.connect(c.destination);
    impact(c, master, c.currentTime + 0.001, CUES[kind]);
  } catch {
    // Audio is a nicety; never let it break the board.
  }
}

/** Play the cue a move deserves. Convenience wrapper over the two halves. */
export function playMove(input: MoveSoundInput): void {
  playMoveSound(classifyMoveSound(input));
}
