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
 */
export function useThrottledLiveQuery<T>(
  query: () => Promise<T> | T,
  deps: ReadonlyArray<unknown>,
  intervalMs = 750,
): T | undefined {
  const [value, setValue] = useState<T | undefined>(undefined);
  const queryRef = useRef(query);
  queryRef.current = query;

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
      setValue(pendingResult);
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
