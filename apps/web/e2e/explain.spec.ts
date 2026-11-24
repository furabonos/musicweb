import { expect, test } from '@playwright/test';
import { setRuntime } from '../../../tools/seed-emulator.ts';
import { ask, resetCatalog, signIn } from './helpers';

/** 자세한 이유 (SPEC 4.3, T34): 버튼 → 이유 표시, 절약 모드에서 버튼 꺼짐 */
test.beforeEach(resetCatalog);

test('자세한 이유 버튼 → 곡마다 AI 이유가 보인다', async ({ page }) => {
  await page.goto('/');
  await signIn(page);
  await ask(page, '10 songs like Doja by Central Cee', 'Make it', 'Describe the music you want');
  await page.getByRole('button', { name: 'More detail' }).click();
  await expect(page.locator('.song-detail')).toHaveCount(10);
  await expect(page.locator('.song-detail').first()).toContainText('Demo detail: ');
  await expect(page.getByRole('button', { name: 'More detail' })).toHaveAttribute(
    'aria-disabled',
    'true',
  );
});

test('절약 모드에서는 버튼이 꺼져 있고 안내가 보인다', async ({ page }) => {
  await setRuntime({ savingMode: true });
  await page.goto('/');
  await signIn(page);
  await ask(page, '10 songs like Doja by Central Cee', 'Make it', 'Describe the music you want');
  await expect(page.getByRole('button', { name: 'More detail' })).toHaveAttribute(
    'aria-disabled',
    'true',
  );
  await expect(page.getByText('More detail is paused in simple mode.')).toBeVisible();
});
