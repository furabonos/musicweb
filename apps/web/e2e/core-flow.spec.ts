import { expect, test } from '@playwright/test';
import { ask, resetCatalog, signIn } from './helpers';

test.beforeEach(resetCatalog);

test('요청 입력 → 10곡 표시 → 1곡 빼기 → 저장', async ({ page }) => {
  await page.goto('/');
  await signIn(page);
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();

  await ask(page, '10 songs like Doja by Central Cee', 'Go live', 'Describe the music you want');
  const songs = page.locator('ol.songs > li');
  await expect(songs).toHaveCount(10);
  await expect(page.getByText('Based on Doja · Central Cee')).toBeVisible();
  // 가짜 AI가 쓴 영어 이유
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
});
