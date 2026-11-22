import { describe, expect, it } from 'vitest';
import type { RecordingCandidate } from '../adapters/musicbrainz.js';
import { buildEvent } from '../core/events.js';
import { errName } from '../core/jobErrors.js';
import { MAX_FAILS, nextArtistState, pickRecording } from './ingest.js';

describe('nextArtistState: 연속 실패', () => {
  it(`연속 ${MAX_FAILS}번 실패하면 failed가 되고, 그때 한 번만 becameFailed`, () => {
    let s = { failCount: 0, status: 'active' as const as 'active' | 'paused' | 'failed' };
    const seen: boolean[] = [];
    for (let i = 0; i < 4; i++) {
      const n = nextArtistState(s, 'failed');
      seen.push(n.becameFailed);
      s = { failCount: n.failCount, status: n.status };
    }
    expect(s).toEqual({ failCount: 4, status: 'failed' });
    expect(seen).toEqual([false, false, true, false]);
  });

  it('성공하면 실패 횟수를 0으로', () => {
    expect(nextArtistState({ failCount: 2, status: 'active' }, 'ok')).toEqual({
      failCount: 0,
      status: 'active',
      becameFailed: false,
    });
  });
});

describe('pickRecording: MusicBrainz 후보 고르기', () => {
  const A = 'a74b1b7f-71a5-4011-9441-d0b5e4122711';
  const c = (o: Partial<RecordingCandidate>): RecordingCandidate => ({
    mbid: '00000000-0000-4000-8000-000000000000',
    title: 'Karma Police',
    artist: 'Radiohead',
    artistMbid: A,
    firstReleaseYear: 1997,
    score: 100,
    disambiguation: null,
    lengthMs: 264_000,
    ...o,
  });

  it('라이브 등 구분 설명이 없는 것, 그다음 이른 연도', () => {
    const live = c({
      mbid: '00000000-0000-4000-8000-000000000001',
      disambiguation: 'live, 2003',
      firstReleaseYear: 1990,
    });
    const remaster = c({ mbid: '00000000-0000-4000-8000-000000000002', firstReleaseYear: 2017 });
    const original = c({ mbid: '00000000-0000-4000-8000-000000000003', firstReleaseYear: 1997 });
    expect(pickRecording([live, remaster, original], { mbid: A }, ['karma police'])?.mbid).toBe(
      original.mbid,
    );
  });

  it('다른 아티스트·다른 제목은 고르지 않는다', () => {
    expect(
      pickRecording([c({ artistMbid: 'b9545342-1e6d-4dae-84ac-013374ad8d7c' })], { mbid: A }, [
        'karma police',
      ]),
    ).toBeNull();
    expect(
      pickRecording([c({ title: 'Karma Police (Remix)' })], { mbid: A }, ['karma police']),
    ).toBeNull();
  });

  it('다국어 제목 후보 중 하나와 맞으면 고른다', () => {
    const night = c({ title: '밤편지', artistMbid: 'b9545342-1e6d-4dae-84ac-013374ad8d7c' });
    expect(
      pickRecording([night], { mbid: 'b9545342-1e6d-4dae-84ac-013374ad8d7c' }, [
        'through the night',
        '밤편지',
      ]),
    ).toBe(night);
  });
});

describe('errName: 이벤트 오류 코드', () => {
  class SourceUnavailableError extends Error {
    override name = 'SourceUnavailableError';
  }
  it('긴 오류 이름도 이벤트 검사를 통과하는 snake_case가 된다', () => {
    const code = errName(new SourceUnavailableError('x'));
    expect(code).toBe('source_unavailable_error');
    expect(() =>
      buildEvent(
        { type: 'error', attrs: { code, where: 'ingest.musicbrainz' }, outcome: 'error' },
        'k'.repeat(32),
      ),
    ).not.toThrow();
    expect(errName('not an error')).toBe('unknown');
  });
});
