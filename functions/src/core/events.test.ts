import type { Firestore } from 'firebase-admin/firestore';
import { describe, expect, it, vi } from 'vitest';
import {
  actorHash,
  assertNoFreeText,
  buildEvent,
  EVENT_SCHEMAS,
  EventSchemaError,
  firestoreEventSink,
  recordCall,
  type EventInput,
  type EventRecord,
} from './events.js';

const KEY = 'unit-test-actor-hash-key-0123456789';
const ok = (e: unknown) => buildEvent(e as EventInput, KEY);

describe('buildEvent: 스키마', () => {
  it('정의된 이벤트는 그대로 저장 형태가 된다', () => {
    expect(
      ok({
        type: 'external_call',
        attrs: { target: 'youtube_write', op: 'playlists.insert', units: 50, status: 200 },
        outcome: 'ok',
        durationMs: 12.6,
      }),
    ).toEqual({
      type: 'external_call',
      attrs: { target: 'youtube_write', op: 'playlists.insert', units: 50, status: 200 },
      outcome: 'ok',
      durationMs: 13,
      actorHash: null,
    });
  });

  it.each([
    [
      'attrs에 없는 필드',
      { type: 'song_removed', attrs: { position: 1, title: 'x' }, outcome: 'ok' },
    ],
    [
      '최상위에 없는 필드',
      { type: 'song_removed', attrs: { position: 1 }, outcome: 'ok', uid: 'a' },
    ],
    ['정의되지 않은 종류', { type: 'search_text', attrs: {}, outcome: 'ok' }],
    ['필수 attrs 빠짐', { type: 'limit_reached', attrs: { scope: 'user' }, outcome: 'rejected' }],
    [
      'enum 밖 값',
      { type: 'external_call', attrs: { target: 'evil.com', op: 'x' }, outcome: 'ok' },
    ],
    ['잘못된 outcome', { type: 'song_removed', attrs: { position: 1 }, outcome: 'maybe' }],
    ['음수 시간', { type: 'song_removed', attrs: { position: 1 }, outcome: 'ok', durationMs: -1 }],
  ])('거부: %s', (_n, e) => {
    expect(() => ok(e)).toThrow(EventSchemaError);
  });

  it.each([
    [
      '검색 문장처럼 보이는 긴 자유 텍스트',
      'rainy day jazz for studying late at night like old cafes',
    ],
    ['공백이 든 짧은 문장', 'sad songs'],
    ['65자 식별자', 'a'.repeat(65)],
    ['이메일 형식', 'someone@example.com'],
    ['이메일이 섞인 값', 'x:user@gmail.com'],
  ])('글자 필드에 %s는 거부', (_n, value) => {
    for (const e of [
      { type: 'request_parse_failed', attrs: { reason: value }, outcome: 'error' },
      { type: 'error', attrs: { code: 'x', where: value }, outcome: 'error' },
      { type: 'external_call', attrs: { target: 'llm', op: value }, outcome: 'ok' },
    ]) {
      expect(() => ok(e)).toThrow(EventSchemaError);
    }
  });

  it.each(['https://evil.example/x', 'a/b', 'q?x=1', '한글이름'])(
    '식별자 필드는 영문·숫자·_.:- 밖의 글자를 거부한다 (두 번째 검사로는 안 걸리는 값): %s',
    (value) => {
      expect(() => assertNoFreeText({ v: value }, 'attrs')).not.toThrow();
      expect(() =>
        ok({ type: 'request_parse_failed', attrs: { reason: value }, outcome: 'error' }),
      ).toThrow(EventSchemaError);
    },
  );

  it('모든 이벤트 스키마는 strictObject다 (모르는 필드 거부)', () => {
    for (const [type, schema] of Object.entries(EVENT_SCHEMAS)) {
      const def = (schema as unknown as { def: { catchall?: { def?: { type?: string } } } }).def;
      expect(def.catchall?.def?.type, type).toBe('never');
    }
  });
});

