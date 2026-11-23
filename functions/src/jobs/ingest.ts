import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import {
  compareKey,
  decideLink,
  splitArtistTitle,
  type Decision,
  type SongRef,
  type Include,
  type Judge,
  type VideoCandidate,
} from '@musicweb/shared';
import { JudgeNoOutputError, LlmCallError } from '../adapters/llm.js';
import type { createMusicBrainz, RecordingCandidate } from '../adapters/musicbrainz.js';
import type { createWikidata } from '../adapters/wikidata.js';
import { SourceUnavailableError } from '../adapters/music-http.js';
import type { VideoDetail, YouTubeRead } from '../adapters/youtube-read.js';
import { BudgetExceededError } from '../core/budget.js';
import type { EventSink } from '../core/events.js';
import { errName, isOutage } from '../core/jobErrors.js';
import { songKey } from '../core/catalog.js';
import { addOpsLog } from '../core/opsLog.js';
import { assertEnabled, KillSwitchError, type ServiceCounter } from '../core/runtimeConfig.js';

/**
 * 야간 곡 목록 수집 (SPEC 4.4, T10, D-027).
 *
 * 아티스트마다: 공식 채널 찾기(MusicBrainz → Wikidata) → uploads 재생목록 → 지난번 이후 새 업로드만 →
 * 영상 상세(50개씩) → MusicBrainz에서 그 곡 찾기 → 곡 연결 규칙(T09) → songs·links 저장.
 *
 * - 시작 전에 긴급 정지 `ingest`를 확인한다. 꺼져 있으면 외부 호출을 하나도 하지 않는다.
 *   YouTube 호출마다 쓰는 한도(firestoreYtBudget(db, 'ingest'))도 매번 스위치를 다시 확인한다.
 * - 한도에 닿으면 그 자리에서 멈추고 운영 일지에 "한도 도달"을 남긴다. 처리한 것까지는 저장돼 있다.
 * - 곡 정보(아티스트·제목·연도)는 MusicBrainz에서 온다. YouTube 제목은 곡을 찾는 데만 쓰고 곡 정보로 저장하지 않는다.
 * - 연결에는 YouTube 데이터(영상 제목·채널·퍼가기·아동용)와 확인 시각이 들어간다. 25일 재확인·30일 정리는 refresh.ts·purge.ts(T11).
 * - 연속 3번 실패한 아티스트는 failed로 바꾸고 이벤트·운영 일지를 남긴다.
 */

export const MAX_FAILS = 3;
export const DEFAULT_LIMITS = {
  /** 한 번에 도는 아티스트 수 */
  maxArtists: 20,
  /** 아티스트당 업로드 목록 쪽 수(쪽당 50개) */
  maxPages: 4,
  /** 아티스트당 곡을 찾아볼 새 영상 수(MusicBrainz 검색 1회씩, 초당 1회) */
  maxVideos: 60,
  /** 하루에 대기열에서 수집 대상으로 옮길 아티스트 수 */
  maxQueuePerRun: 50,
};
/** 수집할 때 함께 저장하는 종류. 라이브·리믹스도 저장해 두고, 추천에서 요청 조건으로 거른다(SPEC 3.1). */
const INGEST_INCLUDE: Include = { live: true, remix: true, cover: false };

export interface IngestDeps {
  db: Firestore;
  yt: YouTubeRead;
  mb: ReturnType<typeof createMusicBrainz>;
  wd: ReturnType<typeof createWikidata>;
  events: EventSink;
  /** 애매한 연결 판정(T12). 없으면 pending_ai로 저장한다. */
  judge?: Judge;
  now?: () => Date;
  limits?: Partial<typeof DEFAULT_LIMITS>;
  /** 이 시각(ms)이 지나면 다음 아티스트·다음 영상 묶음으로 넘어가지 않고 정상 종료한다. 예약 함수의 제한 시간보다 앞에 둔다. */
  deadlineMs?: number;
  /** 마감 비교용 시계(ms). 테스트에서 바꾼다. */
  clock?: () => number;
}

export interface IngestSummary {
  /** limit: 한도, killSwitch: 긴급 정지, outage: YouTube 할당량 소진·출처 장애, deadline: 실행 시간 마감 */
  stoppedBy: 'limit' | 'killSwitch' | 'outage' | 'deadline' | null;
  artists: number;
  videosSeen: number;
  linksActive: number;
  linksPending: number;
  failedArtists: number;
}

