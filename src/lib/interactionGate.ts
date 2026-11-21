/**
 * Lightweight zero-React-rerender interaction & priority coordinator.
 *
 * Ensures that active user gestures (touching, swiping, scrolling filmstrip/gallery,
 * scrubbing series, opening a folder) and foreground P0 photo loads get exclusive
 * main-thread and I/O priority while background tasks (EXIF header scanning, visual
 * similarity fingerprinting, thumbnail downscaling, IndexedDB cache writes/sweeps)
 * pause cleanly and resume in a staggered, non-bursty cadence.
 */

let interactionActiveUntilMs = 0;
let lastActivityAtMs = Date.now();
let activeForegroundLoads = 0;
let activeGestures = 0;
let openSeriesPriorityActive = false;

const idleWaiters: Array<() => void> = [];
const idleWaiterSet = new Set<() => void>();
const busyListeners = new Set<(busy: boolean) => void>();
let drainTimer: ReturnType<typeof setTimeout> | null = null;
let lastNotifiedBusy = false;

const STAGGER_WAKE_GAP_MS = 38;

function notifyBusyChange(): void {
  const busy = isSystemBusyForBackground();
  if (busy === lastNotifiedBusy) return;
  lastNotifiedBusy = busy;
  for (const listener of busyListeners) {
    try {
      listener(busy);
    } catch {
      // Ignore individual listener errors
    }
  }
}

function scheduleWaiterCheck(extraDelayMs = 0): void {
  if (idleWaiters.length === 0 || drainTimer !== null) return;
  if (openSeriesPriorityActive || activeGestures > 0) return;

  const now = Date.now();
  const remainingGestureMs = Math.max(0, interactionActiveUntilMs - now);
  const baseDelay =
    activeForegroundLoads > 0 ? 75 : Math.max(28, remainingGestureMs + 16);
  const delay = Math.max(baseDelay, extraDelayMs);

  drainTimer = setTimeout(() => {
    drainTimer = null;
    if (isSystemBusyForBackground()) {
      scheduleWaiterCheck();
      return;
    }

    notifyBusyChange();

    // Wake ONLY ONE background waiter per tick (staggered) to prevent thundering-herd CPU/IO spikes
    const next = idleWaiters.shift();
    if (next) {
      idleWaiterSet.delete(next);
      try {
        next();
      } catch {
        // Ignore individual waiter errors
      }
    }

    if (idleWaiters.length > 0 && !isSystemBusyForBackground()) {
      scheduleWaiterCheck(STAGGER_WAKE_GAP_MS);
    }
  }, delay);
}

/**
 * Subscribe to transitions between busy (user interacting / P0 loading / series open) and idle.
 */
export function subscribeBusyState(
  listener: (busy: boolean) => void
): () => void {
  busyListeners.add(listener);
  return () => {
    busyListeners.delete(listener);
  };
}

/**
 * Prioritize an explicitly open series: suspends all unrelated folder-wide
 * background scanning, fingerprinting, and non-series cache encoding.
 */
export function setOpenSeriesPriority(active: boolean): void {
  if (openSeriesPriorityActive === active) return;
  openSeriesPriorityActive = active;
  if (active) {
    lastActivityAtMs = Date.now();
    notifyBusyChange();
  } else {
    markInteractionActive(380);
    if (!isSystemBusyForBackground() && idleWaiters.length > 0) {
      scheduleWaiterCheck();
    }
  }
}

export function isOpenSeriesPriorityActive(): boolean {
  return openSeriesPriorityActive;
}

/**
 * Mark an active user gesture or critical view transition for `durationMs`.
 * Safe to call at 60-120Hz (zero allocations when extending window).
 */
export function markInteractionActive(durationMs = 450): void {
  const now = Date.now();
  lastActivityAtMs = now;
  const target = now + durationMs;
  if (target > interactionActiveUntilMs) {
    interactionActiveUntilMs = target;
  }
  if (!lastNotifiedBusy) {
    notifyBusyChange();
  }
}

/**
 * Ref-counted continuous gesture lock (e.g., while a finger is down on the Filmstrip,
 * SeriesScrubStrip, or swipe card). Keeps background work paused for the entire gesture
 * plus a smooth post-release cooldown for momentum deceleration.
 */