describe('assertNoFreeText: 저장 직전 두 번째 검사 (스키마와 별개)', () => {
  it.each([
    ['이메일', { a: 'me@example.com' }],
    ['긴 글', { a: 'x'.repeat(65) }],
    ['공백 든 글', { a: 'two words' }],
    ['안쪽 깊은 곳', { a: { b: ['ok', 'tab\there'] } }],
  ])('거부: %s', (_n, v) => {
    expect(() => assertNoFreeText(v, 'attrs')).toThrow(EventSchemaError);
  });
  it('짧은 식별자·숫자·불리언은 통과', () => {
    expect(() =>
      assertNoFreeText({ a: 'playlists.insert', b: 3, c: true, d: null }, 'attrs'),
    ).not.toThrow();
  });
});

describe('uid·자유 값이 들어갈 길 막기 (리뷰 반영)', () => {
  it('actorUid와 같은 값(또는 그 값을 포함한 값)을 attrs에 넣으면 거부', () => {
    for (const where of ['uid-alice', 'x:uid-alice']) {
      expect(() =>
        ok({ type: 'error', attrs: { code: 'x', where }, outcome: 'error', actorUid: 'uid-alice' }),
      ).toThrow(/uid/);
    }
  });
  it('Firebase uid·토큰처럼 보이는 긴 영숫자 덩어리는 거부', () => {
    for (const v of ['Xk3pQ9aLm2Rt7Vb1Nc8Zd4Ey6Wf', 'PLabcdefghijklmnopqrstuv']) {
      expect(() => ok({ type: 'error', attrs: { code: 'x', where: v }, outcome: 'error' })).toThrow(
        EventSchemaError,
      );
    }
    expect(() =>
      ok({
        type: 'error',
        attrs: { code: 'budget_exceeded', where: 'youtube_write.insert' },
        outcome: 'error',
      }),
    ).not.toThrow();
  });
  it('값이 정해진 필드는 목록 밖 값을 거부 (counter, feature, op)', () => {
    for (const e of [
      { type: 'limit_reached', attrs: { scope: 'user', counter: 'lofi' }, outcome: 'rejected' },
      { type: 'kill_switch_blocked', attrs: { feature: 'taylorswift' }, outcome: 'rejected' },
      { type: 'external_call', attrs: { target: 'llm', op: 'lofi' }, outcome: 'ok' },
    ]) {
      expect(() => ok(e)).toThrow(EventSchemaError);
    }
    expect(() =>
      ok({
        type: 'limit_reached',
        attrs: { scope: 'service', counter: 'ytUnits' },
        outcome: 'rejected',
      }),
    ).not.toThrow();
  });
  it('점수는 소수 둘째 자리까지, 소요 시간은 15분까지', () => {
    const link = (score: number) => ({
      type: 'song_linked',
      attrs: { kind: 'mv', score, byAi: false },
      outcome: 'ok',
    });
    expect(() => ok(link(0.57))).not.toThrow();
    expect(() => ok(link(0.123456))).toThrow(EventSchemaError);
    expect(() =>
      ok({
        type: 'song_removed',
        attrs: { position: 1 },
        outcome: 'ok',
        durationMs: 15 * 60 * 1000 + 1,
      }),
    ).toThrow(EventSchemaError);
  });
});

describe('firestoreEventSink', () => {
  it('키가 없거나 짧으면 만들 때 바로 실패한다 (외부 호출 전에 드러남)', () => {
    expect(() => firestoreEventSink({} as Firestore, '')).toThrow(EventSchemaError);
    expect(() => firestoreEventSink({} as Firestore, 'short')).toThrow(EventSchemaError);
  });
  it('저장 오류는 삼키고 서버 로그에 종류·오류 이름만 남긴다', async () => {
    const db = {
      collection: () => ({
        add: async () => {
          throw Object.assign(new Error('unavailable uid-alice'), { name: 'FirestoreError' });
        },
      }),
    } as unknown as Firestore;
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(
      firestoreEventSink(db, KEY).record({
        type: 'song_removed',
        attrs: { position: 1 },
        outcome: 'ok',
        actorUid: 'uid-alice',
      }),
    ).resolves.toBeUndefined();
    expect(errSpy).toHaveBeenCalledWith('이벤트 저장 실패', {
      type: 'song_removed',
      error: 'FirestoreError',
    });
    errSpy.mockRestore();
  });
  it('스키마 위반은 던진다 (코드 버그는 테스트에서 드러나게)', async () => {
    const db = { collection: () => ({ add: vi.fn() }) } as unknown as Firestore;
    await expect(
      firestoreEventSink(db, KEY).record({
        type: 'song_removed',
        attrs: { position: -1 },
        outcome: 'ok',
      }),
    ).rejects.toThrow(EventSchemaError);
  });
});

