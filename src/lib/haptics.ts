export type HapticIntensity = 'light' | 'medium' | 'heavy';

export type HapticKind =
  | 'threshold'
  | 'keep'
  | 'trash'
  | 'selection'
  | 'confirm'
  | 'undo'
  | 'warning';

export interface HapticSettings {
  enabled: boolean;
  intensity: HapticIntensity;
}

const STORAGE_KEY = 'framecull_haptic_settings';

const DEFAULT_HAPTIC_SETTINGS: HapticSettings = {
  enabled: true,
  intensity: 'medium',
};

const VIBRATION_PATTERNS: Record<
  HapticIntensity,
  Record<HapticKind, number | number[]>
> = {
  light: {
    threshold: 6,
    keep: 10,
    trash: [10, 20, 10],
    selection: 7,
    confirm: [12, 24, 16],
    undo: 8,
    warning: [14, 28, 20],
  },
  medium: {
    threshold: 12,
    keep: 20,
    trash: [18, 28, 24],
    selection: 14,
    confirm: [22, 30, 32],
    undo: 16,
    warning: [28, 36, 40],
  },
  heavy: {
    threshold: 20,
    keep: 34,
    trash: [30, 32, 42],
    selection: 24,
    confirm: [36, 36, 52],
    undo: 26,
    warning: [42, 40, 60],
  },
};

export function loadHapticSettings(): HapticSettings {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_HAPTIC_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<HapticSettings>;
    const intensity: HapticIntensity =
      parsed.intensity === 'light' ||
      parsed.intensity === 'medium' ||
      parsed.intensity === 'heavy'
        ? parsed.intensity
        : 'medium';
    return {
      enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : true,
      intensity,
    };
  } catch {
    return DEFAULT_HAPTIC_SETTINGS;
  }
}

export function saveHapticSettings(settings: HapticSettings): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Ignore storage quota or private browsing errors
  }
}

export function isHapticsSupported(): boolean {
  if (typeof window === 'undefined') return false;
  if (window.FrameCullNative?.triggerHaptic) return true;
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.vibrate === 'function'
  );
}

export function isIOSDevice(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /iphone|ipad|ipod/i.test(navigator.userAgent);
}

export function triggerHaptic(
  kind: HapticKind,
  settings?: HapticSettings
): void {
  const effective = settings ?? loadHapticSettings();
  if (!effective.enabled) return;

  try {
    if (typeof window !== 'undefined' && window.FrameCullNative?.triggerHaptic) {
      void window.FrameCullNative.triggerHaptic(effective.intensity, kind);
      return;
    }

    if (
      typeof navigator !== 'undefined' &&
      typeof navigator.vibrate === 'function'
    ) {
      const pattern = VIBRATION_PATTERNS[effective.intensity][kind];
      navigator.vibrate(pattern);
    }
  } catch {
    // Ignore haptic failures on restricted webviews
  }
}
