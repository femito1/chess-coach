/**
 * Move sounds: one knock per move, plus a flourish for brilliance.
 *
 * **Shape of the design, and why it's on its third pass.** The first version
 * sequenced sounds — two castle clicks 85 ms apart, tones ringing on after
 * the click had ended, melodic runs for promotion and game end — and read as
 * doubled cues and chimes with no clear moment of impact. The second went to
 * the other extreme: a lone burst of filtered noise per cue. Unambiguous, but
 * thin and cheap-sounding, because noise alone has no pitched body; it's the
 * *top* of a sound, not a whole one.
 *
 * So each cue is now a struck knock: a contact transient (noise) plus a
 * damped pitched body and one inharmonic upper partial, all beginning on the
 * same frame and dying together. Stacking is what gives an impact weight;
 * *sequencing* is what sounded doubled. Bodies bend their pitch down as they
 * decay and are gone inside ~130 ms (mate excepted), which is what separates
 * struck wood from a tone.
 *
 * The transients are deliberately quiet, dark and very short (20–32 ms, with
 * a lowpass on top). Loud, bright or long noise stops sounding like contact
 * and starts sounding like *air*; the body is what should carry each cue.
 *
 * The cue set:
 *
 *   move       — mid tock with a short low body
 *   capture    — the same knock, louder and heavier
 *   check      — the same knock pitched higher with a harder top: recognisably
 *                the same instrument, plainly a different event
 *   mate       — low, heavy, the only cue that rings on
 *   brilliant  — an ascending three-note "achievement" flourish, by request:
 *                a brilliant move shouldn't sound like a louder move
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

/**
 * ~300 ms of noise for the contact transients.
 *
 * Generated with xorshift32 taking the *high* bits. The first version used a
 * textbook LCG and read its low bits, which are famously non-random — the
 * short-period patterning in them is audible as a cheap buzz, and was part of
 * why these cues sounded low-quality.
 */
function noiseBuffer(c: AudioContext): AudioBuffer {
  if (noise && noise.sampleRate === c.sampleRate) return noise;
  const frames = Math.floor(c.sampleRate * 0.3);
  const buf = c.createBuffer(1, frames, c.sampleRate);
  const data = buf.getChannelData(0);
  let s = 0x9e3779b9;
  for (let i = 0; i < frames; i++) {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    data[i] = s / 0x80000000 - 1;
  }
  noise = buf;
  return buf;
}

/** Attack ramp. Long enough to avoid the digital "spit" of starting a sample
 *  at full amplitude, short enough that the hit still lands on the frame the
 *  piece does. */
const ATTACK = 0.0008;

/**
 * The contact transient: a filtered noise burst, there to mark the instant of
 * impact and nothing else.
 *
 * It is kept short, quiet and dark on purpose. Noise that is loud, bright or
 * long stops reading as contact and starts reading as *air* — the hiss that
 * made the previous voicing sound breathy. A lowpass after the band throws
 * away the top end the bandpass leaks, which is where nearly all of that
 * airiness lives; the body below is what the ear should mostly hear.
 */
function transient(
  c: AudioContext,
  out: AudioNode,
  at: number,
  spec: { gain: number; freq: number; q: number; decay: number; cut?: number },
): void {
  const src = c.createBufferSource();
  src.buffer = noiseBuffer(c);
  const band = c.createBiquadFilter();
  band.type = 'bandpass';
  band.frequency.value = spec.freq;
  band.Q.value = spec.q;
  const cut = c.createBiquadFilter();
  cut.type = 'lowpass';
  cut.frequency.value = spec.cut ?? 3200;
  cut.Q.value = 0.7;
  const env = c.createGain();
  env.gain.setValueAtTime(0.0001, at);
  env.gain.linearRampToValueAtTime(spec.gain, at + ATTACK);
  env.gain.exponentialRampToValueAtTime(0.0001, at + spec.decay);
  src.connect(band).connect(cut).connect(env).connect(out);
  src.start(at);
  src.stop(at + spec.decay + 0.02);
}

/**
 * A damped pitched partial — the *body* that gives an impact its weight.
 *
 * Starts on the same frame as the transient and dies with it, so the pair is
 * heard as one solid knock rather than two events. `drop` bends the pitch
 * down over the decay, which is what real struck wood does and what stops a
 * steady sine from sounding like a tone.
 */
function body(
  c: AudioContext,
  out: AudioNode,
  at: number,
  spec: { gain: number; freq: number; decay: number; drop?: number },
): void {
  const osc = c.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(spec.freq, at);
  if (spec.drop != null) {
    osc.frequency.exponentialRampToValueAtTime(
      Math.max(30, spec.freq * spec.drop),
      at + spec.decay,
    );
  }
  const env = c.createGain();
  env.gain.setValueAtTime(0.0001, at);
  env.gain.linearRampToValueAtTime(spec.gain, at + ATTACK);
  env.gain.exponentialRampToValueAtTime(0.0001, at + spec.decay);
  osc.connect(env).connect(out);
  osc.start(at);
  osc.stop(at + spec.decay + 0.02);
}

