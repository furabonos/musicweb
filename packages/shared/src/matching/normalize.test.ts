import { describe, expect, it } from 'vitest';
import { cleanTitle, compareKey, normalize, similarity, splitArtistTitle } from './normalize.js';

describe('normalize', () => {
  it('전각→반각, 소문자, 따옴표·대시 통일', () => {
    expect(normalize('ＫＡＲＭＡ　Police – “Live”')).toBe('karma police - "live"');
    expect(compareKey('Don’t Stop Me Now!')).toBe('dont stop me now');
  });
});

describe('cleanTitle', () => {
  it.each([
    ['Karma Police (Official Music Video)', 'karma police', ['official music video']],
    ['Karma Police [Official Audio]', 'karma police', ['official audio']],
    ['Karma Police (Remastered 2017)', 'karma police', ['remastered 2017']],
    ['밤편지 (뮤직비디오)', '밤편지', ['뮤직비디오']],
    ['Karma Police | Official Video', 'karma police', ['official video']],
    ['Karma Police [HD]', 'karma police', ['hd']],
  ])('꼬리말 제거: %s', (raw, core, decorations) => {
    expect(cleanTitle(raw)).toMatchObject({ core, decorations });
  });

  it('피처링을 떼어 참여 아티스트로', () => {
    expect(cleanTitle('Peaches (feat. Daniel Caesar & Giveon)')).toMatchObject({
      core: 'peaches',
      featured: ['daniel caesar', 'giveon'],
    });
    expect(cleanTitle('Peaches ft. Daniel Caesar, Giveon').core).toBe('peaches');
    expect(cleanTitle('Dancing (with Someone)')).toMatchObject({
      core: 'dancing',
      featured: ['someone'],
    });
    // 괄호 밖의 with는 제목 일부다
    expect(cleanTitle('Dancing with a Stranger').core).toBe('dancing with a stranger');
  });
});

describe('splitArtistTitle', () => {
  it.each([
    ['Radiohead - Karma Police', 'x', ['Radiohead'], ['karma police'], 'radiohead'],
    ['Karma Police - Radiohead', 'x', ['Radiohead'], ['karma police'], 'radiohead'],
    ['IU(아이유) - 밤편지', 'x', ['IU', '아이유'], ['밤편지'], 'iu(아이유)'],
    ['YOASOBI「夜に駆ける」Official Music Video', 'x', ['YOASOBI'], ['夜に駆ける'], 'yoasobi'],
  ])('%s', (title, channel, artists, titles, artistPart) => {
    expect(splitArtistTitle(title, channel, artists)).toMatchObject({
      titles,
      artistPart,
      failed: false,
    });
  });

  it('채널이 아티스트(Topic 포함)면 제목 전체가 곡 제목', () => {
    expect(splitArtistTitle('Karma Police', 'Radiohead - Topic', ['Radiohead'])).toMatchObject({
      titles: ['karma police'],
      failed: false,
    });
  });

  it('다국어 제목은 둘 다 후보로 남긴다', () => {
    expect(splitArtistTitle('밤편지 (Through the Night)', 'IU - Topic', ['IU']).titles).toEqual([
      '밤편지',
      'through the night',
    ]);
  });

  it('어느 쪽이 아티스트인지 모르면 실패 표시', () => {
    expect(
      splitArtistTitle('Karma Police - Remastered Classics', 'Uploader', ['Radiohead']).failed,
    ).toBe(true);
  });
});

describe('similarity', () => {
  it('편집 거리 비율', () => {
    expect(similarity('karma police', 'karma police')).toBe(1);
    expect(similarity('karma polise', 'karma police')).toBeGreaterThanOrEqual(0.9);
    expect(similarity('abc', 'xyz')).toBe(0);
    expect(similarity('', 'a')).toBe(0);
  });
});
