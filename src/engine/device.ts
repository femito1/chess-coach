/**
 * "Is this a phone?", asked without user-agent sniffing.
 *
 * Exists because of a specific hole. The engine pool shrinks itself on
 * low-memory devices, but only when `navigator.deviceMemory` gives it a number
 * to work with — and `deviceMemory` is Chromium-only. `pool.ts` deliberately
 * refuses to guess when it is absent, on the grounds that penalising every
 * desktop Safari and Firefox for a missing API costs real throughput to protect
 * a device there is no evidence about. That reasoning is sound and this does not
 * overturn it.
 *
 * The hole is iOS Safari, which reports no `deviceMemory` *and* enforces the
 * tightest per-tab memory limit of anything the app runs on. It was documented
 * as a known gap whose answer was the Settings toggle — which asks the user to
 * find a switch before the crash that would tell them they need it. A real
 * phone did crash: three NNUE workers at ~340 MB each, while the boot
 * reclassification pass and a cloud restore were also running.
 *
 * A capability query closes that hole without reopening the objection, because
 * it describes the *device* rather than the browser:
 *
 *   - `pointer: coarse` is about the PRIMARY input. Phones and tablets match;
 *     desktop Safari and Firefox do not, and neither does a touch-screen laptop
 *     whose primary pointer is its trackpad.
 *   - The smaller screen dimension separates phones from tablets, and reading
 *     `screen` rather than the viewport makes it independent of orientation,
 *     zoom and window size.
 *
 * Both must hold, so the answer is only ever "yes" for something genuinely
 * phone-shaped. Anything uncertain — no `matchMedia`, a throwing `matchMedia`,
 * no `screen` — answers "no" and leaves existing behaviour exactly as it was.
 */

/** Largest "short edge" in CSS px still considered a phone rather than a
 *  tablet. An iPhone 15 Pro Max is 430; an iPad mini is 744. */
export const PHONE_MAX_SHORT_EDGE = 500;

/**
 * Pure form, so the decision table is testable without a DOM.
 * `shortEdge` is the smaller of the screen's two dimensions.
 */
export function isPhoneShaped(input: {
  coarsePointer: boolean;
  shortEdge: number | undefined;
}): boolean {
  if (!input.coarsePointer) return false;
  if (typeof input.shortEdge !== 'number' || !(input.shortEdge > 0)) return false;
  return input.shortEdge <= PHONE_MAX_SHORT_EDGE;
}

/** Reads the live environment. Returns false rather than throwing anywhere the
 *  APIs are missing or restricted. */
export function looksLikePhone(): boolean {
  try {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return false;
    }
    const coarsePointer = window.matchMedia('(pointer: coarse)').matches;
    const s = window.screen;
    const shortEdge =
      s && typeof s.width === 'number' && typeof s.height === 'number'
        ? Math.min(s.width, s.height)
        : undefined;
    return isPhoneShaped({ coarsePointer, shortEdge });
  } catch {
    return false;
  }
}
