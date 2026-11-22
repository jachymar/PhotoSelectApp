import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';

export type AppLanguage = 'cs' | 'en';

const LANGUAGE_STORAGE_KEY = 'selectra_app_language_v1';

const APP_TITLES: Record<AppLanguage, string> = {
  cs: 'Selectra — Chytré třídění fotek',
  en: 'Selectra — Smart Photo Culling',
};

function readInitialLanguage(): AppLanguage {
  if (typeof window === 'undefined') return 'cs';
  try {
    const raw = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
    if (raw === 'en' || raw === 'cs') return raw;
  } catch {
    // Ignore storage read errors
  }
  return 'cs';
}

let currentLanguage: AppLanguage = readInitialLanguage();
const listeners = new Set<(lang: AppLanguage) => void>();

function applyDocumentLanguage(lang: AppLanguage): void {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = lang;
  document.title = APP_TITLES[lang];
}

export function getCurrentLanguage(): AppLanguage {
  return currentLanguage;
}

export function getIntlLocale(lang: AppLanguage = currentLanguage): string {
  return lang === 'en' ? 'en-US' : 'cs-CZ';
}

export function setAppLanguage(next: AppLanguage): void {
  const normalized: AppLanguage = next === 'en' ? 'en' : 'cs';
  currentLanguage = normalized;
  try {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(LANGUAGE_STORAGE_KEY, normalized);
    }
  } catch {
    // Ignore storage write errors
  }
  applyDocumentLanguage(normalized);
  for (const listener of listeners) {
    listener(normalized);
  }
}

export function tr(
  cs: string,
  en: string,
  lang: AppLanguage = currentLanguage
): string {
  return lang === 'en' ? en : cs;
}

export function pluralCsEn(
  count: number,
  csForms: [string, string, string],
  enForms: [string, string],
  lang: AppLanguage = currentLanguage
): string {
  const abs = Math.abs(count);
  if (lang === 'en') {
    return abs === 1 ? enForms[0] : enForms[1];
  }
  if (abs === 1) return csForms[0];
  if (abs >= 2 && abs <= 4) return csForms[1];
  return csForms[2];
}

export function formatLocalizedNumber(
  value: number,
  lang: AppLanguage = currentLanguage
): string {
  return value.toLocaleString(getIntlLocale(lang));
}

export interface I18nContextValue {
  lang: AppLanguage;
  isEn: boolean;
  locale: string;
  setLang: (next: AppLanguage) => void;
  t: (cs: string, en: string) => string;
  formatNumber: (value: number) => string;
  plural: (
    count: number,
    csForms: [string, string, string],
    enForms: [string, string]
  ) => string;
}

const I18nContext = createContext<I18nContextValue>({
  lang: 'cs',
  isEn: false,
  locale: 'cs-CZ',
  setLang: setAppLanguage,
  t: (cs, en) => tr(cs, en, 'cs'),
  formatNumber: (v) => formatLocalizedNumber(v, 'cs'),
  plural: (n, csForms, enForms) => pluralCsEn(n, csForms, enForms, 'cs'),
});

export const I18nProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const [lang, setLangState] = useState<AppLanguage>(() => getCurrentLanguage());

  useEffect(() => {
    applyDocumentLanguage(lang);
    const onChange = (next: AppLanguage) => {
      setLangState(next);
    };
    listeners.add(onChange);
    return () => {
      listeners.delete(onChange);
    };
  }, [lang]);

  const setLang = useCallback((next: AppLanguage) => {
    setAppLanguage(next);
  }, []);

  const value = useMemo<I18nContextValue>(() => {
    const locale = getIntlLocale(lang);
    return {
      lang,
      isEn: lang === 'en',
      locale,
      setLang,
      t: (cs: string, en: string) => (lang === 'en' ? en : cs),
      formatNumber: (v: number) => v.toLocaleString(locale),
      plural: (
        count: number,
        csForms: [string, string, string],
        enForms: [string, string]
      ) => pluralCsEn(count, csForms, enForms, lang),
    };
  }, [lang, setLang]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
};

export function useI18n(): I18nContextValue {
  return useContext(I18nContext);
}
