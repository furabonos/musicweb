/** 지원하는 화면 언어. 기본은 영어(D-013). */
export const SUPPORTED_LOCALES = ['en', 'ko'] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'en';

/** 저장된 값이 지원 언어면 그대로, 아니면 기본 언어를 돌려준다. */
export function resolveLocale(value: string | null | undefined): Locale {
  return SUPPORTED_LOCALES.find((l) => l === value) ?? DEFAULT_LOCALE;
}

export * from './matching/index.js';
