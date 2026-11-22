import { describe, expect, it } from 'vitest';
import { watchLink, watchVideosLinks, WATCH_VIDEOS_MAX, YouTubeLinkError } from './youtubeLink.js';

const id = (n: number) => `vid${String(n).padStart(8, '0')}`;

describe('watchVideosLinks', () => {
  it('영상 ID를 쉼표로 이어 한 링크로', () => {
    expect(watchVideosLinks([id(1), id(2)])).toEqual([
      `https://www.youtube.com/watch_videos?video_ids=${id(1)},${id(2)}`,
    ]);
  });

  it('상한(기본 50곡)을 넘으면 여러 링크로 나누고 순서를 지킴', () => {
    const ids = Array.from({ length: 120 }, (_, i) => id(i));
    const links = watchVideosLinks(ids);
    expect(WATCH_VIDEOS_MAX).toBe(50);
    expect(links).toHaveLength(3);
    const back = links.flatMap((l) => new URL(l).searchParams.get('video_ids')?.split(',') ?? []);
    expect(back).toEqual(ids);
    expect(watchVideosLinks(ids.slice(0, 5), 2)).toHaveLength(3);
  });

  it.each([
    ['빈 목록', []],
    ['짧은 ID', ['abc']],
    ['쉼표·주소 조각을 넣은 ID', ['aaaaaaaaaa,']],
    ['다른 주소를 끼운 ID', ['&list=PLxxx']],
  ])('%s → 거부', (_l, ids) => {
    expect(() => watchVideosLinks(ids)).toThrow(YouTubeLinkError);
  });
});

describe('watchLink', () => {
  it('곡 하나의 링크, 형식이 틀리면 거부', () => {
    expect(watchLink(id(7))).toBe(`https://www.youtube.com/watch?v=${id(7)}`);
    expect(() => watchLink('x')).toThrow(YouTubeLinkError);
  });
});
