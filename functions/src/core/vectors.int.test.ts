import { readFileSync } from 'node:fs';
import { fromSparse, VOCAB_VERSION, vocabIndex } from '@musicweb/shared/similarity';
import { beforeEach, describe, expect, it } from 'vitest';
import { parseRecording, type RecordingDetail } from '../adapters/musicbrainz.js';
import { clearFirestore, emulatorDb } from '../testing/emulator.js';
import { computeArtistVectors, mergeTags } from './vectors.js';

/** 아티스트별 곡 숫자 묶음 (SPEC 4.3, T28, D-045). MusicBrainz 응답은 녹화본(Karma Police)과 손으로 만든 것 */
const db = emulatorDb();
beforeEach(clearFirestore);

const RADIOHEAD = 'a74b1b7f-71a5-4011-9441-d0b5e4122711';
const PORTISHEAD = '8f6bd1e4-fbe1-4f50-aa9b-94c450ec0f11';
const KARMA = '9e2ad5bc-c6f9-40d2-a36f-3122ee2072a3';
const NO_TAGS = '00000000-0000-4000-8000-000000000002';
const GLORY = '00000000-0000-4000-8000-000000000003';
const karma = parseRecording(
  JSON.parse(readFileSync('tests/fixtures/music/mb-recording-karma-police.json', 'utf8')),
) as RecordingDetail;

const recordings: Record<string, RecordingDetail | null> = {
  [KARMA]: karma,
  [NO_TAGS]: { ...karma, mbid: NO_TAGS, genres: [], tags: [] },
  [GLORY]: {
    ...karma,
    mbid: GLORY,
    artistMbid: PORTISHEAD,
    genres: [{ name: 'trip hop', source: 'musicbrainz', count: 9 }],
    tags: [
      { name: 'Trip-Hop', source: 'musicbrainz', count: 2 },
      { name: 'seen live', source: 'musicbrainz', count: 5 },
    ],
  },
};

describe('computeArtistVectors', () => {
  it('아티스트 2명 계산 → artistVectors 2건, 곡에 태그·장르 이름, 태그 없는 곡은 연도대만', async () => {
    await db.doc(`songs/${KARMA}`).set({ artistMbid: RADIOHEAD, releaseYear: 1997 });
    await db.doc(`songs/${NO_TAGS}`).set({ artistMbid: RADIOHEAD, releaseYear: 2003 });
    await db.doc(`songs/${GLORY}`).set({ artistMbid: PORTISHEAD, releaseYear: 1994 });
    const calls: string[] = [];
    const mb = {
      getRecording: async (id: string) => {
        calls.push(id);
        return recordings[id] ?? null;
      },
    };

    expect(await computeArtistVectors({ db, mb }, RADIOHEAD)).toEqual({ songs: 2, kept: 0 });
    expect(await computeArtistVectors({ db, mb }, PORTISHEAD)).toEqual({ songs: 1, kept: 0 });
    expect(calls.sort()).toEqual([GLORY, KARMA, NO_TAGS].sort());
    expect((await db.collection('artistVectors').get()).size).toBe(2);

    const rh = (await db.doc(`artistVectors/${RADIOHEAD}`).get()).data();
    expect(rh?.vocabVersion).toBe(VOCAB_VERSION);
    type Stored = { songId: string; w: Record<string, number>; decade: number | null };
    const byId = new Map((rh?.songs as Stored[]).map((s) => [s.songId, s]));
    const k = byId.get(KARMA) as Stored;
    // 희소 모양: 0이 아닌 자리만
    expect(Object.values(k.w).every((x) => x > 0)).toBe(true);
    expect(
      fromSparse(k.w, VOCAB_VERSION, k.decade).tags[vocabIndex('alternative rock')],
    ).toBeGreaterThan(0);
    expect(k.decade).toBe(1990);
    const empty = byId.get(NO_TAGS);
    expect(empty?.w).toEqual({});
    expect(empty?.decade).toBe(2000);

    // 곡 문서(누구나 읽음)에는 낱말 목록에 있는 태그만, 낱말 목록 표기로
    const song = (await db.doc(`songs/${KARMA}`).get()).data();
    expect(song?.tags).toContain('alternative rock');
    expect(song?.genres).toContain('alternative rock');
    expect(song?.tags).not.toContain('cold'); // 녹화 응답의 개인 태그
    expect((await db.doc(`songs/${GLORY}`).get()).get('tags')).toEqual(['trip hop']);
    // 동의어(Trip-Hop / trip hop)는 하나로, 모르는 태그(seen live)는 숫자 묶음에 자리가 없다
    const ph = (await db.doc(`artistVectors/${PORTISHEAD}`).get()).data();
    const g = (ph?.songs as { w: Record<string, number> }[])[0];
    expect(g?.w).toEqual({ [String(vocabIndex('trip hop'))]: 1 });
    // artistVectors에는 YouTube 데이터가 없다
    expect(JSON.stringify(rh)).not.toMatch(/videoId|ytTitle|channelId/);
  });

  it('녹음을 못 받으면 곡 문서는 그대로, 숫자 묶음은 이전 값 유지', async () => {
    await db.doc(`songs/${KARMA}`).set({ artistMbid: RADIOHEAD, releaseYear: 1997 });
    const ok = { getRecording: async () => karma };
    await computeArtistVectors({ db, mb: ok }, RADIOHEAD);
    const before = (await db.doc(`songs/${KARMA}`).get()).get('tags');
    const gone = { getRecording: async () => null };
    expect(await computeArtistVectors({ db, mb: gone }, RADIOHEAD)).toEqual({ songs: 1, kept: 1 });
    expect((await db.doc(`songs/${KARMA}`).get()).get('tags')).toEqual(before);
    const v = (await db.doc(`artistVectors/${RADIOHEAD}`).get()).get('songs');
    expect(v[0].w[String(vocabIndex('alternative rock'))]).toBeGreaterThan(0);
  });

  it('곡이 상한보다 많으면 최근 조회된 곡부터 상한까지, 정보가 적은 곡(mbid 없음)은 건너뜀', async () => {
    const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    for (let n = 10; n < 15; n++) {
      await db.doc(`songs/${id(n)}`).set({
        artistMbid: RADIOHEAD,
        releaseYear: 2000,
        lastRequestedAt: new Date(Date.UTC(2026, 0, n)),
      });
    }
    await db.doc('songs/lowinfo1').set({ artistMbid: RADIOHEAD, mbid: null });
    const calls: string[] = [];
    const mb = {
      getRecording: async (m: string) => {
        calls.push(m);
        return { ...karma, mbid: m };
      },
    };
    expect(await computeArtistVectors({ db, mb }, RADIOHEAD, { maxSongs: 2 })).toEqual({
      songs: 2,
      kept: 0,
    });
    expect(calls).toEqual([id(14), id(13)]);
  });

  it('mergeTags: 같은 낱말은 투표 수가 큰 쪽 하나', () => {
    expect(
      mergeTags(
        [{ name: 'hip hop', source: 'musicbrainz', count: 2 }],
        [{ name: 'Hip-Hop', source: 'musicbrainz', count: 7 }],
      ),
    ).toEqual([{ name: 'Hip-Hop', source: 'musicbrainz', count: 7 }]);
  });
});
