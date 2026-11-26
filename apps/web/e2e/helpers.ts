import { expect, type Page } from '@playwright/test';
import { clearEmulatorFirestore, seedDemoCatalog } from '../../../tools/seed-emulator.ts';

export const ADMIN = 'admin@example.com';

/** 테스트마다 Firestore를 비우고 가짜 곡 목록을 다시 넣는다. */
export async function resetCatalog() {
  await clearEmulatorFirestore();
  await seedDemoCatalog();
}

/** 에뮬레이터 모드 화면에만 있는 로그인 도우미로 Google 로그인을 흉내 낸다. */
export async function signIn(page: Page, email = ADMIN) {
  await page.waitForFunction(() => '__musicwebE2E' in window);
  await page.evaluate(
    (e) =>
      (
        window as unknown as { __musicwebE2E: { signIn(e: string): Promise<void> } }
      ).__musicwebE2E.signIn(e),
    email,
  );
}

export async function ask(page: Page, text: string, submitName: string, inputLabel: string) {
  await page.getByLabel(inputLabel).fill(text);
  await page.getByRole('button', { name: submitName, exact: true }).click();
  await expect(page.getByRole('heading', { level: 2 })).toBeVisible({ timeout: 30_000 });
}
