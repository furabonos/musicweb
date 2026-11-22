import { expect, it } from 'vitest';

// T18 CI 시연용: 일부러 실패하는 테스트(바로 되돌린다)
it('CI가 실패를 잡는지 확인', () => {
  expect(1 + 1).toBe(3);
});
