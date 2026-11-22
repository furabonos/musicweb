import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import en from './locales/en.json';
import ko from './locales/ko.json';
import { format, I18nProvider, LOCALE_STORAGE_KEY, useI18n } from './i18n';

afterEach(() => localStorage.clear());

describe('언어 파일', () => {
  it('두 언어 파일의 키 집합이 같다', () => {
    expect(Object.keys(ko).sort()).toEqual(Object.keys(en).sort());
  });

  it('빈 문구가 없고, 같은 키의 자리표시({name})가 두 언어에서 같다', () => {
    const holes = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      expect(en[key].trim(), key).not.toBe('');
      expect(ko[key].trim(), key).not.toBe('');
      expect(holes(ko[key]), key).toEqual(holes(en[key]));
    }
  });

  it('format: 자리표시를 채우고, 모르는 이름은 그대로 둔다', () => {
    expect(format('{a} of {b} {c}', { a: 1, b: 'x' })).toBe('1 of x {c}');
  });
});

function Probe() {
  const { locale, setLocale, t } = useI18n();
  return (
    <div>
      <p>{t('auth.signIn')}</p>
      <button type="button" onClick={() => setLocale(locale === 'en' ? 'ko' : 'en')}>
        toggle
      </button>
    </div>
  );
}

describe('I18nProvider', () => {
  it('기본 영어, 바꾸면 문서 언어도 바뀌고 선택을 기억한다', () => {
    const { unmount } = render(
      <I18nProvider>
        <Probe />
      </I18nProvider>,
    );
    expect(screen.getByText('Sign in with Google')).toBeTruthy();
    expect(document.documentElement.lang).toBe('en');
    act(() => screen.getByText('toggle').click());
    expect(screen.getByText('Google로 로그인')).toBeTruthy();
    expect(document.documentElement.lang).toBe('ko');
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('ko');
    unmount();

    render(
      <I18nProvider>
        <Probe />
      </I18nProvider>,
    );
    expect(screen.getByText('Google로 로그인')).toBeTruthy();
  });

  it('저장된 값이 지원 언어가 아니면 영어', () => {
    localStorage.setItem(LOCALE_STORAGE_KEY, 'fr');
    render(
      <I18nProvider>
        <Probe />
      </I18nProvider>,
    );
    expect(screen.getByText('Sign in with Google')).toBeTruthy();
  });
});
