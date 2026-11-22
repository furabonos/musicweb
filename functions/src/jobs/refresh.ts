import { FieldValue, Timestamp, type Firestore } from 'firebase-admin/firestore';
import type { YouTubeRead } from '../adapters/youtube-read.js';
import { BudgetExceededError } from '../core/budget.js';
import type { EventSink } from '../core/events.js';
import { addOpsLog } from '../core/opsLog.js';
import {
  ARTIST_YT_FIELDS,
  daysBefore,
  LINK_YT_FIELDS,
  REFRESH_AFTER_DAYS,
} from '../core/retention.js';
import { assertEnabled, KillSwitchError, type ServiceCounter } from '../core/runtimeConfig.js';
import { errName, isOutage } from '../core/jobErrors.js';

/**
 * 25일 재확인 (SPEC 3.1, 4.4, T11, D-028).
 *
 * - 연결: 마지막 확인이 25일을 넘은 연결(gone 제외)을 videos.list로 50개씩(1단위) 다시 본다.
 *   - 응답에 있고 공개·퍼가기 가능: 제목·채널·아동용·길이를 갱신하고 확인 시각을 지금으로.
 *   - 응답에 없음(삭제)·비공개·퍼가기 불가: `gone`으로 바꾸고 YouTube 필드를 지운다. 확인 시각은 그대로 둬서
 *     남은 영상 ID(문서 ID)는 30일 정리(purge)가 지운다.
 * - 아티스트: 채널 정보(D-027)의 확인 시각(ytVerifiedAt)이 25일을 넘었으면 channels.list(1단위)로 다시 본다.
 *   채널이 있으면 확인 시각을 갱신하고, 확인되지 않는 기준 시각(lastSeenPublishedAt)은 지운다.
 *   채널이 없어졌으면 채널·업로드 목록·기준 시각을 지운다(다음 수집이 다시 찾는다).
 * - 관리자가 막은(blocked)·거절된(rejected)·AI 대기(pending_ai) 연결도 영상이 없어지면 gone이 된다(30일 규칙상
 *   영상 ID를 무기한 둘 수 없으므로, 30일이 지나면 막은 기록도 정리된다 — D-028).
 * - 긴급 정지 `ingest`와 YouTube 한도를 따른다. 한도·장애·긴급 정지면 그 자리에서 멈춘다.
 *   멈춰서 확인하지 못한 연결은 추천에서 빠지고(catalog.ts), 30일이 되면 정리된다.
 */

export const DEFAULT_REFRESH_LIMITS = {
  /** 한 번에 재확인할 연결 수 (50개당 1단위) */
  maxLinks: 5000,
  /** 한 번에 재확인할 아티스트 수 (1명당 1단위) */
  maxArtists: 500,
};
const CHUNK = 50;
/** gone이 아닌 상태 (gone은 이미 YouTube 필드를 지웠으므로 정리만 기다린다) */
const REFRESHABLE = ['active', 'pending_ai', 'blocked', 'rejected'] as const;

export interface RefreshDeps {
  db: Firestore;
  yt: YouTubeRead;
  events: EventSink;
  now?: () => Date;
  limits?: Partial<typeof DEFAULT_REFRESH_LIMITS>;
  deadlineMs?: number;
  clock?: () => number;
}

export interface RefreshSummary {
  stoppedBy: 'limit' | 'killSwitch' | 'outage' | 'deadline' | null;
  linksChecked: number;
  linksUpdated: number;
  linksGone: number;
  artistsChecked: number;
  artistsCleared: number;
}

export async function runRefresh(deps: RefreshDeps): Promise<RefreshSummary> {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());
  const limits = { ...DEFAULT_REFRESH_LIMITS, ...deps.limits };
  const clock = deps.clock ?? Date.now;
  const pastDeadline = () => deps.deadlineMs !== undefined && clock() >= deps.deadlineMs;
  const summary: RefreshSummary = {
    stoppedBy: null,
    linksChecked: 0,
    linksUpdated: 0,
    linksGone: 0,
    artistsChecked: 0,
    artistsCleared: 0,
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
  await deps.events.record({ type: 'job_started', attrs: { job: 'refresh' }, outcome: 'ok' });

  try {
    await refreshLinks(deps, now, limits.maxLinks, pastDeadline, summary);
    if (!summary.stoppedBy) {
      await refreshArtists(deps, now, limits.maxArtists, pastDeadline, summary);
    }
  } catch (err) {
    summary.stoppedBy = await stopReason(deps, err);
  }

  await deps.events.record({
    type: 'job_finished',
    attrs: { job: 'refresh', processed: summary.linksChecked, failed: 0 },
    outcome: summary.stoppedBy ? 'rejected' : 'ok',
  });
  await addOpsLog(db, {
    kind: 'job',
    message: `Refresh finished: ${summary.linksChecked} links checked, ${summary.linksGone} gone, ${summary.artistsChecked} channels checked${summary.stoppedBy ? ` (stopped: ${summary.stoppedBy})` : ''}.`,
  });
  return summary;
}