export function beginActiveGesture(
  maxHoldMs = 15_000,
  postReleaseCooldownMs = 600
): () => void {
  activeGestures += 1;
  lastActivityAtMs = Date.now();
  notifyBusyChange();

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    clearTimeout(safetyTimer);
    activeGestures = Math.max(0, activeGestures - 1);
    markInteractionActive(postReleaseCooldownMs);
    if (!isSystemBusyForBackground() && idleWaiters.length > 0) {
      scheduleWaiterCheck();
    }
  };

  const safetyTimer = setTimeout(release, maxHoldMs);
  return release;
}

/**
 * Signal that the currently visible foreground photo (P0) started loading.
 * Returns an idempotent release function so callers can never leak the counter.
 */
export function beginForegroundPhotoLoad(maxHoldMs = 4500): () => void {
  activeForegroundLoads += 1;
  lastActivityAtMs = Date.now();
  notifyBusyChange();

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    clearTimeout(safetyTimer);
    activeForegroundLoads = Math.max(0, activeForegroundLoads - 1);
    if (!isSystemBusyForBackground()) {
      notifyBusyChange();
      if (idleWaiters.length > 0) {
        scheduleWaiterCheck();
      }
    }
  };
  const safetyTimer = setTimeout(release, maxHoldMs);
  return release;
}

export function isInteractionActive(): boolean {
  return activeGestures > 0 || Date.now() < interactionActiveUntilMs;
}

export function isSystemBusyForBackground(): boolean {
  return (
    openSeriesPriorityActive ||
    activeGestures > 0 ||
    activeForegroundLoads > 0 ||
    Date.now() < interactionActiveUntilMs
  );
}

/**
 * Resolves immediately if no gesture, open-series priority, or foreground P0 load is active;
 * otherwise waits until the interaction window, open series, and foreground load settle,
 * waking up in a staggered queue so multiple background loops never burst in the same frame.
 */
export function waitForBackgroundSlot(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  if (!isSystemBusyForBackground()) return Promise.resolve();

  return new Promise<void>((resolve) => {
    const onDone = () => {
      if (idleWaiterSet.delete(onDone)) {
        const idx = idleWaiters.indexOf(onDone);
        if (idx !== -1) idleWaiters.splice(idx, 1);
      }
      signal?.removeEventListener('abort', onDone);
      resolve();
    };
    if (signal) {
      signal.addEventListener('abort', onDone, { once: true });
    }
    idleWaiterSet.add(onDone);
    idleWaiters.push(onDone);
    scheduleWaiterCheck();
  });
}

/**
 * Waits until the app has been completely quiet (no active gestures, no foreground loads,
 * no open series, and at least `minIdleMs` since the last user interaction) before running
 * heavy maintenance tasks like IndexedDB persistence or cache expiry sweeps.
 */
export async function waitForDeepIdle(
  minIdleMs = 1200,
  signal?: AbortSignal
): Promise<void> {
  while (!signal?.aborted) {
    await waitForBackgroundSlot(signal);
    if (signal?.aborted) return;

    const elapsed = Date.now() - lastActivityAtMs;
    if (elapsed >= minIdleMs && !isSystemBusyForBackground()) {
      if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
        await new Promise<void>((resolve) => {
          const onAbort = () => resolve();
          signal?.addEventListener('abort', onAbort, { once: true });
          const ric = (
            window as unknown as {
              requestIdleCallback: (
                cb: () => void,
                opts?: { timeout?: number }
              ) => number;
            }
          ).requestIdleCallback;
          ric(
            () => {
              signal?.removeEventListener('abort', onAbort);
              resolve();
            },
            { timeout: 600 }
          );
        });
      }
      if (signal?.aborted) return;
      if (!isSystemBusyForBackground() && Date.now() - lastActivityAtMs >= minIdleMs) {
        return;
      }
    } else {
      const waitMs = Math.max(120, Math.min(800, minIdleMs - elapsed + 50));
      await new Promise<void>((resolve) => {
        const onAbort = () => {
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        }, waitMs);
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    }
  }
}

/**
 * Bounded timeout wrapper so stalled network/file/Image decode promises
 * reject cleanly instead of hanging a loading slot forever.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label = 'Operation'
): Promise<T> {
  if (timeoutMs <= 0) return promise;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}
