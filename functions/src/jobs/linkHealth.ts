import { Timestamp, type Firestore } from 'firebase-admin/firestore';
import type { OpenLinkCheck } from '../adapters/youtube-openlink.js';
import type { EventSink } from '../core/events.js';
import { errName } from '../core/jobErrors.js';
import { addOpsLog, type OpsLogInput } from '../core/opsLog.js';
import { daysBefore, REFRESH_AFTER_DAYS } from '../core/retention.js';
import { parseRuntimeConfig, RUNTIME_DOC, type OpenLinkMode } from '../core/runtimeConfig.js';

/**
 * "YouTube에서 열기" 링크 매일 확인 (SPEC 4.6, D-006, T16).
 * - 곡 목록에서 지금 쓰는 영상 2개로 watch_videos 링크를 열어 본다(헤더만).
 * - 303 + Location에 list=TL이면 정상 → direct. 그 밖이면 fallback(화면이 곡별 링크 목록을 보여 줌)으로 바꾸고 기록한다.
 * - 확인 자체가 실패하면(연결 끊김·한도) 방식을 바꾸지 않는다(모르는 상태로 바꾸지 않음).
 * - 자동 이슈는 T19가 이 기록(error: open_link_broken)을 보고 만든다.
 */
export interface LinkHealthPorts {
  sampleVideoIds(): Promise<string[]>;
  check(ids: string[]): Promise<OpenLinkCheck>;
  /** 바뀌었으면 이전 값을 돌려준다 */
  setMode(mode: OpenLinkMode): Promise<OpenLinkMode>;
  opsLog(input: OpsLogInput): Promise<void>;
  events: EventSink;
}

export type LinkHealthResult = 'ok' | 'broken' | 'skipped' | 'check_failed';

export async function runLinkHealth(p: LinkHealthPorts): Promise<LinkHealthResult> {
  await p.events.record({ type: 'job_started', attrs: { job: 'linkHealth' }, outcome: 'ok' });
  const finish = async (processed: number, failed: number) =>
    p.events.record({
      type: 'job_finished',
      attrs: { job: 'linkHealth', processed, failed },
      outcome: failed ? 'error' : 'ok',
    });

  const ids = await p.sampleVideoIds();
  if (ids.length === 0) {
    await p.opsLog({
      kind: 'job',
      message: 'Open-in-YouTube link check skipped: no linked videos yet.',
    });
    await finish(0, 0);
    return 'skipped';
  }

  let res: OpenLinkCheck;
  try {
    res = await p.check(ids);
  } catch (err) {
    await p.events.record({
      type: 'error',
      attrs: { code: errName(err), where: 'linkHealth.check' },
      outcome: 'error',
    });
    await p.opsLog({
      kind: 'job_failed',
      message: 'Open-in-YouTube link check could not run; mode unchanged.',
    });
    await finish(0, 1);
    return 'check_failed';
  }

  const ok = res.status === 303 && res.listOk;
  try {
    const before = await p.setMode(ok ? 'direct' : 'fallback');
    if (!ok) {
      await p.events.record({
        type: 'error',
        attrs: { code: 'open_link_broken', where: 'linkHealth' },
        outcome: 'error',
      });
      await p.opsLog({
        kind: 'issue',
        message: `Open-in-YouTube link check failed (status ${res.status}); showing per-song links instead.`,
      });
    } else if (before === 'fallback') {
      await p.opsLog({
        kind: 'job',
        message: 'Open-in-YouTube link works again; switched back from per-song links.',
      });
    } else {
      await p.opsLog({ kind: 'job', message: 'Open-in-YouTube link check passed.' });
    }
  } catch (err) {
    // 설정 문서가 깨졌거나 저장 실패: 결과를 반영하지 못했음을 남기고 끝낸다
    await p.events.record({
      type: 'error',
      attrs: { code: errName(err), where: 'linkHealth.set_mode' },
      outcome: 'error',
    });
    await p
      .opsLog({
        kind: 'job_failed',
        message: 'Open-in-YouTube link check ran but the result could not be saved.',
      })
      .catch(() => {});
    await finish(1, 1);
    return 'check_failed';
  }
  await finish(1, ok ? 0 : 1);
  return ok ? 'ok' : 'broken';
}

/** 운영용 포트: Firestore 곡 목록과 config/runtime */
export function firestoreLinkHealthPorts(
  db: Firestore,
  deps: { check(ids: string[]): Promise<OpenLinkCheck>; events: EventSink; now?: () => Date },
): LinkHealthPorts {
  const now = deps.now ?? (() => new Date());
  return {
    async sampleVideoIds() {
      const snap = await db
        .collectionGroup('links')
        .where('status', '==', 'active')
        .where('verifiedAt', '>', Timestamp.fromDate(daysBefore(now(), REFRESH_AFTER_DAYS)))
        // 가장 최근에 확인한 영상: 그사이 내려간 영상 때문에 멀쩡한 링크를 깨졌다고 보지 않게
        .orderBy('verifiedAt', 'desc')
        .limit(2)
        .get();
      return snap.docs.map((d) => d.get('videoId') as string).filter((v) => typeof v === 'string');
    },
    check: deps.check,
    setMode: (mode) =>
      db.runTransaction(async (tx) => {
        const ref = db.doc(RUNTIME_DOC);
        const snap = await tx.get(ref);
        // 설정이 깨져 있으면 여기서 던진다(막는 쪽으로 실패, 관리자가 고침)
        const before = parseRuntimeConfig(snap.exists ? snap.data() : undefined).youtubeOpenLink;
        if (before !== mode) tx.set(ref, { youtubeOpenLink: mode }, { merge: true });
        return before;
      }),
    opsLog: (input) => addOpsLog(db, input),
    events: deps.events,
  };
}