export interface ArtistDoc {
  name: string;
  mbid: string;
  status: 'active' | 'paused' | 'failed';
  channelId: string | null;
  uploadsPlaylistId: string | null;
  /** 가장 최근에 본 업로드 시각(ISO). 이보다 새로운 것만 처리한다. */
  lastSeenPublishedAt: string | null;
  lastScannedAt: unknown;
  failCount: number;
  /** 채널 정보(YouTube 데이터)를 마지막으로 확인한 시각. 25일 재확인·30일 정리 기준(T11). */
  ytVerifiedAt: unknown;
}

/** 실패·성공에 따른 아티스트 상태 변화. 연속 3번 실패면 failed. */
export function nextArtistState(
  artist: Pick<ArtistDoc, 'failCount' | 'status'>,
  outcome: 'ok' | 'failed',
): { failCount: number; status: ArtistDoc['status']; becameFailed: boolean } {
  if (outcome === 'ok') return { failCount: 0, status: artist.status, becameFailed: false };
  const failCount = artist.failCount + 1;
  const status = failCount >= MAX_FAILS ? 'failed' : artist.status;
  return { failCount, status, becameFailed: status === 'failed' && artist.status !== 'failed' };
}

class NoChannelError extends Error {
  override name = 'NoChannelError';
}

const ms = (iso: string) => Date.parse(iso);

export async function runIngest(deps: IngestDeps): Promise<IngestSummary> {
  const { db } = deps;
  const limits = { ...DEFAULT_LIMITS, ...deps.limits };
  const summary: IngestSummary = {
    stoppedBy: null,
    artists: 0,
    videosSeen: 0,
    linksActive: 0,
    linksPending: 0,
    failedArtists: 0,
  };

  try {
    await assertEnabled(db, 'ingest');
  } catch (err) {
    if (!(err instanceof KillSwitchError)) throw err;
    await deps.events.record({
      type: 'kill_switch_blocked',
      attrs: { feature: 'ingest' },
      outcome: 'rejected',
    });
    return { ...summary, stoppedBy: 'killSwitch' };
  }

  await deps.events.record({ type: 'job_started', attrs: { job: 'ingest' }, outcome: 'ok' });
  const clock = deps.clock ?? Date.now;
  const pastDeadline = () => deps.deadlineMs !== undefined && clock() >= deps.deadlineMs;
  try {
    await promoteQueue(db, limits.maxQueuePerRun);
  } catch (err) {
    // 대기열 옮기기가 실패해도 기존 대상 수집은 계속한다.
    await deps.events.record({
      type: 'error',
      attrs: { code: errName(err), where: 'ingest.queue' },
      outcome: 'error',
    });
    await addOpsLog(db, {
      kind: 'job_failed',
      message: 'Ingest: moving queued artists failed; continuing with existing artists.',
    });
  }

  // AI 판정: 한 번 실패하면 이번 실행에서는 끈다(linkVideo)
  const judgeState: { judge: Judge | undefined } = { judge: deps.judge };
  const snap = await db
    .collection('artists')
    .where('status', '==', 'active')
    .orderBy('lastScannedAt')
    .limit(limits.maxArtists)
    .get();

  for (const doc of snap.docs) {
    if (pastDeadline()) {
      summary.stoppedBy = 'deadline';
      break;
    }
    const artist = doc.data() as ArtistDoc;
    summary.artists++;
    try {
      const r = await ingestArtist(deps, judgeState, doc.ref, artist, limits, pastDeadline);
      summary.videosSeen += r.videosSeen;
      summary.linksActive += r.linksActive;
      summary.linksPending += r.linksPending;
      await doc.ref.update({ failCount: nextArtistState(artist, 'ok').failCount });
      if (r.gap) {
        await addOpsLog(db, {
          kind: 'job',
          message: `Ingest: an artist had more than ${limits.maxPages * 50} new uploads since the last run; older ones were skipped.`,
        });
      }
      if (r.deadlineHit) {
        summary.stoppedBy = 'deadline';
        break;
      }
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        summary.stoppedBy = 'limit';
        await deps.events.record({
          type: 'limit_reached',
          attrs: { scope: err.scope, counter: err.counter as ServiceCounter },
          outcome: 'rejected',
        });
        await addOpsLog(db, {
          kind: 'limit',
          message: `Ingest stopped: daily limit reached (${err.counter}). Resumes after the next reset.`,
        });
        break;
      }
      if (err instanceof KillSwitchError) {
        summary.stoppedBy = 'killSwitch';
        await deps.events.record({
          type: 'kill_switch_blocked',
          attrs: { feature: 'ingest' },
          outcome: 'rejected',
        });
        await addOpsLog(db, {
          kind: 'job',
          message: 'Ingest stopped: the ingest kill switch was turned off during the run.',
        });
        break;
      }
      if (isOutage(err)) {
        summary.stoppedBy = 'outage';
        const source = err instanceof SourceUnavailableError ? err.source : 'youtube';
        await deps.events.record({
          type: 'error',
          attrs: { code: errName(err), where: `ingest.${source}` },
          outcome: 'error',
        });
        await addOpsLog(db, {
          kind: 'job_failed',
          message: `Ingest stopped: ${source} is unavailable or out of quota. Artists were not marked as failed; will retry next run.`,
        });
        break;
      }
      const next = nextArtistState(artist, 'failed');
      await doc.ref.update({ failCount: next.failCount, status: next.status });
      await deps.events.record({
        type: 'artist_ingest_failed',
        attrs: {
          artistMbid: artist.mbid,
          failCount: next.failCount,
          status: next.status === 'failed' ? 'failed' : 'active',
        },
        outcome: 'error',
      });
      if (next.becameFailed) {
        summary.failedArtists++;
        await addOpsLog(db, {
          kind: 'job_failed',
          message: `Ingest: an artist failed ${MAX_FAILS} times in a row and was paused (status failed).`,
        });
      }
    }
  }

  await deps.events.record({
    type: 'job_finished',
    attrs: { job: 'ingest', processed: summary.videosSeen, failed: summary.failedArtists },
    outcome: summary.stoppedBy ? 'rejected' : 'ok',
  });
  await addOpsLog(db, {
    kind: 'job',
    message: `Ingest finished: ${summary.artists} artists, ${summary.videosSeen} new videos, ${summary.linksActive} links${summary.stoppedBy ? ` (stopped: ${summary.stoppedBy})` : ''}.`,
  });
  return summary;
}

