import { describe, expect, it } from 'vitest';
import {
  LB_ARTIST_ALGORITHM as ADAPTER_LB_ARTIST,
  LB_RECORDING_ALGORITHM as ADAPTER_LB_RECORDING,
} from '../functions/src/adapters/listenbrainz.js';
import { recordingSearchQuery } from '../functions/src/adapters/musicbrainz.js';
import { artistsQuery, worksQuery } from '../functions/src/adapters/wikidata.js';
import { FIXTURES, LB_ARTIST_ALGORITHM, LB_RECORDING_ALGORITHM } from './record-music-fixtures.ts';

// 녹화 응답이 실제 어댑터 요청을 대표하도록, 녹화 도구의 질의가 어댑터와 같은지 확인한다(D-024).
const url = (name: string) => new URL(FIXTURES.find(([n]) => n === name)?.[1] ?? '');

describe('녹화 도구 ↔ 어댑터 요청 일치', () => {
  it('ListenBrainz 알고리즘 이름이 같다', () => {
    expect(LB_RECORDING_ALGORITHM).toBe(ADAPTER_LB_RECORDING);
    expect(LB_ARTIST_ALGORITHM).toBe(ADAPTER_LB_ARTIST);
  });

  it('MusicBrainz 검색 질의가 어댑터와 같다', () => {
    expect(url('mb-recording-search-karma-police.json').searchParams.get('query')).toBe(
      recordingSearchQuery('Radiohead', 'Karma Police'),
    );
    expect(url('mb-recording-search-iu.json').searchParams.get('query')).toBe(
      recordingSearchQuery('IU', '밤편지'),
    );
  });

  it('Wikidata 질의가 어댑터와 같다', () => {
    expect(url('wd-work-karma-police.json').searchParams.get('query')).toBe(
      worksQuery(['babefb9d-3d87-3378-bfac-e13f89ae7a48']),
    );
    expect(url('wd-artist-radiohead.json').searchParams.get('query')).toBe(
      artistsQuery(['a74b1b7f-71a5-4011-9441-d0b5e4122711']),
    );
  });
});
