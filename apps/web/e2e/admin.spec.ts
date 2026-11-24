import { expect, test } from '@playwright/test';
import { seedPlaylist } from '../../../tools/seed-emulator.ts';
import { ask, resetCatalog, signIn } from './helpers';

/** 관리자 화면 (SPEC 4.11, T22): 비관리자 거부, 긴급 정지가 다른 세션에 바로 적용, 검색 문장 미노출 */
const SECRET = 'my private search sentence 12345';

test.beforeEach(async () => {
  await resetCatalog();
  await seedPlaylist({ id: 'adminSeen1', state: 'saved', songs: [1, 2], privateText: SECRET });
});

test('비관리자는 /admin에서 접근 거부 화면', async ({ page }) => {
  await page.goto('/admin');
  await signIn(page, 'someone@example.com');
  await expect(page.getByRole('alert')).toContainText('Access denied');
  await expect(page.getByRole('heading', { name: 'Kill switches' })).toHaveCount(0);
});

test('관리자가 긴급 정지(만들기)를 끄면 다른 관리자의 만들기가 즉시 실패하고, 켜면 된다', async ({
  page,
  browser,
}) => {
  await page.goto('/admin');
  await signIn(page);
  await expect(page.getByRole('heading', { name: 'Station control room' })).toBeVisible();
  // 검색 문장은 관리자 화면에도 기본으로 나오지 않는다
  await expect(page.locator('body')).not.toContainText(SECRET);

  const otherContext = await browser.newContext();
  const other = await otherContext.newPage();
  await other.goto('/');
  await signIn(other, 'admin2@example.com');

  const create = page.getByRole('checkbox', { name: 'Making sets' });
  await expect(create).toBeChecked();
  // 화면은 서버가 저장한 뒤 다시 불러온 값으로 바뀐다(낙관적 갱신 없음)
  await create.click();
  await expect(page.getByText('Saved.')).toBeVisible();
  await expect(create).not.toBeChecked();

  await other.getByLabel('Describe the music you want').fill('10 songs like Doja by Central Cee');
  await other.getByRole('button', { name: 'Make it' }).click();
  await expect(other.getByRole('alert')).toContainText('paused right now');

  await create.click();
  await expect(create).toBeChecked();
  await ask(other, '10 songs like Doja by Central Cee', 'Make it', 'Describe the music you want');
  await expect(other.locator('ol.songs > li')).toHaveCount(10);
  await otherContext.close();
});
