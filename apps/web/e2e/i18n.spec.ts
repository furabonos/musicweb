import { expect, test } from '@playwright/test';
import { ask, resetCatalog, signIn } from './helpers';

test.beforeEach(resetCatalog);

test('기본 영어 → 언어 버튼으로 한국어 → 새로고침 후에도 유지 → 곡 이유도 한국어로 요청됨', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Call in a song.');

  await page.getByRole('button', { name: '한국어' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('곡 하나만 말해 주세요.');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ko');

  await page.reload();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('곡 하나만 말해 주세요.');
  await expect(page.getByRole('button', { name: '한국어' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  await signIn(page);
  const request = page.waitForRequest((r) => r.url().includes('playlists-create'));
  await ask(
    page,
    'Central Cee의 Doja 같은 곡 10개',
    '틀어 줘',
    '듣고 싶은 음악을 말로 적어 주세요',
  );
  expect((await request).postDataJSON()).toMatchObject({ data: { locale: 'ko' } });
  // 이유 문장은 받은 화면 언어로 만든다 → 한국어 이유가 보이면 언어가 추천까지 전달된 것
  await expect(page.locator('ol.songs > li').first()).toContainText(
    '「Doja」 청취자들이 함께 듣는 곡이에요.',
  );
});
