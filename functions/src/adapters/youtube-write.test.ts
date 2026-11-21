import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Firestore } from 'firebase-admin/firestore';
import { describe, expect, it, vi } from 'vitest';
import * as youtubeWrite from './youtube-write.js';
import { InvalidWriteInputError, MAX_EXPORT_ITEMS } from './youtube-write-types.js';

// 소유 확인·예약·ytExports 기록은 Firestore 트랜잭션이 필요해 youtube-write.int.test.ts(에뮬레이터)에서 확인한다.

const VIDEO = 'dQw4w9WgXcQ';

/** 어떤 Firestore 호출이든 바로 실패하는 가짜. 입력 검사가 DB·HTTP보다 먼저인지 확인한다. */
function strictCtx() {
  const fetch = vi.fn<typeof globalThis.fetch>();
  const getAccessToken = vi.fn(async () => 'token');
  const db = new Proxy(
    {},
    {
      get() {
        throw new Error('입력 검사 전에 DB를 건드렸습니다');
      },
    },
  ) as Firestore;
  return { ctx: { db, fetch, getAccessToken }, fetch, getAccessToken };
}

describe('youtube-write: 공개 함수', () => {
  it('내보내는 것은 createPlaylist, addItems 두 함수뿐이다 (수정·삭제 없음)', () => {
    expect(Object.keys(youtubeWrite).sort()).toEqual(['addItems', 'createPlaylist']);
    for (const fn of Object.values(youtubeWrite)) expect(typeof fn).toBe('function');
  });

  it('소스에 POST 말고 다른 HTTP 메서드가 없다', () => {
    const src = readFileSync(join(__dirname, 'youtube-write.ts'), 'utf8');
    expect(src.match(/method:\s*'[A-Z]+'/g)).toEqual(["method: 'POST'"]);
    expect(src).not.toMatch(/\b(PUT|PATCH|DELETE)\b/);
  });
});

describe('youtube-write: 입력 검사 (DB·HTTP 호출 전에 거부)', () => {
  it.each([
    ['빈 제목', '   ', [VIDEO]],
    ['너무 긴 제목', 'x'.repeat(151), [VIDEO]],
    ['< > 가 들어간 제목', 'a <b>', [VIDEO]],
    ['곡 0개', 'ok', []],
    ['곡이 너무 많음', 'ok', Array(MAX_EXPORT_ITEMS + 1).fill(VIDEO)],
    ['영상 ID 형식 오류', 'ok', ['short']],
    ['영상 ID에 주소', 'ok', ['https://youtu.be/dQw4w9WgXcQ']],
  ])('createPlaylist: %s', async (_name, title, items) => {
    const { ctx, fetch, getAccessToken } = strictCtx();
    await expect(
      youtubeWrite.createPlaylist(ctx, 'alice', title as string, items as string[]),
    ).rejects.toBeInstanceOf(InvalidWriteInputError);
    expect(fetch).not.toHaveBeenCalled();
    expect(getAccessToken).not.toHaveBeenCalled();
  });

  it.each([
    ['빈 uid', ''],
    ['uid에 /', 'a/b'],
  ])('createPlaylist: %s', async (_name, uid) => {
    const { ctx, fetch } = strictCtx();
    await expect(youtubeWrite.createPlaylist(ctx, uid, 'ok', [VIDEO])).rejects.toBeInstanceOf(
      InvalidWriteInputError,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['곡 0개', []],
    ['곡이 너무 많음', Array(MAX_EXPORT_ITEMS + 1).fill(VIDEO)],
    ['영상 ID 형식 오류', ['short']],
  ])('addItems: %s', async (_name, items) => {
    const { ctx, fetch } = strictCtx();
    await expect(
      youtubeWrite.addItems(ctx, 'alice', 'e1', items as string[]),
    ).rejects.toBeInstanceOf(InvalidWriteInputError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['빈 uid', '', 'e1'],
    ['uid에 /', 'a/b', 'e1'],
    ['빈 ytExportId', 'alice', ''],
    ['ytExportId에 /', 'alice', 'ytExports/other'],
  ])('addItems: %s', async (_name, uid, exportId) => {
    const { ctx, fetch } = strictCtx();
    await expect(youtubeWrite.addItems(ctx, uid, exportId, [VIDEO])).rejects.toBeInstanceOf(
      InvalidWriteInputError,
    );
    expect(fetch).not.toHaveBeenCalled();
  });
});