async function ingestArtist(
  deps: IngestDeps,
  judgeState: { judge: Judge | undefined },
  ref: FirebaseFirestore.DocumentReference,
  artist: ArtistDoc,
  limits: typeof DEFAULT_LIMITS,
  pastDeadline: () => boolean,
) {
  const now = deps.now ?? (() => new Date());

  // 1. 공식 채널: MusicBrainz URL 관계 → Wikidata P2397
  let channelId = artist.channelId;
  if (!channelId) {
    const mbArtist = await deps.mb.getArtist(artist.mbid);
    channelId = mbArtist?.youtubeChannelIds[0] ?? null;
    if (!channelId) {
      const wd = await deps.wd.artistChannels([artist.mbid]);
      channelId = wd.get(artist.mbid)?.youtubeChannelIds[0] ?? null;
    }
    if (!channelId) throw new NoChannelError('공식 채널을 찾지 못했습니다.');
    await ref.update({ channelId, ytVerifiedAt: now() });
  }

  // 2. uploads 재생목록
  let uploads = artist.uploadsPlaylistId;
  if (!uploads) {
    uploads = await deps.yt.uploadsPlaylist(channelId);
    if (!uploads) throw new NoChannelError('업로드 목록이 없습니다.');
    await ref.update({ uploadsPlaylistId: uploads, ytVerifiedAt: now() });
  }

  // 3. 지난번 이후 새 업로드만 (최신 것부터 오므로, 이미 본 시각에 닿으면 멈춘다).
  //    게시 시각이 없는 항목(비공개 등)은 건너뛴다. 처음 보는 아티스트는 최근 maxPages쪽(최대 200개)까지만 본다.
  //    시각은 Date.parse로 비교한다(밀리초 표기가 섞여도 맞게).
  const watermark = artist.lastSeenPublishedAt;
  const wm = watermark ? ms(watermark) : null;
  const fresh: { videoId: string; publishedAt: string; t: number }[] = [];
  let pageToken: string | undefined;
  let reachedSeen = false;
  for (let page = 0; page < limits.maxPages && !reachedSeen; page++) {
    const r = await deps.yt.uploadsPage(uploads, pageToken);
    for (const it of r.items) {
      const t = it.publishedAt ? ms(it.publishedAt) : NaN;
      if (!it.publishedAt || !Number.isFinite(t)) continue;
      if (wm !== null && t <= wm) {
        reachedSeen = true;
        break;
      }
      fresh.push({ videoId: it.videoId, publishedAt: it.publishedAt, t });
    }
    if (!r.nextPageToken) {
      reachedSeen = true; // 목록 끝
      break;
    }
    pageToken = r.nextPageToken;
  }
  // 지난번 이후 새 업로드가 쪽 수 상한보다 많았다(그 사이 것은 건너뜀) — 운영 일지에 남긴다.
  const gap = wm !== null && !reachedSeen;

  // 오래된 것부터 maxVideos개만 이번에 처리하고, 기준 시각은 처리한 것까지만 옮긴다(나머지는 다음 실행).
  // 자른 자리와 같은 시각인 영상은 함께 넣는다: 다음 실행의 "기준 시각 이하는 이미 봄"에 걸려 잃지 않게.
  fresh.sort((a, b) => a.t - b.t);
  let cut = Math.min(limits.maxVideos, fresh.length);
  while (cut > 0 && cut < fresh.length && fresh[cut]?.t === fresh[cut - 1]?.t) cut++;
  const toCheck = fresh.slice(0, cut);

  // 4. 영상 상세 (공개·퍼가기 가능한 것만)
  const details = new Map(
    (await deps.yt.videos(toCheck.map((v) => v.videoId)))
      .filter((v) => v.privacyStatus === 'public' && v.embeddable)
      .map((v) => [v.videoId, v]),
  );

  // 5. 곡 찾기 → 연결. 같은 시각 묶음이 끝날 때마다 마감을 확인하고, 마감이면 처리한 데까지만 기준 시각을 옮긴다.
  let linksActive = 0;
  let linksPending = 0;
  let lastSeen = watermark;
  let deadlineHit = false;
  for (let k = 0; k < toCheck.length; k++) {
    const item = toCheck[k];
    if (!item) continue;
    const video = details.get(item.videoId);
    if (video) {
      const r = await linkVideo(deps, judgeState, artist, channelId, video, now());
      if (r === 'active') linksActive++;
      if (r === 'pending_ai') linksPending++;
    }
    const groupEnds = toCheck[k + 1]?.t !== item.t;
    if (groupEnds) {
      lastSeen = item.publishedAt;
      if (k + 1 < toCheck.length && pastDeadline()) {
        deadlineHit = true;
        break;
      }
    }
  }

  await ref.update({
    lastSeenPublishedAt: lastSeen ?? null,
    lastScannedAt: FieldValue.serverTimestamp(),
    // 업로드 목록을 방금 읽었으므로 채널 정보가 확인됐다(30일 규칙, T11)
    ytVerifiedAt: now(),
  });
  // 곡이 늘었으면 미리 계산(T29)에 "다시 계산 필요"를 알린다. 문서가 없으면 computedAt null로 만들어 맨 앞 차례
  if (linksActive + linksPending > 0) {
    const vref = deps.db.doc(`artistVectors/${artist.mbid}`);
    const exists = (await vref.get()).exists;
    await vref.set(
      { songsChangedAt: FieldValue.serverTimestamp(), ...(exists ? {} : { computedAt: null }) },
      { merge: true },
    );
  }
  const processed = lastSeen ? toCheck.filter((v) => v.t <= ms(lastSeen)).length : 0;
  return { videosSeen: processed, linksActive, linksPending, gap, deadlineHit };
}

