import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

/** Smallest thumb we will draw, so a very wide table still leaves something
 *  grabbable rather than a 3 px sliver. */
const MIN_THUMB_PX = 28;

/**
 * A horizontally-scrolling region whose scroll affordance stays on screen.
 *
 * The problem: a plain `overflow-x-auto` wrapper around a tall table puts its
 * horizontal scrollbar at the bottom of *the table*, not the bottom of the
 * screen. With the games table in a small window the scroller's bottom edge sits
 * ~1800 px below the viewport, so the only way to scroll sideways was to scroll
 * all the way down, do it, and come back up.
 *
 * So the content keeps scrolling natively — wheel, trackpad, touch, keyboard,
 * `scrollLeft` — and a scrollbar is *drawn* in a strip that is `position: sticky`
 * to the bottom. While the region extends past the bottom of the viewport the
 * strip floats there; once you reach the end of the region it settles at its
 * natural place.
 *
 * ── Why the thumb is hand-drawn rather than a mirrored native scrollbar ──
 *
 * The tidier trick is a second real scroll container holding a spacer as wide as
 * the content, with the two `scrollLeft`s mirrored — you inherit the platform's
 * own thumb for free. It was built that way first. The problem is that you
 * inherit the platform's decision about whether to *paint* it: where scrollbars
 * are overlay-style (macOS, iOS, GTK configured that way, and headless Chromium,
 * which reports a scrollbar gutter of 0 px) the strip is an empty band until you
 * are already scrolling. For a control whose entire purpose is to be visible
 * before you know you need it, inheriting that is the one thing it must not do.
 *
 * Drawing it costs the pointer handling below and buys a thumb that is always
 * visible, identical on every platform, and — not incidentally — verifiable in a
 * screenshot, which a native overlay thumb is not. The colours are the ones
 * `.scrollable` uses for the app's other scrollbars, so it does not read as a
 * foreign control.
 *
 * ── Degradation ──
 *
 * The strip renders only when the content actually overflows, and the scroller
 * only hides its own scrollbar in that same case. If measurement never runs — no
 * `ResizeObserver`, SSR, a bare test environment — this is exactly the
 * `overflow-x-auto` it replaced, native scrollbar included. Nothing can leave the
 * region scrollable with no way to scroll it.
 *
 * `sticky` is defeated by an ancestor that clips or scrolls, so the wrapper is
 * rendered here rather than left to the caller: that guarantees the strip's
 * containing block is the element `className` styles.
 */
export function StickyXScroll({
  children,
  className,
}: {
  children: ReactNode;
  /** Applied to the outer wrapper — the sticky strip's containing block, and so
   *  what decides where the strip comes to rest. Pass the surface you would
   *  otherwise have put the scroller in, e.g. `card`. */
  className?: string;
}) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);
  const [overflowing, setOverflowing] = useState(false);

  /**
   * Size and place the thumb from the scroller's live geometry.
   *
   * Written straight to the node instead of through state: this runs on every
   * scroll event, and a `setState` per frame of a drag would re-render the whole
   * table for a 12 px cosmetic change.
   */
  const paint = useCallback(() => {
    const sc = scrollerRef.current;
    const track = trackRef.current;
    const thumb = thumbRef.current;
    if (!sc || !track || !thumb) return;
    const trackW = track.clientWidth;
    const maxScroll = sc.scrollWidth - sc.clientWidth;
    const width = Math.max(MIN_THUMB_PX, (sc.clientWidth / sc.scrollWidth) * trackW);
    const travel = trackW - width;
    const left = maxScroll > 0 ? (sc.scrollLeft / maxScroll) * travel : 0;
    thumb.style.width = `${width}px`;
    thumb.style.transform = `translateX(${left}px)`;
  }, []);

  useEffect(() => {
    const sc = scrollerRef.current;
    if (!sc || typeof ResizeObserver === 'undefined') return;
    const measure = () => {
      // `scrollWidth` is an integer, so allow a pixel of slack: a fractional
      // layout width would otherwise read as permanently overflowing and pin a
      // scrollbar under a table that fits.
      setOverflowing(sc.scrollWidth - sc.clientWidth > 1);
      paint();
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(sc);
    // The content root too, for the table getting wider — a longer opening name
    // in a new row widens a column without the scroller changing size at all.
    const content = sc.firstElementChild;
    if (content) ro.observe(content);
    return () => ro.disconnect();
  }, [paint]);

  // Re-place the thumb once the strip mounts; until then there was no node to
  // write to and `paint` above was a no-op.
  useEffect(paint, [overflowing, paint]);

  /** Pointer x → scrollLeft. `grabX` is where in the thumb the drag started, so
   *  the thumb does not jump under the cursor. */
  const drag = useRef<{ grabX: number } | null>(null);

  const scrollToPointer = useCallback((clientX: number) => {
    const sc = scrollerRef.current;
    const track = trackRef.current;
    const thumb = thumbRef.current;
    if (!sc || !track || !thumb || !drag.current) return;
    const box = track.getBoundingClientRect();
    const width = thumb.getBoundingClientRect().width;
    const travel = box.width - width;
    const left = Math.min(Math.max(clientX - box.left - drag.current.grabX, 0), travel);
    const maxScroll = sc.scrollWidth - sc.clientWidth;
    sc.scrollLeft = travel > 0 ? (left / travel) * maxScroll : 0;
  }, []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const thumb = thumbRef.current;
      if (!thumb) return;
      const box = thumb.getBoundingClientRect();
      const onThumb = e.clientX >= box.left && e.clientX <= box.right;
      // Pressing the bare track jumps there, centring the thumb on the press;
      // pressing the thumb picks it up where it was grabbed.
      drag.current = { grabX: onThumb ? e.clientX - box.left : box.width / 2 };
      e.currentTarget.setPointerCapture(e.pointerId);
      scrollToPointer(e.clientX);
    },
    [scrollToPointer],
  );

  return (
    <div className={className}>
      <div
        ref={scrollerRef}
        className={`overflow-x-auto ${overflowing ? 'scrollbar-none' : ''}`}
        onScroll={paint}
      >
        {children}
      </div>
      {overflowing && (
        <div
          ref={trackRef}
          // Not exposed to assistive tech: it duplicates a scroll region already
          // in the tree, which a screen reader reaches and scrolls with the keys
          // it uses for everything else.
          aria-hidden="true"
          className="sticky bottom-0 z-10 h-3.5 border-t border-border bg-bg-soft px-1 py-[3px] touch-none select-none cursor-grab active:cursor-grabbing"
          onPointerDown={onPointerDown}
          onPointerMove={(e) => {
            if (drag.current) scrollToPointer(e.clientX);
          }}
          onPointerUp={() => {
            drag.current = null;
          }}
          onPointerCancel={() => {
            drag.current = null;
          }}
        >
          {/* Same 8 px height and colours as `.scrollable`'s thumb, so it reads
              as this app's scrollbar rather than a bespoke slider. */}
          <div
            ref={thumbRef}
            className="h-2 rounded-full bg-[#3a4252] hover:bg-[#4a5366] transition-colors"
          />
        </div>
      )}
    </div>
  );
}
