import { expect, test } from '@playwright/test';
import { ask, resetCatalog, signIn } from './helpers';

test.beforeEach(resetCatalog);

test('요청 입력 → 10곡 표시 → 1곡 빼기 → 저장', async ({ page }) => {
  await page.goto('/');
  await signIn(page);
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();

  await ask(page, '10 songs like Doja by Central Cee', 'Make it', 'Describe the music you want');
  const songs = page.locator('ol.songs > li');
  await expect(songs).toHaveCount(10);
  await expect(page.getByText('Based on Doja · Central Cee')).toBeVisible();
  // 기본은 AI 방식(T31 측정, D-052): 에뮬레이터의 가짜 AI가 고르고 이유를 쓴다
  await expect(songs.first()).toContainText('Demo pick: people who play Doja also play this.');

  const remove = songs.nth(2).getByRole('button', { name: /^Remove / });
  const title = ((await remove.getAttribute('aria-label')) ?? '').replace(/^Remove /, '');
  expect(title).not.toBe('');
  await remove.click();
  await expect(songs).toHaveCount(9);
  await expect(page.locator('ol.songs .song-title')).not.toContainText([title]);

  await page.getByRole('button', { name: 'Save & get share link' }).click();
  const link = page.getByRole('link', { name: /\/p\/[A-Za-z0-9]+$/ });
  await expect(link).toBeVisible();
  await expect(page.getByRole('button', { name: /^Remove / }).first()).toBeDisabled();

  // 공유 주소를 로그아웃한 다른 브라우저 상태로 열면 저장한 9곡이 보인다(T16)
  const href = (await link.getAttribute('href')) ?? '';
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.goto(href);
  await expect(page.getByRole('heading', { name: 'Shared set' })).toBeVisible();
  await expect(page.locator('ol.songs > li')).toHaveCount(9);
});
