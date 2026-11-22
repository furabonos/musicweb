import { expect, test } from '@playwright/test';
import { fakeCalls, useFakeYouTube } from './fakeYouTube';
import { ask, resetCatalog, signIn } from './helpers';

test.beforeEach(resetCatalog);

test('응답 헤더 Referrer-Policy가 referer를 막지 않음', async ({ page }) => {
  const res = await page.goto('/');
  const rp = res?.headers()['referrer-policy'];
  expect(rp).toBeDefined();
  expect(rp).not.toBe('no-referrer');
  expect(await page.locator('meta[name="referrer"]').count()).toBe(0);
});

test.describe('플레이어 (가짜 YouTube API)', () => {
  test.beforeEach(async ({ page }) => {
    await useFakeYouTube(page);
    await page.goto('/');
    await signIn(page);
    await ask(page, '10 songs like Doja by Central Cee', 'Go live', 'Describe the music you want');
  });

  test('플레이어 영역 ≥480×270, nocookie 주소, 위에 겹친 요소 없음', async ({ page }) => {
    const frame = page.locator('.player-frame iframe');
    await expect(frame).toBeVisible();
    // 플레이어는 하나만 (지운 플레이어가 남지 않음)
    await expect(page.locator('iframe')).toHaveCount(1);
    await frame.scrollIntoViewIfNeeded();
    const box = await frame.boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(480);
    expect(box?.height).toBeGreaterThanOrEqual(270);
    await expect(frame).toHaveAttribute('data-host', 'https://www.youtube-nocookie.com');
    // 플레이어 영역의 여러 지점에서 맨 위 요소가 플레이어 iframe 자신이어야 한다
    const covered = await frame.evaluate((f) => {
      const r = f.getBoundingClientRect();
      const pts: [number, number][] = [];
      for (const fx of [0.02, 0.25, 0.5, 0.75, 0.98])
        for (const fy of [0.02, 0.25, 0.5, 0.75, 0.98])
          pts.push([r.left + r.width * fx, r.top + r.height * fy]);
      return pts.filter(([x, y]) => document.elementFromPoint(x, y) !== f).length;
    });
    expect(covered).toBe(0);
  });

  test('첫 재생은 클릭 전 시작하지 않음, 곡을 누르면 재생, 끝나면 다음 곡', async ({ page }) => {
    await expect.poll(() => fakeCalls(page)).toEqual(['cue:demoVid0002']);
    await page.waitForTimeout(500);
    expect(await fakeCalls(page)).toEqual(['cue:demoVid0002']);

    await page.getByRole('button', { name: 'Play Sprinter' }).click();
    await expect.poll(() => fakeCalls(page)).toEqual(['cue:demoVid0002', 'load:demoVid0002']);
    await page.evaluate(() => (window as unknown as { __fakeYT: { end(): void } }).__fakeYT.end());
    await expect.poll(() => fakeCalls(page)).toContain('load:demoVid0003');
    await expect(page.locator('ol.songs > li').nth(1)).toHaveAttribute('aria-current', 'true');
  });

  test('오류 150이면 기록을 보내고 다음 곡으로 건너뜀', async ({ page }) => {
    await page.getByRole('button', { name: 'Play Sprinter' }).click();
    const report = page.waitForRequest((r) => r.url().includes('playback-reportEmbedBlocked'));
    await page.evaluate(() =>
      (window as unknown as { __fakeYT: { error(c: number): void } }).__fakeYT.error(150),
    );
    expect((await report).postDataJSON()).toEqual({ data: { code: 150 } });
    await expect.poll(() => fakeCalls(page)).toContain('load:demoVid0003');
  });
});
