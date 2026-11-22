import { describe, expect, it } from 'vitest';
import { compareKey } from '../matching/index.js';
import { DEMO_SONGS } from './catalog.js';

describe('에뮬레이터 가짜 곡 목록', () => {
  it('key는 songKey(artist, title)와 같다 (씨앗 도구가 계산 없이 그대로 쓴다)', () => {
    for (const s of DEMO_SONGS)
      expect(s.key).toBe(`${compareKey(s.artist)}|${compareKey(s.title)}`);
  });

  it('MBID·영상 ID 형식이 맞고 겹치지 않는다', () => {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    for (const s of DEMO_SONGS) {
      expect(s.mbid).toMatch(uuid);
      expect(s.artistMbid).toMatch(uuid);
      expect(s.videoId).toMatch(/^[A-Za-z0-9_-]{11}$/);
    }
    expect(new Set(DEMO_SONGS.map((s) => s.mbid)).size).toBe(DEMO_SONGS.length);
    expect(new Set(DEMO_SONGS.map((s) => s.videoId)).size).toBe(DEMO_SONGS.length);
  });
});
