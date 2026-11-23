import { expect, test } from '@playwright/test';
import { seedPlaylist, seedStatus } from '../../../tools/seed-emulator.ts';
import { ADMIN, resetCatalog } from './helpers';

/** 공개 현황판 (SPEC 4.10, T21): 로그아웃 상태에서 수치·계산 방법·갱신 시각·운영 일지·PR 링크, 개인정보 없음 */
const SECRET = 'my private search sentence 12345';

test.beforeEach(async () => {
  await resetCatalog();
  await seedPlaylist({ id: 'statusSaved1', state: 'saved', songs: [1, 2], privateText: SECRET });
  await seedStatus({
    current: {
      updatedAt: new Date('2026-11-23T13:30:00Z'),
      service: {
        parseSuccessRate: {
          value: 0.9,
          unit: 'rate',
          method: 'Requests understood divided by all requests in the last 24 hours.',
        },
        removedSongRate: { value: null, unit: 'rate', method: 'Songs removed divided by shown.' },
      },
      catalog: {
        playableSongs: { value: 1500, unit: 'count', method: 'Songs with a playable video.' },
      },
      ai: {
        aiFreeRate: {
          value: 0.8,
          unit: 'rate',
          method: 'Sets made without calling AI divided by all sets.',
        },
        aiCostPerSet: {
          value: 0.0021,
          unit: 'usd',
          method: 'All AI spending divided by sets made.',
        },
        savingModeMinutes: {
          value: 45,
          unit: 'minutes',
          method: 'Minutes when simple mode was on.',
        },
      },
      github: {
        updatedAt: new Date('2026-11-23T13:15:00Z'),
        approvalRate: { value: 0.5, unit: 'rate', method: 'Merged divided by merged or closed.' },
        rejectReasons: [{ reason: 'wrong fix', count: 1 }],
        recent: [
          {
            number: 53,
            url: 'https://github.com/furabonos/musicweb/pull/53',
            state: 'rejected',
            ci: 'failure',
            openedAt: '2026-11-23T10:00:00Z',
            reverted: false,
            rejectReason: 'wrong fix',
          },
        ],
      },
    },
    opsLog: [
      {
        at: new Date('2026-11-23T13:16:00Z'),
        kind: 'pr',
        message: 'Auto-fix PR closed without merging (reason: wrong fix); CI failure.',
        links: ['https://github.com/furabonos/musicweb/pull/53'],
      },
      {
        at: new Date('2026-11-23T11:00:00Z'),
        kind: 'job_failed',
        message: 'GitHub stats could not be updated.',
        links: [],
      },
    ],
  });
});

test('로그아웃 상태로 /status — 수치·계산 방법·갱신 시각·운영 일지·PR 링크, 검색 문장·이메일 없음', async ({
  page,
}) => {
  await page.goto('/status');
  await expect(page.getByRole('heading', { name: 'Station status' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in with Google' })).toBeVisible();
  // 전체 갱신 시각과 GitHub 영역 갱신 시각이 따로 보인다
  await expect(page.getByText(/^Updated /)).toHaveCount(2);
  await expect(page.locator('.card-head .status-updated')).toContainText('Updated');

  const metric = (name: string) => page.locator(`[data-metric="${name}"]`);
  await expect(metric('parseSuccessRate')).toContainText('90%');
  await expect(metric('parseSuccessRate')).toContainText(
    'Requests understood divided by all requests in the last 24 hours.',
  );
  await expect(metric('removedSongRate')).toContainText('No data yet');
  await expect(metric('playableSongs')).toContainText('1,500');
  await expect(metric('approvalRate')).toContainText('50%');
  // AI 비용 (T35): 세 지표와 계산 방법
  await expect(page.getByRole('heading', { name: 'AI cost' })).toBeVisible();
  await expect(metric('aiFreeRate')).toContainText('80%');
  await expect(metric('aiFreeRate')).toContainText(
    'Sets made without calling AI divided by all sets.',
  );
  await expect(metric('aiCostPerSet')).toContainText('$0.0021');
  await expect(metric('aiCostPerSet')).toContainText('All AI spending divided by sets made.');
  await expect(metric('savingModeMinutes')).toContainText('45 min');
  await expect(metric('savingModeMinutes')).toContainText('Minutes when simple mode was on.');

  // 실패·거절도 숨기지 않는다
  await expect(page.getByText('wrong fix: 1')).toBeVisible();
  await expect(page.getByText('GitHub stats could not be updated.')).toBeVisible();
  const pr = page.locator('.status-list a', { hasText: 'PR #53' });
  await expect(pr).toHaveAttribute('href', 'https://github.com/furabonos/musicweb/pull/53');
  await expect(
    page.getByRole('link', { name: 'Pull request #53 (opens in a new tab)' }).first(),
  ).toBeVisible();

  const body = page.locator('body');
  await expect(body).not.toContainText(SECRET);
  await expect(body).not.toContainText(ADMIN);
  await expect(body).not.toContainText('@');
});

test('한국어로 바꾸면 이름은 한국어, 계산 방법은 서버 문장 그대로', async ({ page }) => {
  await page.goto('/status');
  await page.getByRole('button', { name: '한국어' }).click();
  await expect(page.getByRole('heading', { name: '방송국 현황' })).toBeVisible();
  await expect(page.locator('[data-metric="parseSuccessRate"]')).toContainText('요청 해석 성공률');
});
