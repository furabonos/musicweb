import { getFirestore } from 'firebase-admin/firestore';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { createMusicBrainz } from '../adapters/musicbrainz.js';
import { firestoreCallBudget } from '../adapters/music-http.js';
import { createWikidata } from '../adapters/wikidata.js';
import { createYouTubeRead, firestoreYtBudget } from '../adapters/youtube-read.js';
import { MB_CONTACT, secrets } from '../config/secrets.js';
import { firestoreEventSink } from '../core/events.js';
import { firestoreLastfmCache } from '../adapters/lastfm.js';
import { runIngest } from './ingest.js';
import { runPurge } from './purge.js';
import { runRefresh } from './refresh.js';

/**
 * 예약 작업 (SPEC 4.4). 태평양 시간 기준, YouTube 할당 초기화(자정) 뒤에 차례로 돈다:
 *   01:00 재확인(refresh) → 02:00 정리(purge) → 03:00 수집(ingest).
 *   재확인이 먼저 돌아야 확인된 연결이 정리에서 지워지지 않는다.
 * - 인스턴스 1개: 음악 데이터 출처별 초당 1회 줄이 인스턴스 안에서만 공유되기 때문(D-024).
 * - AI 판정(judge)은 T12에서 연결한다. 그 전까지 애매한 연결은 pending_ai로 남는다.
 */
export const ingestNightly = onSchedule(
  {
    schedule: 'every day 03:00',
    timeZone: 'America/Los_Angeles',
    maxInstances: 1,
    timeoutSeconds: 540,
    retryCount: 0,
    secrets: [secrets.YOUTUBE_API_KEY, secrets.ACTOR_HASH_KEY],
  },
  async () => {
    // 제한 시간(540초)보다 60초 앞에서 멈추고 처리한 데까지 저장한다.
    const deadlineMs = Date.now() + 480_000;
    const db = getFirestore();
    const events = firestoreEventSink(db, secrets.ACTOR_HASH_KEY.value());
    const music = { events, budget: firestoreCallBudget(db), contact: MB_CONTACT.value() };
    await runIngest({
      db,
      yt: createYouTubeRead({
        apiKey: secrets.YOUTUBE_API_KEY.value(),
        events,
        budget: firestoreYtBudget(db, 'ingest'),
      }),
      mb: createMusicBrainz(music),
      wd: createWikidata(music),
      events,
      deadlineMs,
    });
  },
);

/** 25일 재확인 (T11). YouTube 한도·긴급 정지 ingest를 따른다. */
export const refreshNightly = onSchedule(
  {
    schedule: 'every day 01:00',
    timeZone: 'America/Los_Angeles',
    maxInstances: 1,
    timeoutSeconds: 540,
    retryCount: 0,
    secrets: [secrets.YOUTUBE_API_KEY, secrets.ACTOR_HASH_KEY],
  },
  async () => {
    const deadlineMs = Date.now() + 480_000;
    const db = getFirestore();
    const events = firestoreEventSink(db, secrets.ACTOR_HASH_KEY.value());
    await runRefresh({
      db,
      yt: createYouTubeRead({
        apiKey: secrets.YOUTUBE_API_KEY.value(),
        events,
        budget: firestoreYtBudget(db, 'ingest'),
      }),
      events,
      deadlineMs,
    });
  },
);

/** 30일 정리 (T11). 외부 호출 없이 지우기만 하므로 긴급 정지와 관계없이 돈다. */
export const purgeNightly = onSchedule(
  {
    schedule: 'every day 02:00',
    timeZone: 'America/Los_Angeles',
    maxInstances: 1,
    timeoutSeconds: 540,
    retryCount: 0,
    secrets: [secrets.ACTOR_HASH_KEY],
  },
  async () => {
    const db = getFirestore();
    await runPurge({
      db,
      events: firestoreEventSink(db, secrets.ACTOR_HASH_KEY.value()),
      lastfmCache: firestoreLastfmCache(db),
    });
  },
);
