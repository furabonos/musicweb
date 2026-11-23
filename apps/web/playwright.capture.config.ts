import { defineConfig } from '@playwright/test';
import base from './playwright.config';

/** 화면 캡처 전용 설정 (T20, D-038). `pnpm capture`가 쓴다. 보통 e2e(`*.spec.ts`)는 돌리지 않는다. */
export default defineConfig({ ...base, testMatch: 'capture.ts' });
