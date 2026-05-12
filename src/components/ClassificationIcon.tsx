import type { Classification } from '@/db/schema';

/**
 * Inline SVG icons for every move classification. We used to use raw
 * Unicode characters (`!!`, `??`, `?!`, `★`, `✓`, `🕮`, `x`) which
 * looked fine on the developer's Linux/Chrome machine but fell apart
 * across the userbase:
 *
 *  - `🕮` (U+1F56E "BOOK") is a rare codepoint missing from many
 *    platform fonts — Android, iOS Safari, and several macOS system
 *    fonts render the missing-glyph "tofu" rectangles, which the user
 *    saw as "stacked lines" both on their phone and on a Mac.
 *  - `!!`, `??`, `?!` get auto-promoted to colourful Apple emoji
 *    glyphs on iOS / macOS even with a U+FE0E variation selector,
 *    producing the "messed up colors" the user reported on the Mac
 *    (the `?` doesn't get coloured but `??` does, etc.).
 *  - `★` and `✓` are usually safe but their stroke weights drift
 *    between fonts so the badge sizes look uneven across devices.
 *
 * Inline SVG kills all three problems: every device renders the exact
 * same path, the glyph picks up `currentColor` for foreground (so the
 * white-on-coloured-badge contract still holds), and there is no
 * font-fallback path at all.
 *
 * The icons are designed on a 24×24 viewBox so they scale crisply at
 * any badge size. `width` / `height` default to `1em` so callers can
 * size them via `font-size` (matching how the old text glyphs sized).
 */
export interface ClassificationIconProps {
  classification: Classification;
  /** SVG width/height. Defaults to `1em` so font-size controls it. */
  size?: number | string;
  className?: string;
  title?: string;
  'aria-label'?: string;
}

export function ClassificationIcon({
  classification,
  size = '1em',
  className,
  title,
  'aria-label': ariaLabel,
}: ClassificationIconProps) {
  const path = ICON_PATHS[classification];
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={className}
      role={ariaLabel || title ? 'img' : 'presentation'}
      aria-label={ariaLabel ?? title}
      aria-hidden={ariaLabel || title ? undefined : true}
      fill="currentColor"
      stroke="none"
    >
      {title ? <title>{title}</title> : null}
      {path}
    </svg>
  );
}

/**
 * Per-classification SVG body. Each path is laid out inside a 24×24
 * viewBox, centred, and uses `fill="currentColor"` (set on the parent
 * <svg>) so the same icon works on dark badges and light text rows.
 *
 * Designed to read clearly at 12 px (move-list inline) and 18–20 px
 * (board badge inner — the badge itself is 28 px). Strokes are drawn
 * as filled paths rather than `stroke=` lines so the visual weight
 * stays the same when the icon is scaled with CSS.
 *
 * Exported for the unit-test contract that locks down "every
 * classification has an icon body" — TypeScript already enforces
 * coverage at the type level, but the runtime check guards against a
 * future refactor that drops a key behind a conditional.
 */
