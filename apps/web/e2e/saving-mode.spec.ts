import { expect, test } from '@playwright/test';
import { setRuntime } from '../../../tools/seed-emulator.ts';
import { ask, resetCatalog, signIn } from './helpers';

/** 절약 모드 (SPEC 3.4, T22b): 가짜 AI를 쓰지 않는 상태에서 요청 → 재생목록과 안내 */
test.beforeEach(async () => {
  await resetCatalog();
  await setRuntime({ savingMode: true });
});

test('절약 모드면 안내가 보이고, 규칙으로 읽히는 요청은 AI 없이 10곡과 고정 이유 문장', async ({
  page,
}) => {
  await page.goto('/');
  await signIn(page);
  await expect(page.getByTestId('saving-mode')).toContainText('Saving mode');

  await ask(page, '10 songs like Doja by Central Cee', 'Go live', 'Describe the music you want');
  const songs = page.locator('ol.songs > li');
  await expect(songs).toHaveCount(10);
  // 가짜 AI의 이유("Demo pick: …")가 아니라 AI 없는 방식의 고정 문장
  await expect(songs.first()).toContainText('also play this');
  await expect(page.locator('ol.songs')).not.toContainText('Demo pick');
});

test('절약 모드에서 규칙으로 못 읽는 문장은 형식 안내와 함께 다시 묻는다', async ({ page }) => {
  await page.goto('/');
  await signIn(page);
  await page.getByLabel('Describe the music you want').fill('something chill for studying');
  await page.getByRole('button', { name: 'Go live' }).click();
  await expect(page.getByRole('alert')).toContainText('Song by Artist');
});