async function refreshLinks(
  deps: RefreshDeps,
  now: () => Date,
  max: number,
  pastDeadline: () => boolean,
  summary: RefreshSummary,
) {
  const { db } = deps;
  const cutoff = Timestamp.fromDate(daysBefore(now(), REFRESH_AFTER_DAYS));
  const snap = await db
    .collectionGroup('links')
    .where('status', 'in', [...REFRESHABLE])
    .where('verifiedAt', '<=', cutoff)
    .orderBy('verifiedAt')
    .limit(max)
    .get();

  for (let i = 0; i < snap.docs.length; i += CHUNK) {
    if (pastDeadline()) {
      summary.stoppedBy = 'deadline';
      return;
    }
    const part = snap.docs.slice(i, i + CHUNK);
    const details = new Map(
      (await deps.yt.videos(part.map((d) => d.get('videoId') as string))).map((v) => [
        v.videoId,
        v,
      ]),
    );
    const at = now();
    const batch = db.batch();
    for (const doc of part) {
      const v = details.get(doc.get('videoId') as string);
      if (v && v.privacyStatus === 'public' && v.embeddable) {
        batch.update(doc.ref, {
          ytTitle: v.title,
          channelId: v.channelId,
          embeddable: v.embeddable,
          madeForKids: v.madeForKids,
          durationSec: v.durationSec,
          verifiedAt: at,
        });
        summary.linksUpdated++;
      } else {
        const clear = Object.fromEntries(LINK_YT_FIELDS.map((f) => [f, FieldValue.delete()]));
        batch.update(doc.ref, { ...clear, status: 'gone' });
        summary.linksGone++;
      }
    }
    await batch.commit();
    summary.linksChecked += part.length;
  }
}

async function refreshArtists(
  deps: RefreshDeps,
  now: () => Date,
  max: number,
  pastDeadline: () => boolean,
  summary: RefreshSummary,
) {
  const { db } = deps;
  const cutoff = Timestamp.fromDate(daysBefore(now(), REFRESH_AFTER_DAYS));
  const snap = await db
    .collection('artists')
    .where('ytVerifiedAt', '<=', cutoff)
    .orderBy('ytVerifiedAt')
    .limit(max)
    .get();
  for (const doc of snap.docs) {
    if (pastDeadline()) {
      summary.stoppedBy = 'deadline';
      return;
    }
    const channelId = doc.get('channelId') as string | null;
    const uploads = channelId ? await deps.yt.uploadsPlaylist(channelId) : null;
    summary.artistsChecked++;
    if (uploads) {
      // 채널·업로드 목록은 방금 확인했다. 기준 시각(lastSeenPublishedAt)은 업로드 목록에서 온 값인데 channels.list로는
      // 확인되지 않으므로 지운다. 다음 수집이 최근 업로드를 다시 보고(이미 연결된 영상은 건너뜀) 새로 정한다.
      await doc.ref.update({
        uploadsPlaylistId: uploads,
        lastSeenPublishedAt: null,
        ytVerifiedAt: now(),
      });
    } else {
      await doc.ref.update({
        ...Object.fromEntries(ARTIST_YT_FIELDS.map((f) => [f, null])),
        ytVerifiedAt: null,
      });
      summary.artistsCleared++;
    }
  }
}

/** 한도·긴급 정지·장애면 기록하고 멈춘다. 그 밖의 오류는 기록한 뒤 그대로 던진다(예약 함수 오류로 보이게). */
async function stopReason(deps: RefreshDeps, err: unknown): Promise<RefreshSummary['stoppedBy']> {
  const { db } = deps;
  if (err instanceof BudgetExceededError) {
    await deps.events.record({
      type: 'limit_reached',
      attrs: { scope: err.scope, counter: err.counter as ServiceCounter },
      outcome: 'rejected',
    });
    await addOpsLog(db, {
      kind: 'limit',
      message: `Refresh stopped: daily limit reached (${err.counter}). Unchecked links are excluded from recommendations.`,
    });
    return 'limit';
  }
  if (err instanceof KillSwitchError) {
    await deps.events.record({
      type: 'kill_switch_blocked',
      attrs: { feature: 'ingest' },
      outcome: 'rejected',
    });
    await addOpsLog(db, {
      kind: 'job',
      message: 'Refresh stopped: the ingest kill switch was turned off during the run.',
    });
    return 'killSwitch';
  }
  if (isOutage(err)) {
    await deps.events.record({
      type: 'error',
      attrs: { code: errName(err), where: 'refresh.youtube' },
      outcome: 'error',
    });
    await addOpsLog(db, {
      kind: 'job_failed',
      message:
        'Refresh stopped: YouTube is unavailable or out of quota. Unchecked links are excluded from recommendations.',
    });
    return 'outage';
  }
  await deps.events.record({
    type: 'error',
    attrs: { code: errName(err), where: 'refresh' },
    outcome: 'error',
  });
  await addOpsLog(db, { kind: 'job_failed', message: 'Refresh failed with an unexpected error.' });
  throw err;
}
