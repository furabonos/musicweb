import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { compareKey } from '@musicweb/shared';
import type { createLastfm } from '../adapters/lastfm.js';
import type { createListenBrainz } from '../adapters/listenbrainz.js';
import type { Llm } from '../adapters/llm.js';
import type { createMusicBrainz } from '../adapters/musicbrainz.js';
import type { createWikidata } from '../adapters/wikidata.js';
import type { YouTubeRead } from '../adapters/youtube-read.js';
import { firestoreSongs, freshLinks, songKey } from './catalog.js';
import type { EventSink } from './events.js';
import type { RecommendPorts } from './recommend.js';
import type { StoredSongVector } from './vectors.js';
import { VOCAB_VERSION } from '@musicweb/shared/similarity';

/**
 * 추천 포트의 운영용 구현(T13): Firestore 곡 목록 + 어댑터. 호출하는 함수(T14 callable)가 어댑터를 만들어 넘긴다.
 * 조회로 찾은 연결은 곡 목록에 저장한다(SPEC 4.4 "결과는 곡 목록에 추가한다"). 이미 다른 곡에 연결된 영상은 겹쳐 쓰지 않는다.
 */
export function firestoreRecommendPorts(deps: {
  db: Firestore;
  mb: ReturnType<typeof createMusicBrainz>;
  lb: ReturnType<typeof createListenBrainz>;
  wd: ReturnType<typeof createWikidata>;
  lastfm?: ReturnType<typeof createLastfm>;
  yt: YouTubeRead;
  llm: Llm;
  events: EventSink;
  now?: () => Date;
}): RecommendPorts {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());
  const lastfm = deps.lastfm;
  return {
    precomputed: firestorePrecomputed(db),
    songs: firestoreSongs(db),
    links: (ids) => freshLinks(db, ids, now()),
    music: {
      lbSearch: (q) => deps.lb.searchRecording(q),
      mbSearch: (a, t, n) => deps.mb.searchRecordings(a, t, n),
      similarRecordings: (m, n) => deps.lb.similarRecordings(m, n),
      similarArtists: (m, n) => deps.lb.similarArtists(m, n),
      ...(lastfm
        ? { lastfmSimilar: (a: string, t: string, n: number) => lastfm.similarTracks(a, t, n) }
        : {}),
      getRecording: (m) => deps.mb.getRecording(m),
      works: (ms) => deps.wd.works(ms),
    },
    yt: {
      videos: (ids) => deps.yt.videos(ids),
      search: (q, who, n) => deps.yt.search(q, who, n),
    },
    async officialChannels(artistMbid) {
      if (!artistMbid) return [];
      const id = (await db.doc(`artists/${artistMbid}`).get()).get('channelId');
      return typeof id === 'string' ? [id] : [];
    },
    async saveLink(song, video, kind, at) {
      const existing = await db
        .collectionGroup('links')
        .where('videoId', '==', video.videoId)
        .limit(1)
        .get();
      if (!existing.empty) return false;
      const songRef = db.doc(`songs/${song.mbid}`);
      const batch = db.batch();
      batch.set(
        songRef,
        {
          mbid: song.mbid,
          artist: song.artist,
          artistMbid: song.artistMbid,
          title: song.title,
          key: songKey(song.artist, song.title),
          titleKey: compareKey(song.title),
          releaseYear: song.releaseYear,
          source: 'musicbrainz',
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      batch.set(songRef.collection('links').doc(video.videoId), {
        videoId: video.videoId,
        kind,
        status: 'active',
        linkedBy: 'lookup',
        ytTitle: video.title,
        channelId: video.channelId,
        embeddable: video.embeddable,
        madeForKids: video.madeForKids,
        durationSec: video.durationSec,
        verifiedAt: at,
      });
      await batch.commit();
      return true;
    },
    llm: deps.llm,
    events: deps.events,
    now,
  };
}

/** 미리 계산한 비슷한 아티스트·숫자 묶음 읽기 (T29가 쓴 서버 전용 문서, T30) */
export function firestorePrecomputed(db: Firestore): NonNullable<RecommendPorts['precomputed']> {
  return {
    async similar(artistMbid) {
      const snap = await db.doc(`artistSimilar/${artistMbid}`).get();
      if (!snap.exists) return null;
      return ((snap.get('items') ?? []) as { artistMbid: string; score: number }[]).filter(
        (i) => typeof i?.artistMbid === 'string' && typeof i.score === 'number',
      );
    },
    async vectors(artistMbids) {
      const ids = [...new Set(artistMbids)];
      const out = new Map<string, StoredSongVector[]>();
      if (!ids.length) return out;
      const snaps = await db.getAll(...ids.map((id) => db.doc(`artistVectors/${id}`)));
      for (const s of snaps) {
        // 다른 낱말 목록 버전의 숫자 묶음은 비교하지 않는다(D-045)
        if (s.exists && s.get('vocabVersion') === VOCAB_VERSION) {
          out.set(s.id, (s.get('songs') ?? []) as StoredSongVector[]);
        }
      }
      return out;
    },
  };
}
