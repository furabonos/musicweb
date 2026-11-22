import { beforeEach, describe, expect, it } from 'vitest';
import {
  callFunction,
  clearAuth,
  clearFirestore,
  emulatorDb,
  googleSignIn,
} from '../testing/emulator.js';

const db = emulatorDb();

beforeEach(async () => {
  await clearFirestore();
  await clearAuth();
});

describe('playback-reportEmbedBlocked', () => {
  it('로그인 없이도 101·150을 embed_blocked 이벤트로 남김, 로그인했으면 해시만', async () => {
    expect((await callFunction('playback-reportEmbedBlocked', { code: 150 })).result).toEqual({
      ok: true,
    });
    const { token, uid } = await googleSignIn('someone@example.com');
    await callFunction('playback-reportEmbedBlocked', { code: 101 }, token);
    const events = (await db.collection('events').where('type', '==', 'embed_blocked').get()).docs
      .map((d) => d.data())
      .sort((a, b) => a.attrs.code - b.attrs.code);
    expect(events.map((e) => e.attrs)).toEqual([{ code: 101 }, { code: 150 }]);
    expect(events[0]?.actorHash).toEqual(expect.any(String));
    expect(JSON.stringify(events)).not.toContain(uid);
  });

  it.each([{ code: 100 }, { code: '150' }, { code: 150, videoId: 'abc' }, null])(
    '다른 값은 거부 %#',
    async (data) => {
      const r = await callFunction('playback-reportEmbedBlocked', data);
      expect(r.error?.status).toBe('INVALID_ARGUMENT');
      expect((await db.collection('events').get()).size).toBe(0);
    },
  );
});
