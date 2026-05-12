import { describe, expect, it } from 'vitest';
import { isValidElement, type ReactElement } from 'react';
import { ClassificationIcon, ICON_PATHS } from './ClassificationIcon';
import { CLASSIFICATION_ORDER } from '@/engine/classify';

/**
 * The icon component is a thin wrapper over an SVG path table. The
 * production failure mode this test guards against is the historical
 * one: the old text-glyph implementation rendered as platform-dependent
 * "tofu" rectangles on phones / Mac for `🕮` (book) and got auto-
 * promoted to coloured emoji for `!!` / `??` / `?!`. Replacing those
 * with inline SVG fixes the issue *only* if every classification
 * actually has a body — TypeScript enforces the keys, but a future
 * refactor that hides one path behind a conditional could silently
 * regress us back to a missing glyph.
 *
 * The unit-test layer runs in node-only mode (no DOM), so we don't
 * mount the component — we just assert the public contract:
 *   1. Every classification in `CLASSIFICATION_ORDER` has a non-null
 *      JSX body in `ICON_PATHS`.
 *   2. `ClassificationIcon` renders to a valid React element with
 *      `aria-hidden` set when no label / title is provided (so screen
 *      readers don't announce decorative icons in the move list).
 *   3. The same component reflects an `aria-label` when one is passed
 *      (so the on-board badge announces "blunder" / "best" etc.).
 */
describe('<ClassificationIcon>', () => {
  it('has an icon body for every classification', () => {
    for (const c of CLASSIFICATION_ORDER) {
      const body = ICON_PATHS[c];
      expect(body, `ICON_PATHS[${c}]`).toBeTruthy();
    }
    // Sanity: the map's key set matches the canonical order array.
    expect(Object.keys(ICON_PATHS).sort()).toEqual(
      [...CLASSIFICATION_ORDER].sort(),
    );
  });

  it('renders to a valid React element with sane defaults', () => {
    const el = ClassificationIcon({ classification: 'blunder' }) as ReactElement;
    expect(isValidElement(el)).toBe(true);
    expect(el.type).toBe('svg');
    const props = el.props as Record<string, unknown>;
    expect(props.viewBox).toBe('0 0 24 24');
    expect(props.fill).toBe('currentColor');
    // Decorative-by-default: no label/title passed → aria-hidden true,
    // role 'presentation' so a screen reader skips it.
    expect(props['aria-hidden']).toBe(true);
    expect(props.role).toBe('presentation');
  });

  it('exposes an aria-label when one is passed', () => {
    const el = ClassificationIcon({
      classification: 'best',
      'aria-label': 'best move',
    }) as ReactElement;
    const props = el.props as Record<string, unknown>;
    expect(props['aria-label']).toBe('best move');
    expect(props.role).toBe('img');
    expect(props['aria-hidden']).toBeUndefined();
  });

  it('honours custom size + className', () => {
    const el = ClassificationIcon({
      classification: 'good',
      size: 32,
      className: 'opacity-50',
    }) as ReactElement;
    const props = el.props as Record<string, unknown>;
    expect(props.width).toBe(32);
    expect(props.height).toBe(32);
    expect(props.className).toBe('opacity-50');
  });

  it('keys the SVG by classification so React remounts on change', () => {
    // Mobile-review-icon-color regression guard. When the icon
    // switches classifications (e.g. user navigates from an
    // `inaccuracy` ply to a `best` ply), React previously reused the
    // existing `<svg>` and diff'd its children — but the children are
    // heterogeneous across classifications (a single `<path>` for
    // `best`, a `<rect>`+`<circle>` pair for `excellent`, four
    // elements for `inaccuracy`/`blunder`). On iOS Safari and
    // Android Chrome that produced a one-frame paint where the
    // *previous* glyph appeared inside the *new* badge background,
    // matching the user's "the colour of the previous icon affects
    // the current" report. Forcing a stable per-classification key
    // on the `<svg>` makes React unmount + remount the subtree so
    // every paint is atomic. This test pins that contract — flipping
    // it to a constant or removing it would silently re-introduce
    // the bug.
    for (const c of CLASSIFICATION_ORDER) {
      const el = ClassificationIcon({ classification: c }) as ReactElement;
      expect(el.key, `ClassificationIcon(${c}).key`).toBe(c);
    }
    // And every distinct classification produces a distinct key —
    // otherwise the remount-on-change semantics break.
    const keys = CLASSIFICATION_ORDER.map(
      (c) => (ClassificationIcon({ classification: c }) as ReactElement).key,
    );
    expect(new Set(keys).size).toBe(keys.length);
  });
});
