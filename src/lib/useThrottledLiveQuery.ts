import { useEffect, useRef, useState } from 'react';
import { liveQuery, type Subscription } from 'dexie';

/**
 * Same shape as `dexie-react-hooks`'s `useLiveQuery`, but coalesces rapid
 * change events into at most one re-run every `intervalMs` (defaults to
 * 750 ms). Use this on pages whose query runs over a hot table that the
 * analyzer is rapidly mutating — e.g. anything reading from `games` while
 * the queue is going. Without it, every per-move write fires a re-render
 * and a full re-fetch, which is the single biggest cause of UI lag during
 * analysis.
 *
 * Trade-off: the page's data can lag behind the DB by up to `intervalMs`,
 * which is fine for aggregate dashboards (counts, charts, weaknesses
 * roll-ups) where one move's worth of staleness is invisible.
 *
 * **Reference-stability:** when a refire produces a result that's
 * structurally equal to the previous one, we return the *previous*
 * array/object reference rather than the new one. That keeps downstream
 * `useMemo([games])` caches valid across analyzer writes that didn't
 * actually change the projected shape (e.g. the analyzer wrote
 * `userTimeSec` to a row that the dashboard projection doesn't even
 * include — without dedup, the dashboard's hours-played memo would
 * still bust). Equality is shallow array element comparison plus
 * shallow object-property comparison; that handles the common Dexie
 * shapes (`Game[]`, `{ pending, running, done, error }`) without
 * walking nested values like the per-game `accuracy` object. If the
 * shape is something else, dedup harmlessly returns false and we fall
 * back to "every refire is new" — same behaviour as before this fix.
 */
export function useThrottledLiveQuery<T>(
  query: () => Promise<T> | T,
  deps: ReadonlyArray<unknown>,
  intervalMs = 750,
): T | undefined {
  const [value, setValue] = useState<T | undefined>(undefined);
  const queryRef = useRef(query);
  queryRef.current = query;
  // Latest emitted value, kept in a ref so the dedup check inside
  // `flushPending` doesn't have to depend on the (lagging) state.
  const lastEmittedRef = useRef<T | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    let lastEmitAt = 0;
    let pendingResult: T | undefined = undefined;
    let pendingTimer: ReturnType<typeof setTimeout> | null = null;
    let hasPending = false;

    const flushPending = () => {
      pendingTimer = null;
      if (cancelled || !hasPending) return;
      hasPending = false;
      lastEmitAt = Date.now();
      const next = pendingResult;
      const prev = lastEmittedRef.current;
      // Reference-equality dedup: if the new value is structurally the
      // same as the last one we emitted, return the previous reference.
      // React's bail-out for setState compares with Object.is, so an
      // identical reference avoids a re-render entirely.
      if (prev !== undefined && shallowEqual(prev, next)) {
        return;
      }
      lastEmittedRef.current = next;
      setValue(next);
    };

    let sub: Subscription | null = null;
    try {
      // `liveQuery` reads `queryRef.current()` itself; Dexie's tracking
      // hooks pick up the touched tables and fire `next` on changes.
      sub = liveQuery(() => queryRef.current()).subscribe({
        next: (v) => {
          if (cancelled) return;
          pendingResult = v;
          hasPending = true;
          // First emit goes through immediately so the page isn't empty
          // on mount. After that we throttle.
          if (lastEmitAt === 0) {
            flushPending();
            return;
          }
          const sinceLast = Date.now() - lastEmitAt;
          if (sinceLast >= intervalMs) {
            flushPending();
          } else if (pendingTimer === null) {
            pendingTimer = setTimeout(flushPending, intervalMs - sinceLast);
          }
        },
        error: () => {
          /* swallow — same behaviour as useLiveQuery */
        },
      });
    } catch {
      /* ignore */
    }

    return () => {
      cancelled = true;
      if (pendingTimer) clearTimeout(pendingTimer);
      sub?.unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return value;
}

/**
 * Shallow structural equality used for dedup inside the throttled live
 * query. Designed for the common Dexie return shapes only:
 *
 *   - Arrays of objects: equal iff same length AND each pair of
 *     elements is shallow-equal at the top level. Objects beyond depth 1
 *     (e.g. a `Game.accuracy` sub-object) are compared by reference,
 *     which matches the analyzer's behaviour — when it updates a row
 *     it allocates a fresh `accuracy` object, so a mid-render write
 *     does invalidate cleanly. Reads via `bulkGet` / `toArray` always
 *     allocate fresh reference identity for every row, so this dedup
 *     fires only when the *projected* shape genuinely matches across
 *     two refires.
 *   - Plain objects: equal iff same own keys AND each pair of values
 *     is `Object.is`-equal. Used by `countByStatus` ({pending, running,
 *     done, error} of numbers).
 *   - Primitives: `Object.is`.
 *   - Anything else (Map, Set, Date) returns false to avoid
 *     dedup-induced staleness on container types we don't fully
 *     understand.
 *
 * Exported for tests; not part of the module's public hook API.
 */
export function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a === null || b === null) return false;
  if (typeof a !== 'object' || typeof b !== 'object') return false;

  if (Array.isArray(a)) {
    if (!Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!shallowOnePassEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (Array.isArray(b)) return false;

  // Plain-ish object — refuse to dedup Maps / Sets / Dates / typed
  // arrays / class instances we don't recognize. The cheapest filter
  // is the constructor check.
  const ac = (a as { constructor?: unknown }).constructor;
  const bc = (b as { constructor?: unknown }).constructor;
  if (ac !== Object && ac !== undefined) return false;
  if (bc !== Object && bc !== undefined) return false;

  return shallowOnePassEqual(a, b);
}

/** Inner helper: compares two objects (or primitives) one level deep. */
function shallowOnePassEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a === null || b === null) return false;
  if (typeof a !== 'object' || typeof b !== 'object') return false;

  const ak = Object.keys(a as Record<string, unknown>);
  const bk = Object.keys(b as Record<string, unknown>);
  if (ak.length !== bk.length) return false;
  const ar = a as Record<string, unknown>;
  const br = b as Record<string, unknown>;
  for (const k of ak) {
    if (!Object.is(ar[k], br[k])) return false;
  }
  return true;
}
