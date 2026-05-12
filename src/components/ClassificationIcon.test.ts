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
});