interface KnockSpec {
  /** Contact noise. `cut` is the lowpass above the band — the lower it is,
   *  the less air the cue has. */
  hit: { gain: number; freq: number; q: number; decay: number; cut?: number };
  /**
   * A very short, very bright burst at the same onset — the *snap* that makes
   * a cue read as crisp.
   *
   * Crispness and airiness are both high-frequency energy; what separates
   * them is how long it lasts. A few milliseconds of treble is the click of
   * contact. The same treble held for 50 ms is breath. So this is deliberately
   * the shortest thing in the file (~6 ms), which buys definition without
   * putting the hiss back.
   */
  snap?: { gain: number; freq: number; decay: number };
  /** Pitched body: fundamental, plus an inharmonic upper partial at
   *  `partial` × the fundamental. Inharmonic and fast-decaying is what reads
   *  as "wood"; harmonic and slow would read as a chime. */
  low: { gain: number; freq: number; decay: number; drop?: number };
  partial?: { ratio: number; gain: number; decay: number };
}

/**
 * One knock per cue: transient + body + one upper partial, all struck on the
 * same frame. Three oscillator/noise nodes, but a single audible event —
 * which is the distinction the earlier version got wrong by *sequencing*
 * sounds (two castle clicks 85 ms apart, tones ringing after the click had
 * finished) rather than stacking them.
 */
function knock(c: AudioContext, out: AudioNode, at: number, spec: KnockSpec): void {
  transient(c, out, at, spec.hit);
  if (spec.snap) {
    transient(c, out, at, {
      gain: spec.snap.gain,
      freq: spec.snap.freq,
      q: 0.8,
      decay: spec.snap.decay,
      // No lowpass: the snap IS the top end.
      cut: 16000,
    });
  }
  body(c, out, at, spec.low);
  if (spec.partial) {
    body(c, out, at, {
      gain: spec.partial.gain,
      freq: spec.low.freq * spec.partial.ratio,
      decay: spec.partial.decay,
      drop: 0.95,
    });
  }
}

/**
 * The one cue that is deliberately a little flourish rather than a knock: an
 * ascending three-note arpeggio, the "achievement unlocked" shape. Asked for
 * explicitly — a brilliant move should not sound like a louder move.
 */
function fanfare(c: AudioContext, out: AudioNode, at: number): void {
  const notes = [784, 1046.5, 1568]; // G5, C6, G6
  notes.forEach((freq, i) => {
    const t = at + i * 0.075;
    const last = i === notes.length - 1;
    const decay = last ? 0.42 : 0.18;
    // Bell-ish: fundamental plus a quiet octave-and-a-half partial.
    body(c, out, t, { gain: last ? 0.5 : 0.36, freq, decay });
    body(c, out, t, { gain: last ? 0.12 : 0.08, freq: freq * 2.5, decay: decay * 0.5 });
  });
  // A touch of contact noise on the first note so it still feels struck.
  transient(c, out, at, { gain: 0.25, freq: 3200, q: 2, decay: 0.03 });
}

/**
 * Per-cue voicing. `capture` is `move` with more level and a lower, heavier
 * body — "the same sound, a bit louder", as asked.
 */
const KNOCKS: Record<Exclude<MoveSoundKind, 'brilliant'>, KnockSpec> = {
  move: {
    hit: { gain: 0.42, freq: 2600, q: 1.2, decay: 0.014, cut: 6000 },
    snap: { gain: 0.16, freq: 6000, decay: 0.006 },
    low: { gain: 0.7, freq: 200, decay: 0.07, drop: 0.82 },
    partial: { ratio: 2.6, gain: 0.13, decay: 0.028 },
  },
  capture: {
    hit: { gain: 0.52, freq: 2100, q: 1.1, decay: 0.018, cut: 5200 },
    snap: { gain: 0.18, freq: 5200, decay: 0.007 },
    low: { gain: 0.95, freq: 145, decay: 0.11, drop: 0.78 },
    partial: { ratio: 2.4, gain: 0.17, decay: 0.042 },
  },
  // Same knock family as `move` — a piece still lands — but pitched a fifth
  // or so higher with a harder, tighter top, so it reads as "that was a
  // check" without becoming a different instrument. It used to sit at 520 Hz
  // with a ringing 3× partial and a bright 3.4 kHz top, which is a chime, and
  // chimes were ruled out.
  check: {
    hit: { gain: 0.5, freq: 3200, q: 2.2, decay: 0.016, cut: 7000 },
    snap: { gain: 0.22, freq: 7000, decay: 0.007 },
    low: { gain: 0.72, freq: 300, decay: 0.06, drop: 0.8 },
    partial: { ratio: 2.6, gain: 0.14, decay: 0.026 },
  },
  mate: {
    hit: { gain: 0.4, freq: 1400, q: 1.2, decay: 0.022, cut: 4000 },
    snap: { gain: 0.12, freq: 4500, decay: 0.006 },
    low: { gain: 1, freq: 90, decay: 0.5, drop: 0.72 },
    partial: { ratio: 2.2, gain: 0.2, decay: 0.18 },
  },
  illegal: {
    hit: { gain: 0.16, freq: 350, q: 1, decay: 0.028, cut: 1600 },
    low: { gain: 0.6, freq: 105, decay: 0.15, drop: 0.8 },
  },
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
    const at = c.currentTime + 0.001;
    if (kind === 'brilliant') fanfare(c, master, at);
    else knock(c, master, at, KNOCKS[kind]);
  } catch {
    // Audio is a nicety; never let it break the board.
  }
}

/** Play the cue a move deserves. Convenience wrapper over the two halves. */
export function playMove(input: MoveSoundInput): void {
  playMoveSound(classifyMoveSound(input));
}