export const ICON_PATHS: Record<Classification, JSX.Element> = {
  // Two exclamation marks (chess.com convention for !! brilliancies).
  brilliant: (
    <>
      <rect x="6.5" y="4" width="3" height="11" rx="1.2" />
      <circle cx="8" cy="19" r="1.8" />
      <rect x="14.5" y="4" width="3" height="11" rx="1.2" />
      <circle cx="16" cy="19" r="1.8" />
    </>
  ),
  // Five-pointed star.
  best: (
    <path d="M12 2.5 14.78 9.07 22 9.66 16.5 14.32 18.18 21.5 12 17.77 5.82 21.5 7.5 14.32 2 9.66 9.22 9.07 Z" />
  ),
  // Single exclamation mark.
  excellent: (
    <>
      <rect x="10.5" y="4" width="3" height="11" rx="1.2" />
      <circle cx="12" cy="19" r="1.8" />
    </>
  ),
  // Checkmark.
  good: (
    <path d="M21.4 6.4 19.6 4.6 9.6 14.6 4.4 9.4 2.6 11.2 9.6 18.2 Z" />
  ),
  // Open book — the bug fix. Two facing pages with a centre spine and
  // a small bottom cover lip. Designed to read at 12 px while still
  // looking like a book at 28 px.
  book: (
    <>
      {/* left page */}
      <path d="M3 5.5 C 6 4.5, 9 4.5, 11.4 6 L 11.4 19 C 9 17.5, 6 17.5, 3 18.5 Z" />
      {/* right page */}
      <path d="M21 5.5 C 18 4.5, 15 4.5, 12.6 6 L 12.6 19 C 15 17.5, 18 17.5, 21 18.5 Z" />
      {/* bottom cover lip — slight darker tone via opacity so it reads
          even on light backgrounds without a second colour. */}
      <path
        d="M2 18 C 6 17, 9.5 17, 11.4 18.4 L 12.6 18.4 C 14.5 17, 18 17, 22 18 L 22 20 C 18 19, 14.5 19, 12.6 20.2 L 11.4 20.2 C 9.5 19, 6 19, 2 20 Z"
        opacity="0.55"
      />
    </>
  ),
  // Question mark + exclamation mark, side-by-side.
  inaccuracy: (
    <>
      {/* `?` */}
      <path d="M5.4 8.2 C 5.4 5.6, 7.4 4, 9.6 4 C 11.8 4, 13.6 5.4, 13.6 7.6 C 13.6 9.4, 12.6 10.2, 11.2 11 C 10 11.7, 9.6 12.2, 9.6 13.4 L 9.6 14.5 L 7 14.5 L 7 13.2 C 7 11.6, 7.6 10.6, 9 9.8 C 10.2 9.1, 10.8 8.7, 10.8 7.7 C 10.8 6.9, 10.3 6.4, 9.5 6.4 C 8.6 6.4, 8 7 8 8.2 Z" />
      <circle cx="8.3" cy="18" r="1.6" />
      {/* `!` */}
      <rect x="15.6" y="4" width="2.6" height="10.5" rx="1.1" />
      <circle cx="16.9" cy="18" r="1.6" />
    </>
  ),
  // X-cross (chess.com uses this for "missed win" in their badges).
  miss: (
    <path d="M5.6 4.2 4.2 5.6 10.6 12 4.2 18.4 5.6 19.8 12 13.4 18.4 19.8 19.8 18.4 13.4 12 19.8 5.6 18.4 4.2 12 10.6 Z" />
  ),
  // Single question mark.
  mistake: (
    <>
      <path d="M7.4 8.4 C 7.4 5.4, 9.6 3.6, 12 3.6 C 14.6 3.6, 16.8 5.2, 16.8 7.8 C 16.8 9.8, 15.7 10.8, 14 11.7 C 12.6 12.5, 12 13 12 14.4 L 12 15.6 L 9.2 15.6 L 9.2 14 C 9.2 12.2, 9.9 11.1, 11.6 10.2 C 13 9.4, 13.7 9, 13.7 7.9 C 13.7 7, 13 6.4, 12 6.4 C 10.9 6.4, 10.2 7.1, 10.2 8.4 Z" />
      <circle cx="10.6" cy="19.4" r="1.9" />
    </>
  ),
  // Two question marks.
  blunder: (
    <>
      <path d="M2.4 7.6 C 2.4 5.2, 4.4 3.6, 6.6 3.6 C 9 3.6, 10.8 5, 10.8 7.4 C 10.8 9.2, 9.8 10, 8.4 10.8 C 7.2 11.5, 6.7 12, 6.7 13.2 L 6.7 14.2 L 4.2 14.2 L 4.2 12.9 C 4.2 11.3, 4.9 10.3, 6.3 9.5 C 7.5 8.8, 8.1 8.4, 8.1 7.5 C 8.1 6.7, 7.5 6.2, 6.6 6.2 C 5.7 6.2, 5.1 6.8, 5.1 8 Z" />
      <circle cx="5.5" cy="18" r="1.55" />
      <path d="M13.2 7.6 C 13.2 5.2, 15.2 3.6, 17.4 3.6 C 19.8 3.6, 21.6 5, 21.6 7.4 C 21.6 9.2, 20.6 10, 19.2 10.8 C 18 11.5, 17.5 12, 17.5 13.2 L 17.5 14.2 L 15 14.2 L 15 12.9 C 15 11.3, 15.7 10.3, 17.1 9.5 C 18.3 8.8, 18.9 8.4, 18.9 7.5 C 18.9 6.7, 18.3 6.2, 17.4 6.2 C 16.5 6.2, 15.9 6.8, 15.9 8 Z" />
      <circle cx="16.3" cy="18" r="1.55" />
    </>
  ),
};
