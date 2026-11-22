/**
 * `pnpm eval`의 진입점(vitest가 functions 코드의 TypeScript를 바로 읽기 위함).
 * 기준보다 낮으면 이 테스트가 실패해 명령이 exit≠0으로 끝난다.
 */
import { expect, it } from 'vitest';
import { main } from './run.js';

it('시험 실행과 기준 비교', { timeout: 3_600_000 }, async () => {
  expect(await main(process.env)).toBe(0);
});
