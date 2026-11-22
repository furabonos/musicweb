import { expect, test } from '@playwright/test';
import { seedPlaylist, setRuntime } from '../../../tools/seed-emulator.ts';
import { fakeCalls, useFakeYouTube } from './fakeYouTube';
import { resetCatalog } from './helpers';

const SECRET = 'my private search sentence 12345';

test.beforeEach(async ({ page }) => {
  await resetCatalog();
  await seedPlaylist({ id: 'shareSaved1', state: 'saved', songs: [1, 2, 3], privateText: SECRET });
  await seedPlaylist({ id: 'shareDraft1', state: 'draft', songs: [1], privateText: SECRET });
  await useFakeYouTube(page);
});

test('로그아웃 상태로 /p/:id 열기 — 곡·재생 버튼·YouTube 링크, 검색 문장은 안 보임', async ({
  page,
}) => {
  await page.goto('/p/shareSaved1');
  await expect(page.getByRole('heading', { name: 'Shared set' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in with Google' })).toBeVisible();
  await expect(page.locator('ol.songs > li')).toHaveCount(3);
  await expect(page.getByText('Based on Doja · Central Cee')).toBeVisible();

  const open = page.getByRole('link', { name: 'Open in YouTube' });
  await expect(open).toHaveAttribute(
    'href',
    'https://www.youtube.com/watch_videos?video_ids=demoVid0002,demoVid0003,demoVid0004',
  );
  await expect(page.getByText(/save it there yourself/)).toBeVisible();
  await expect(page.locator('body')).not.toContainText(SECRET);

  // 재생: 처음엔 올려만 두고, 누르면 재생
  await expect.poll(() => fakeCalls(page)).toEqual(['cue:demoVid0002']);
  await page.getByRole('button', { name: 'Play Commitment Issues' }).click();
  await expect.poll(() => fakeCalls(page)).toContain('load:demoVid0003');
  // 보기 전용: 빼기·바꾸기 없음
  await expect(page.getByRole('button', { name: /^Remove / })).toHaveCount(0);
});

test('링크가 깨진 상태(fallback)면 곡별 YouTube 링크 목록', async ({ page }) => {
  await setRuntime({ youtubeOpenLink: 'fallback' });
  await page.goto('/p/shareSaved1');
  await expect(page.getByRole('heading', { name: 'Shared set' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open in YouTube' })).toHaveCount(0);
  const links = page.locator('.open-list a');
  await expect(links).toHaveCount(3);
  await expect(links.first()).toHaveAttribute(
    'href',
    'https://www.youtube.com/watch?v=demoVid0002',
  );
});

test('저장 전(draft) 재생목록은 로그아웃 상태로 열리지 않음', async ({ page }) => {
  await page.goto('/p/shareDraft1');
  await expect(page.getByRole('alert')).toContainText("doesn't exist or hasn't been shared");
  await expect(page.locator('body')).not.toContainText(SECRET);
});
