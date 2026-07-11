'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { translate, type Lang, type StringKey } from './i18n-strings';

interface I18n {
  lang: Lang;
  t: (key: StringKey, params?: Record<string, string | number>) => string;
  setLang: (lang: Lang) => void;
}

const I18nContext = createContext<I18n>({
  lang: 'en',
  t: (key, params) => translate('en', key, params),
  setLang: () => {},
});

export function I18nProvider({ children }: { children: React.ReactNode }) {
  // Starts as English for SSR/hydration consistency; the real preference
  // (stored, else device language) applies right after mount.
  const [lang, setLangState] = useState<Lang>('en');

  useEffect(() => {
    const stored = localStorage.getItem('picbook-lang') as Lang | null;
    const detected: Lang = navigator.language?.toLowerCase().startsWith('he') ? 'he' : 'en';
    setLangState(stored === 'he' || stored === 'en' ? stored : detected);
  }, []);

  useEffect(() => {
    document.documentElement.dir = lang === 'he' ? 'rtl' : 'ltr';
    document.documentElement.lang = lang;
  }, [lang]);

  const setLang = useCallback((l: Lang) => {
    localStorage.setItem('picbook-lang', l);
    setLangState(l);
  }, []);

  const t = useCallback(
    (key: StringKey, params?: Record<string, string | number>) => translate(lang, key, params),
    [lang],
  );

  const value = useMemo(() => ({ lang, t, setLang }), [lang, t, setLang]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18n {
  return useContext(I18nContext);
}
