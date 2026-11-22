import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SECURITY_HEADERS } from '../apps/web/vite.config.ts';

/** Referrer-Policy (T15, 스킬 youtube-policy): YouTube 플레이어가 Referer를 받아야 한다. */
const firebase = JSON.parse(readFileSync('firebase.json', 'utf8')) as {
  hosting: { headers?: { source: string; headers: { key: string; value: string }[] }[] };
};

describe('사이트 응답 헤더', () => {
  it('배포(firebase.json)에 모든 주소의 Referrer-Policy가 있고 no-referrer가 아니다', () => {
    const all = firebase.hosting.headers?.find((h) => h.source === '**');
    const rp = all?.headers.find((h) => h.key.toLowerCase() === 'referrer-policy')?.value;
    expect(
      rp,
      'firebase.json hosting.headers에 source "**"의 Referrer-Policy를 두세요',
    ).toBeDefined();
    expect(rp).not.toBe('no-referrer');
    expect(rp).not.toBe('same-origin');
  });

  it('개발 서버(vite)와 배포의 값이 같다', () => {
    const all = firebase.hosting.headers?.find((h) => h.source === '**');
    const rp = all?.headers.find((h) => h.key.toLowerCase() === 'referrer-policy')?.value;
    expect(SECURITY_HEADERS['Referrer-Policy']).toBe(rp);
  });

  it('index.html에 referrer를 막는 meta가 없다', () => {
    const html = readFileSync('apps/web/index.html', 'utf8');
    expect(html).not.toMatch(/<meta[^>]+name=["']referrer["']/i);
  });
});