/** 영상 하나를 그 아티스트의 곡(MusicBrainz 녹음)에 연결한다. */
async function linkVideo(
  deps: IngestDeps,
  judgeState: { judge: Judge | undefined },
  artist: ArtistDoc,
  channelId: string,
  video: VideoDetail,
  now: Date,
): Promise<'active' | 'pending_ai' | 'skipped'> {
  // 이미 어느 곡에든 연결된 영상은 다시 다루지 않는다. 재확인(T11)·AI 판정(T12)·관리자가 바꾼 상태를 덮지 않고,
  // 같은 영상이 다른 곡에 겹쳐 연결되지 않게 한다.
  const existing = await deps.db
    .collectionGroup('links')
    .where('videoId', '==', video.videoId)
    .limit(1)
    .get();
  if (!existing.empty) return 'skipped';
  const split = splitArtistTitle(video.title, video.channelTitle, [artist.name]);
  // 자동 이슈 감지 재료(T19): 숫자로만 남긴다(제목 원문 없음)
  if (split.failed)
    await deps.events.record({ type: 'title_split_failed', attrs: {}, outcome: 'ok' });
  const titleGuess = split.titles[0];
  if (!titleGuess) return 'skipped';
  const recording = pickRecording(
    await deps.mb.searchRecordings(artist.name, titleGuess, 5),
    artist,
    split.titles,
  );
  if (!recording) return 'skipped';

  const candidate: VideoCandidate = {
    videoId: video.videoId,
    title: video.title,
    channelId: video.channelId,
    channelTitle: video.channelTitle,
    description: video.description,
    durationSec: video.durationSec,
  };
  const song = {
    title: recording.title,
    artist: artist.name,
    lengthMs: recording.lengthMs,
    officialChannelIds: [channelId],
  };
  const decision = await decideWithJudge(
    song,
    [candidate],
    INGEST_INCLUDE,
    judgeState,
    deps.events,
  );
  if (decision.status !== 'active' && decision.status !== 'pending_ai') return 'skipped';

  const songRef = deps.db.doc(`songs/${recording.mbid}`);
  const kind =
    decision.status === 'active' ? decision.kind : (decision.candidates[0]?.kind ?? 'other');
  const batch = deps.db.batch();
  // 곡 정보는 MusicBrainz에서 온 값만 (YouTube 제목을 곡 정보로 저장하지 않는다).
  batch.set(
    songRef,
    {
      mbid: recording.mbid,
      artist: recording.artist,
      artistMbid: artist.mbid,
      title: recording.title,
      // 이름으로 찾기용(추천의 Last.fm·AI 후보, T13)
      key: songKey(recording.artist, recording.title),
      // 제목으로 찾기(곡 고르기 제안, T33)
      titleKey: compareKey(recording.title),
      releaseYear: recording.firstReleaseYear,
      source: 'musicbrainz',
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
  batch.set(songRef.collection('links').doc(video.videoId), {
    videoId: video.videoId,
    kind,
    status: decision.status,
    linkedBy: decision.status === 'active' && decision.byAi ? 'ai' : 'rule',
    ytTitle: video.title,
    channelId: video.channelId,
    embeddable: video.embeddable,
    madeForKids: video.madeForKids,
    durationSec: video.durationSec,
    verifiedAt: now,
  });
  await batch.commit();
  return decision.status;
}

/**
 * 곡 연결 규칙 + AI 판정. AI 판정이 실패하면(AI 한도 초과·AI 장애 등) 작업을 멈추지 않는다:
 * 기록하고, 이번 실행에서는 AI를 더 부르지 않으며(judgeState.judge를 끔) 이 연결은 pending_ai로 남긴다(D-030).
 */
export async function decideWithJudge(
  song: SongRef,
  candidates: VideoCandidate[],
  include: Include,
  judgeState: { judge: Judge | undefined },
  events: EventSink,
): Promise<Decision> {
  if (!judgeState.judge) return decideLink(song, candidates, include);
  try {
    return await decideLink(song, candidates, include, judgeState.judge);
  } catch (err) {
    // AI 쪽 오류만(한도·긴급 정지·AI 호출 실패·응답 없음). 그 밖의 오류는 프로그램 오류라 그대로 던진다.
    if (
      !(err instanceof BudgetExceededError) &&
      !(err instanceof KillSwitchError) &&
      !(err instanceof LlmCallError) &&
      !(err instanceof JudgeNoOutputError)
    )
      throw err;
    judgeState.judge = undefined;
    await events.record({
      type: 'error',
      attrs: { code: errName(err), where: 'ingest.judge' },
      outcome: 'error',
    });
    return decideLink(song, candidates, include);
  }
}

/** MusicBrainz 후보 중 그 아티스트의, 제목이 맞는 녹음. 구분 설명(라이브 등)이 없는 것, 그다음 이른 연도를 고른다. */
export function pickRecording(
  candidates: RecordingCandidate[],
  artist: Pick<ArtistDoc, 'mbid'>,
  titles: string[],
): RecordingCandidate | null {
  const keys = new Set(titles.map(compareKey));
  const ok = candidates.filter(
    (c) => c.artistMbid === artist.mbid && keys.has(compareKey(c.title)),
  );
  ok.sort(
    (a, b) =>
      Number(a.disambiguation !== null) - Number(b.disambiguation !== null) ||
      (a.firstReleaseYear ?? 9999) - (b.firstReleaseYear ?? 9999) ||
      b.score - a.score,
  );
  return ok[0] ?? null;
}

/** 대기열(사용자가 찾은 아티스트)을 수집 대상으로 옮긴다. 이미 있으면 건너뛴다. */
async function promoteQueue(db: Firestore, max: number) {
  const queued = await db.collection('ingestQueue').orderBy('queuedAt').limit(max).get();
  for (const q of queued.docs) {
    const { mbid, name } = q.data() as { mbid: string; name: string };
    const ref = db.doc(`artists/${mbid}`);
    await db.runTransaction(async (tx) => {
      const existing = await tx.get(ref);
      if (!existing.exists) {
        const doc: ArtistDoc = {
          name,
          mbid,
          status: 'active',
          channelId: null,
          uploadsPlaylistId: null,
          lastSeenPublishedAt: null,
          lastScannedAt: null,
          failCount: 0,
          ytVerifiedAt: null,
        };
        tx.set(ref, { ...doc, addedBy: 'queue' });
      }
      tx.delete(q.ref);
    });
  }
}
