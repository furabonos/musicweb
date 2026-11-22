import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/**
 * 응답 헤더: YouTube 플레이어는 Referer로 삽입한 사이트를 확인하므로 no-referrer로 두지 않는다(스킬 youtube-policy).
 * 배포(firebase.json hosting.headers)와 같은 값이어야 한다(tools/hosting-headers.test.ts).
 */
export const SECURITY_HEADERS = { 'Referrer-Policy': 'strict-origin-when-cross-origin' };

export default defineConfig({
  plugins: [react()],
  server: { headers: SECURITY_HEADERS },
  preview: { headers: SECURITY_HEADERS },
  test: { environment: 'jsdom', include: ['src/**/*.test.{ts,tsx}'] },
});
