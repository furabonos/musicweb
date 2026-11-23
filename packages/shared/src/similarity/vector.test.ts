import { describe, expect, it } from 'vitest';
import {
  closeness,
  fromSparse,
  knownTagWords,
  toSparse,
  normalizeTag,
  sharedTags,
  toVector,
  vocabIndex,
  yearCloseness,
  type MusicTag,
} from './vector.js';
import { VOCAB, VOCAB_VERSION } from './vocab.js';
import { vocabIndexes } from './vector.js';

/** 곡 숫자 묶음 (SPEC 4.3, T28, D-045) */
const mb = (name: string, count = 1): MusicTag => ({ name, count, source: 'musicbrainz' });

describe('normalizeTag·vocabIndex', () => {
  it('동의어·대소문자·하이픈은 같은 자리', () => {
    expect(vocabIndex('hip hop')).toBe(vocabIndex('hip-hop'));
    expect(vocabIndex('Hip-Hop')).toBe(vocabIndex('hiphop'));
    expect(vocabIndex('R&B')).toBe(vocabIndex('rnb'));
    expect(vocabIndex('K-Pop')).toBe(vocabIndex('korean pop'));
    expect(normalizeTag(' Post-Britpop ')).toBe('post britpop');
  });
  it("끝의 music, &, 'n', 긴 대시, 슬래시 묶음도 알아본다", () => {
    expect(vocabIndex('progressive rock music')).toBe(vocabIndex('progressive rock'));
    expect(vocabIndex('drum & bass')).toBe(vocabIndex('drum and bass'));
    expect(vocabIndex("rock 'n' roll")).toBe(vocabIndex('rock and roll'));
    expect(vocabIndex('post–punk')).toBe(vocabIndex('post punk'));
    expect(vocabIndex('rhythm & blues')).toBe(vocabIndex('r&b'));
    expect(vocabIndexes('alternative pop/rock').sort()).toEqual(
      [vocabIndex('rock')].concat([]).sort(),
    );
  });
  it('랩과 힙합은 한 자리', () => {
    expect(vocabIndex('rap')).toBe(vocabIndex('hip hop'));
    expect(vocabIndexes('hip-hop/rap')).toEqual([vocabIndex('hip hop')]);
  });
  it('모르는 태그는 -1', () => {
    expect(vocabIndex('seen live')).toBe(-1);
    expect(vocabIndex('favorite')).toBe(-1);
  });
  it('낱말 목록에 겹치는 낱말이 없다', () => {
    expect(new Set(VOCAB).size).toBe(VOCAB.length);
  });
});

describe('toVector·closeness', () => {
  it('같은 태그는 가까움 1, 겹치지 않으면 0', () => {
    const a = toVector([mb('shoegaze'), mb('dream pop')], 1991);
    const b = toVector([mb('dream pop'), mb('Shoegaze')], 1995);
    const c = toVector([mb('trap'), mb('drill')], 2020);
    expect(closeness(a, b)).toBe(1);
    expect(closeness(a, c)).toBe(0);
  });
  it('일부만 겹치면 0과 1 사이', () => {
    const a = toVector([mb('alternative rock'), mb('art rock')], null);
    const b = toVector([mb('alternative rock'), mb('pop')], null);
    expect(closeness(a, b)).toBeGreaterThan(0);
    expect(closeness(a, b)).toBeLessThan(1);
  });
  it('모르는 태그는 무시한다(그것만 있으면 태그 자리는 모두 0)', () => {
    const v = toVector([mb('seen live'), mb('my favorite')], 2001);
    expect(v.tags.every((x) => x === 0)).toBe(true);
    expect(v.decade).toBe(2000);
    expect(closeness(v, v)).toBe(0);
  });
  it('투표가 많은 태그가 더 무겁다', () => {
    const v = toVector([mb('alternative rock', 13), mb('pop', 1)], null);
    expect(v.tags[vocabIndex('alternative rock')]).toBeGreaterThan(v.tags[vocabIndex('pop')] ?? 0);
  });
  it('낱말 목록 버전이 결과에 들어가고, 버전이 다르면 비교하지 않는다', () => {
    const a = toVector([mb('rock')], 1997);
    expect(a.vocabVersion).toBe(VOCAB_VERSION);
    expect(a.tags).toHaveLength(VOCAB.length);
    expect(closeness(a, { ...a, vocabVersion: VOCAB_VERSION + 1 })).toBe(0);
  });
  it('연도 가까움: 같은 연도대 1, 이웃 0.5, 그 밖·모름 0', () => {
    const v = (y: number | null) => toVector([], y);
    expect(yearCloseness(v(1991), v(1997))).toBe(1);
    expect(yearCloseness(v(1991), v(2003))).toBe(0.5);
    expect(yearCloseness(v(1975), v(2003))).toBe(0);
    expect(yearCloseness(v(null), v(2003))).toBe(0);
  });
  it('함께 있는 태그를 무거운 순으로 최대 2개', () => {
    const a = toVector([mb('shoegaze', 8), mb('dream pop', 2), mb('noise rock')], null);
    const b = toVector([mb('shoegaze', 3), mb('dream pop', 5), mb('noise rock')], null);
    expect(sharedTags(a, b)).toEqual(['shoegaze', 'dream pop']);
  });
  it('YouTube 응답 같은 다른 출처의 글은 타입으로 받지 않는다', () => {
    const youtubeTag = { name: 'rock', source: 'youtube' };
    // @ts-expect-error source는 musicbrainz·wikidata만 (D-041)
    toVector([youtubeTag], null);
    expect(true).toBe(true);
  });
});

describe('저장용 모양', () => {
  it('낱말 목록에 있는 태그만 낱말 목록 표기로(개인 태그·자유 글은 버림)', () => {
    expect(
      knownTagWords([mb('Hip-Hop'), mb('seen live'), mb('vyrzukhisuc-artiest'), mb('Trip Hop')]),
    ).toEqual(['hip hop', 'trip hop']);
  });
  it('희소 모양으로 줄였다가 그대로 되돌린다', () => {
    const v = toVector([mb('shoegaze', 8), mb('dream pop', 2)], 1991);
    const w = toSparse(v.tags);
    expect(Object.keys(w)).toHaveLength(2);
    expect(fromSparse(w, v.vocabVersion, v.decade)).toEqual(v);
  });
  it('같은 자리가 두 번 오면 더하지 않고 큰 쪽(동의어)', () => {
    const once = toVector([mb('hip hop', 4)], null);
    const twice = toVector([mb('hip hop', 4), mb('rap', 1)], null);
    expect(twice).toEqual(once);
  });
});
