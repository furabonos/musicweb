import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { seedPlaylist, seedStatus } from '../../../tools/seed-emulator.ts';
import { useFakeYouTube } from './fakeYouTube';
import { ask, resetCatalog, signIn } from './helpers';

/**
 * 화면 캡처 (SPEC 4.9, T20, D-038): PR 본문의 수정 전후 캡처를 만든다. 검사가 아니라 사진 찍기다.
 * `pnpm capture`(에뮬레이터 + 가짜 데이터)로 실행하고, 파일 이름은 `.spec`이 아니라 보통 e2e에는 안 들어간다.
 * 저장 위치: CAPTURE_DIR(기본 저장소 루트의 .auto-fix/captures) / CAPTURE_LABEL(기본 after)
 */
const dir = join(
  resolve(process.env.CAPTURE_DIR ?? join(process.cwd(), '..', '..', '.auto-fix', 'captures')),
  process.env.CAPTURE_LABEL ?? 'after',
);
mkdirSync(dir, { recursive: true });
const shot = (page: import('@playwright/test').Page, name: string) =>
  page.screenshot({ path: join(dir, `${name}.png`), fullPage: true });

test.beforeEach(async ({ page }) => {
  await resetCatalog();
  await useFakeYouTube(page);
});

test('첫 화면', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByLabel('Describe the music you want')).toBeVisible();
  await shot(page, '01-home');
});

test('재생목록 결과', async ({ page }) => {
  await page.goto('/');
  await signIn(page);
  await ask(page, '10 songs like Doja by Central Cee', 'Go live', 'Describe the music you want');
  await expect(page.locator('ol.songs > li')).toHaveCount(10);
  await shot(page, '02-results');
});

test('공유 화면', async ({ page }) => {
  await seedPlaylist({ id: 'capture1', state: 'saved', songs: [1, 2, 3], privateText: 'capture' });
  await page.goto('/p/capture1');
  await expect(page.getByRole('heading', { name: 'Shared set' })).toBeVisible();
  await shot(page, '03-shared');
});

test('현황판', async ({ page }) => {
  const m = (value: number | null, unit: string, method: string) => ({ value, unit, method });
  await seedStatus({
    current: {
      updatedAt: new Date('2026-11-23T13:30:00Z'),
      service: {
        parseSuccessRate: m(
          0.9,
          'rate',
          'Requests understood divided by all requests in the last 24 hours.',
        ),
        madeUpSongsFiltered: m(
          3,
          'count',
          'Songs the AI suggested that were not in the candidate list.',
        ),
        officialLinkAccuracy: m(0.98, 'score', "Today's song-matching test score."),
        removedSongRate: m(null, 'rate', 'Songs removed divided by songs shown.'),
        recommendTestScore: m(1, 'score', 'Recommendation test, last measured 2026-11-22.'),
      },
      catalog: {
        playableSongs: m(1500, 'count', 'Songs with a playable official video.'),
        songsAdded: m(20, 'count', 'Change since the previous update.'),
        searchFreeRate: m(0.75, 'rate', 'Sets made without any YouTube search.'),
        ytUnitsLeft: m(7800, 'count', 'YouTube API units left today.'),
        ytUserSearchesLeft: m(75, 'count', 'Searches left for user requests.'),
        ytJobSearchesLeft: m(0, 'count', 'Searches left for nightly jobs.'),
      },
      github: { unavailable: 'no GitHub token' },
    },
    opsLog: [
      {
        at: new Date('2026-11-23T13:16:00Z'),
        kind: 'job',
        message: 'Nightly ingest finished: 120 videos checked.',
        links: [],
      },
    ],
  });
  await page.goto('/status');
  await expect(page.getByRole('heading', { name: 'Station status' })).toBeVisible();
  await shot(page, '04-status');
});
