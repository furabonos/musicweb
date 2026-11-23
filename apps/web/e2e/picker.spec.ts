import { expect, test } from '@playwright/test';
import { resetCatalog, signIn } from './helpers';

/** 곡 고르기 (SPEC 4.2, T33): 곡 검색 → 고르기 → 곡 수 15 → 라이브 버튼 → 15곡 표시 */
test.beforeEach(resetCatalog);

test('곡 검색 → 고르기 → 곡 수 15 → 라이브 → 15곡', async ({ page }) => {
  await page.goto('/');
  await signIn(page);
  await page.getByRole('combobox', { name: 'Song or artist' }).fill('Doj');
  await page.getByRole('option', { name: /Doja/ }).click();
  await expect(page.getByText('Doja — Central Cee')).toBeVisible();
  await page.getByRole('combobox', { name: 'Songs' }).selectOption('15');
  await page.getByRole('button', { name: 'Live', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Live', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.getByRole('button', { name: 'Make the set' }).click();
  await expect(page.locator('ol.songs > li')).toHaveCount(15, { timeout: 30_000 });
  await expect(page.getByText('Based on Doja · Central Cee')).toBeVisible();
});
