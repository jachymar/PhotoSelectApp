export type AppMode = 'selectra' | 'framecull';

const APP_MODE_STORAGE_KEY = 'selectra_app_mode';

export function loadSavedAppMode(): AppMode {
  try {
    const saved = window.localStorage.getItem(APP_MODE_STORAGE_KEY);
    if (saved === 'framecull' || saved === 'selectra') {
      return saved;
    }
  } catch {
    // Ignore storage read errors
  }
  return 'selectra';
}

export function saveAppMode(mode: AppMode): void {
  try {
    window.localStorage.setItem(APP_MODE_STORAGE_KEY, mode);
  } catch {
    // Ignore storage write errors
  }
}