describe('actorHash', () => {
  it('같은 uid는 같은 해시, 다른 uid는 다른 해시이고 원문 uid는 남지 않는다', () => {
    const e1 = ok({
      type: 'song_removed',
      attrs: { position: 1 },
      outcome: 'ok',
      actorUid: 'uid-alice-123',
    });
    const e2 = ok({
      type: 'song_replaced',
      attrs: { position: 2 },
      outcome: 'ok',
      actorUid: 'uid-alice-123',
    });
    const e3 = ok({
      type: 'song_removed',
      attrs: { position: 1 },
      outcome: 'ok',
      actorUid: 'uid-bob-456',
    });
    expect(e1.actorHash).toBe(e2.actorHash);
    expect(e1.actorHash).not.toBe(e3.actorHash);
    expect(e1.actorHash).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify([e1, e2, e3])).not.toContain('uid-alice');
    expect(Object.keys(e1)).not.toContain('actorUid');
  });

  it('키가 다르면 해시도 다르다 (키 없이는 되돌릴 수 없음)', () => {
    expect(actorHash('u', KEY)).not.toBe(actorHash('u', KEY + 'x'));
  });

  it('키가 짧거나 없으면 막는 쪽으로 실패', () => {
    expect(() => actorHash('u', 'short')).toThrow(EventSchemaError);
    expect(() => actorHash('u', '')).toThrow(EventSchemaError);
  });
});

describe('recordCall: 외부 호출 공통 기록', () => {
  function sink() {
    const events: EventRecord[] = [];
    return {
      events,
      sink: { record: async (e: EventInput) => void events.push(buildEvent(e, KEY)) },
    };
  }
  const clock = () => {
    let t = 1000;
    return () => (t += 25);
  };

  it('성공하면 대상·단위·비용·소요 시간·결과를 남기고 결과를 돌려준다', async () => {
    const { events, sink: s } = sink();
    const r = await recordCall(
      s,
      { target: 'youtube_write', op: 'playlists.insert', actorUid: 'u1' },
      async () => ({ result: 'done', costMicroUsd: 120 }),
      undefined,
      clock(),
    );
    expect(r).toBe('done');
    expect(events).toEqual([
      {
        type: 'external_call',
        attrs: { target: 'youtube_write', op: 'playlists.insert', costMicroUsd: 120 },
        outcome: 'ok',
        durationMs: 25,
        actorHash: actorHash('u1', KEY),
      },
    ]);
  });

  it('실패하면 error로 남기고 원래 오류를 다시 던진다', async () => {
    const { events, sink: s } = sink();
    const boom = new Error('boom');
    await expect(
      recordCall(
        s,
        { target: 'youtube_write', op: 'playlistItems.insert' },
        async () => {
          throw boom;
        },
        () => ({ status: 502 }),
        clock(),
      ),
    ).rejects.toBe(boom);
    expect(events[0]).toMatchObject({ outcome: 'error', attrs: { status: 502 }, actorHash: null });
  });

  it('기록이 실패해도(스키마 위반·키 오류 등) 호출 결과와 원래 오류는 그대로다', async () => {
    const throwing = { record: vi.fn(async () => Promise.reject(new EventSchemaError('x'))) };
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(
      recordCall(throwing, { target: 'youtube_write', op: 'playlists.insert' }, async () => ({
        result: 7,
      })),
    ).resolves.toBe(7);
    const original = new Error('original');
    await expect(
      recordCall(throwing, { target: 'youtube_write', op: 'playlists.insert' }, async () => {
        throw original;
      }),
    ).rejects.toBe(original);
    expect(throwing.record).toHaveBeenCalledTimes(2);
    expect(errSpy).toHaveBeenCalledTimes(2);
    errSpy.mockRestore();
  });
});
