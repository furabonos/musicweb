import { describe, expect, it } from 'vitest';

// firebase emulators:exec 가 FUNCTIONS_EMULATOR_HOST 등을 넣어 준다.
const host = process.env.FUNCTIONS_EMULATOR_HOST ?? '127.0.0.1:5001';
const projectId = process.env.GCLOUD_PROJECT ?? 'demo-musicweb';

describe('health callable (에뮬레이터)', () => {
  it('callable 프로토콜로 호출하면 ok 결과를 돌려준다', async () => {
    const res = await fetch(`http://${host}/${projectId}/us-central1/health`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: {} }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: { ok: true, service: 'musicweb' } });
  });
});
