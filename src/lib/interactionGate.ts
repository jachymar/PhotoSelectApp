/**
 * Lightweight zero-React-rerender interaction & priority coordinator.
 *
 * Separates three priority tiers so touch gestures stay 60fps while high-quality
 * preview lookahead remains near-instantaneous:
 *  - Tier 0 (Active Touch): `beginActiveGesture` / `isTouchGestureActive()`
 *  - Tier 1 (Off-Thread High-Res Preview Lookahead): `waitForPreviewSlot()` — pauses ONLY while a finger is actively touching
 *  - Tier 2 (Folder-Wide Background Scans & Cache Pre-Warming): `waitForBackgroundSlot()` — yields briefly to gestures, P0 loads, and open series
 *  - Tier 3 (Heavy Maintenance / IDB Persistence & Sweeps): `waitForDeepIdle()`
 */

let interactionActiveUntilMs = 0;
let lastActivityAtMs = Date.now();
let activeForegroundLoads = 0;
let activeGestures = 0;
let openSeriesPriorityActive = false;

const idleWaiters: Array<() => void> = [];
const idleWaiterSet = new Set<() => void>();
const previewWaiters: Array<() => void> = [];
const previewWaiterSet = new Set<() => void>();
const busyListeners = new Set<(busy: boolean) => void>();
let drainTimer: ReturnType<typeof setTimeout> | null = null;
let lastNotifiedBusy = false;

const STAGGER_WAKE_GAP_MS = 10;

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

function flushPreviewWaiters(): void {
  if (activeGestures > 0 || previewWaiters.length === 0) return;
  const queued = previewWaiters.splice(0, previewWaiters.length);
  previewWaiterSet.clear();
  for (const wake of queued) {
    try {
      wake();
    } catch {
      // Ignore individual waiter errors
    }
  }
}

function scheduleWaiterCheck(extraDelayMs = 0): void {
  if (idleWaiters.length === 0 || drainTimer !== null) return;
  if (openSeriesPriorityActive || activeGestures > 0) return;

  const now = Date.now();
  const remainingGestureMs = Math.max(0, interactionActiveUntilMs - now);
  const baseDelay =
    activeForegroundLoads > 0 ? 35 : Math.max(12, remainingGestureMs + 8);
  const delay = Math.max(baseDelay, extraDelayMs);

  drainTimer = setTimeout(() => {
    drainTimer = null;
    if (isSystemBusyForBackground()) {
      scheduleWaiterCheck();
      return;
    }

    notifyBusyChange();

    // Wake background waiters in a light staggered cadence to avoid sudden bursts
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
 * Prioritize an explicitly open series: suspends unrelated folder-wide
 * background scanning, fingerprinting, and non-series cache pre-warming.
 */
export function setOpenSeriesPriority(active: boolean): void {
  if (openSeriesPriorityActive === active) return;
  openSeriesPriorityActive = active;
  if (active) {
    lastActivityAtMs = Date.now();
    notifyBusyChange();
  } else {
    markInteractionActive(140);
    if (!isSystemBusyForBackground() && idleWaiters.length > 0) {
      scheduleWaiterCheck();
    }
  }
}

export function isOpenSeriesPriorityActive(): boolean {
  return openSeriesPriorityActive;
}

/**
 * Mark a brief user interaction or transition window for `durationMs`.
 * Safe to call at 60-120Hz (zero allocations when extending window).
 */
export function markInteractionActive(durationMs = 160): void {
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
 * Ref-counted continuous gesture lock (e.g., while a finger is down on the Filmstrip
 * or SeriesScrubStrip). Pauses off-thread preview decoding ONLY while held, and pauses
 * folder-wide background waves for a brief post-release settle window.
 */
export function beginActiveGesture(
  maxHoldMs = 12_000,
  postReleaseCooldownMs = 160
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
    if (activeGestures === 0) {
      flushPreviewWaiters();
    }
    if (postReleaseCooldownMs > 0) {
      markInteractionActive(postReleaseCooldownMs);
    }
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

/**
 * True ONLY while a finger/pointer is actively pressed and moving in a gesture.
 */
export function isTouchGestureActive(): boolean {
  return activeGestures > 0;
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
 * Fast-path gate for high-priority off-thread preview decoding (next-queue photos):
 * pauses ONLY while a finger is physically pressed on the screen, and resumes
 * immediately with 0ms cooldown the instant the finger lifts.
 */
export function waitForPreviewSlot(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  if (activeGestures === 0) return Promise.resolve();

  return new Promise<void>((resolve) => {
    const onDone = () => {
      if (previewWaiterSet.delete(onDone)) {
        const idx = previewWaiters.indexOf(onDone);
        if (idx !== -1) previewWaiters.splice(idx, 1);
      }
      signal?.removeEventListener('abort', onDone);
      resolve();
    };
    if (signal) {
      signal.addEventListener('abort', onDone, { once: true });
    }
    previewWaiterSet.add(onDone);
    previewWaiters.push(onDone);
  });
}

/**
 * Resolves immediately if no gesture, open-series priority, or foreground P0 load is active;
 * otherwise waits until the interaction window, open series, and foreground load settle.
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
 * Waits until the app has been quiet (no active gestures, no foreground loads,
 * no open series, and at least `minIdleMs` since the last user interaction) before running
 * maintenance tasks like IndexedDB series persistence or cache expiry sweeps.
 */
export async function waitForDeepIdle(
  minIdleMs = 900,
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
            { timeout: 450 }
          );
        });
      }
      if (signal?.aborted) return;
      if (!isSystemBusyForBackground() && Date.now() - lastActivityAtMs >= minIdleMs) {
        return;
      }
    } else {
      const waitMs = Math.max(100, Math.min(600, minIdleMs - elapsed + 40));
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
