/**
 * Lightweight zero-React-rerender interaction & priority coordinator.
 *
 * Ensures that active user gestures (swiping, scrolling filmstrip/gallery,
 * opening a folder) and foreground P0 photo loads get exclusive main-thread
 * and I/O priority while background tasks (EXIF header scanning, visual
 * similarity fingerprinting, thumbnail downscaling, IndexedDB cache writes)
 * pause cleanly without dropping work.
 */

let interactionActiveUntilMs = 0;
let activeForegroundLoads = 0;
const idleWaiters = new Set<() => void>();
let drainTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleWaiterCheck(): void {
  if (idleWaiters.size === 0 || drainTimer !== null) return;
  const now = Date.now();
  const remainingGestureMs = Math.max(0, interactionActiveUntilMs - now);
  const delay = activeForegroundLoads > 0 ? 60 : Math.max(24, remainingGestureMs + 12);

  drainTimer = setTimeout(() => {
    drainTimer = null;
    if (isSystemBusyForBackground()) {
      scheduleWaiterCheck();
      return;
    }
    const callbacks = Array.from(idleWaiters);
    idleWaiters.clear();
    for (const cb of callbacks) {
      try {
        cb();
      } catch {
        // Ignore individual listener errors
      }
    }
  }, delay);
}

/**
 * Mark an active user gesture or critical view transition for `durationMs`.
 * Safe to call at 60-120Hz (zero allocations when extending window).
 */
export function markInteractionActive(durationMs = 240): void {
  const target = Date.now() + durationMs;
  if (target > interactionActiveUntilMs) {
    interactionActiveUntilMs = target;
  }
}

/**
 * Signal that the currently visible foreground photo (P0) started loading.
 * Returns an idempotent release function so callers can never leak the counter.
 */
export function beginForegroundPhotoLoad(maxHoldMs = 4500): () => void {
  activeForegroundLoads += 1;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    clearTimeout(safetyTimer);
    activeForegroundLoads = Math.max(0, activeForegroundLoads - 1);
    if (!isSystemBusyForBackground() && idleWaiters.size > 0) {
      scheduleWaiterCheck();
    }
  };
  const safetyTimer = setTimeout(release, maxHoldMs);
  return release;
}

export function isInteractionActive(): boolean {
  return Date.now() < interactionActiveUntilMs;
}

export function isSystemBusyForBackground(): boolean {
  return activeForegroundLoads > 0 || Date.now() < interactionActiveUntilMs;
}

/**
 * Resolves immediately if no gesture or foreground P0 load is active;
 * otherwise waits until the interaction window and foreground load settle.
 */
export function waitForBackgroundSlot(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  if (!isSystemBusyForBackground()) return Promise.resolve();

  return new Promise<void>((resolve) => {
    const onDone = () => {
      idleWaiters.delete(onDone);
      signal?.removeEventListener('abort', onDone);
      resolve();
    };
    if (signal) {
      signal.addEventListener('abort', onDone, { once: true });
    }
    idleWaiters.add(onDone);
    scheduleWaiterCheck();
  });
}

/**
 * Bounded timeout wrapper so stalled network/file/Image decode promises
 * reject cleanly instead of hanging a loading slot forever.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label = 'Operation',
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
      },
    );
  });
}
