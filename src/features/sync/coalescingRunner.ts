/**
 * Debounced, single-flight scheduling for a background job — the timing half of
 * the post-puzzle attempt upload (`requestAttemptSync` in `useCloudSync.ts`),
 * kept free of Dexie and the network so the unit tier can drive it with fake
 * timers.
 *
 *  - `request()` (re)starts a `delayMs` timer, so a burst of requests — a run of
 *    quick puzzles — becomes one job.
 *  - Jobs never overlap. A request that lands while one is running marks the
 *    runner dirty, and exactly one more job follows, after the delay: the
 *    attempt that arrived mid-upload was read before it existed and must not be
 *    left behind.
 *  - `flush()` runs a pending job now. It is for the tab being hidden, when the
 *    browser may freeze the page before the timer fires; with nothing pending it
 *    does nothing, so hiding an idle tab costs no request. A follow-up owed by a
 *    mid-run request counts as pending: it runs the moment the current job ends
 *    instead of waiting out the delay a hidden page may never get.
 *  - A failing job is reported to `onError` and does not wedge the runner; the
 *    next request tries again.
 */
export interface CoalescingRunner {
  request(): void;
  flush(): void;
  /** Whether a job is scheduled or running. */
  pending(): boolean;
}

export function createCoalescingRunner(opts: {
  delayMs: number;
  run: () => Promise<void>;
  onError?: (err: unknown) => void;
}): CoalescingRunner {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let dirty = false;
  /** `flush()` arrived while a job was running with a follow-up owed. */
  let flushRequested = false;

  const start = () => {
    timer = null;
    if (running) {
      dirty = true;
      return;
    }
    running = true;
    dirty = false;
    opts
      .run()
      .catch((err) => opts.onError?.(err))
      .finally(() => {
        running = false;
        if (!dirty) {
          flushRequested = false;
        } else if (flushRequested) {
          flushRequested = false;
          start();
        } else {
          schedule();
        }
      });
  };

  const schedule = () => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(start, opts.delayMs);
  };

  return {
    request() {
      if (running) dirty = true;
      else schedule();
    },
    flush() {
      if (timer !== null) {
        clearTimeout(timer);
        start();
        return;
      }
      // No timer while a job runs: a mid-run request only marks it dirty. That
      // follow-up is the one that carries the attempt recorded during the
      // upload, so dropping it here lost exactly the data `flush` exists for.
      if (running && dirty) flushRequested = true;
    },
    pending() {
      return timer !== null || running;
    },
  };
}
