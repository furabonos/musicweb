import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { DEFAULT_LOCALE, resolveLocale, type Locale } from '@musicweb/shared';
import en from './locales/en.json';
import ko from './locales/ko.json';

/**
 * 화면 언어 (SPEC 4.8, D-013). 기본 영어, 상단 언어 버튼으로 바꾸고 선택을 기억한다(localStorage).
 * 브라우저 언어·접속 국가는 보지 않는다. 두 언어 파일의 키는 같아야 한다(i18n.test.ts).
 */
export type MessageKey = keyof typeof en;
export const MESSAGES: Record<Locale, Record<MessageKey, string>> = { en, ko };
export const LOCALE_STORAGE_KEY = 'musicweb.locale';

export function format(template: string, vars: Record<string, string | number> = {}): string {
  return template.replace(/\{(\w+)\}/g, (m, name: string) =>
    name in vars ? String(vars[name]) : m,
  );
}

function readStored(): Locale {
  try {
    return resolveLocale(localStorage.getItem(LOCALE_STORAGE_KEY));
  } catch {
    return DEFAULT_LOCALE; // 저장소를 못 쓰는 브라우저(비공개 창 등)는 기본 언어
  }
}

interface I18n {
  locale: Locale;
  setLocale(l: Locale): void;
  t(key: MessageKey, vars?: Record<string, string | number>): string;
}

const Ctx = createContext<I18n | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(readStored);
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
  const setLocale = useCallback((l: Locale) => {
    setLocaleState(l);
    try {
      localStorage.setItem(LOCALE_STORAGE_KEY, l);
    } catch {
      // 기억하지 못해도 이번 화면에서는 바뀐다
    }
  }, []);
  const value = useMemo<I18n>(
    () => ({ locale, setLocale, t: (key, vars) => format(MESSAGES[locale][key], vars) }),
    [locale, setLocale],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useI18n(): I18n {
  const v = useContext(Ctx);
  if (!v) throw new Error('I18nProvider 안에서 쓰세요.');
  return v;
}
