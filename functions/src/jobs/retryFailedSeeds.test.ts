import { describe, expect, it } from 'vitest';
import type { RecordingCandidate } from '../adapters/musicbrainz.js';
import { matchArtist } from './retryFailedSeeds.js';

/** 다시 찾기의 아티스트 고르기 (T43). 저장·호출은 retryFailedSeeds.int.test.ts */
const cand = (over: Partial<RecordingCandidate>): RecordingCandidate => ({
  mbid: 'r1',
  title: 'Song',
  artist: 'Artist',
  artistMbid: 'a1',
  firstReleaseYear: null,
  score: 100,
  disambiguation: null,
  lengthMs: null,
  ...over,
});

describe('matchArtist', () => {
  it('제목까지 같은 후보의 아티스트를 먼저, 대소문자·기호는 무시', () => {
    const out = matchArtist(
      [
        cand({ title: 'Other', artistMbid: 'a-other' }),
        cand({ title: 'Doja!', artistMbid: 'a-cee' }),
      ].map((c) => ({ ...c, artist: 'Central Cee' })),
      { artist: 'central cee', title: 'doja' },
    );
    expect(out).toEqual({ mbid: 'a-cee', name: 'Central Cee' });
  });

  it('곡은 없어도 같은 아티스트 후보가 있으면 그 아티스트', () => {
    expect(
      matchArtist([cand({ artist: 'IU', title: 'Blueming', artistMbid: 'a-iu' })], {
        artist: 'iu',
        title: 'Unreleased',
      }),
    ).toEqual({ mbid: 'a-iu', name: 'IU' });
  });

  it('다른 아티스트(같은 제목의 커버 등)나 아티스트 ID가 없는 후보는 고르지 않는다', () => {
    expect(
      matchArtist(
        [
          cand({ artist: 'Someone Else', title: 'Doja' }),
          cand({ artist: 'Central Cee', artistMbid: null }),
        ],
        { artist: 'Central Cee', title: 'Doja' },
      ),
    ).toBeNull();
  });
});
