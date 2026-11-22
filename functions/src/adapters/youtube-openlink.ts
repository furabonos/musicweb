import type { Firestore } from 'firebase-admin/firestore';
import { watchVideosLinks } from '@musicweb/shared';
import { consume } from '../core/budget.js';
import { recordCall, type EventSink } from '../core/events.js';

/**
 * "YouTube에서 열기" 링크 동작 확인 (D-006, T16). 웹 페이지 긁기 금지의 유일한 예외다.
 * - watch_videos 링크에 GET 한 번, 자동으로 따라가지 않는다(redirect: manual).
 * - **응답 헤더만 본다**(상태 코드, Location에 list=TL이 있는지). 본문은 읽지 않고 바로 닫는다.
 * - 호출 전에 하루 상한(usage.linkChecks)을 쓴다. 10초 안에 답이 없으면 끊는다(작업이 결과를 남기고 끝나게).
 */
export interface OpenLinkCheck {
  status: number;
  /** Location에 임시 재생목록(list=TL…)이 붙었는가 */
  listOk: boolean;
}

export interface OpenLinkBudget {
  spend(): Promise<void>;
}

export function firestoreOpenLinkBudget(db: Firestore): OpenLinkBudget {
  return { spend: () => consume(db, { service: { linkChecks: 1 } }) };
}

export const OPEN_LINK_TIMEOUT_MS = 10_000;

export function createOpenLinkChecker(deps: {
  events: EventSink;
  budget: OpenLinkBudget;
  fetch?: typeof fetch;
  timeoutMs?: number;
}) {
  const f = deps.fetch ?? fetch;
  return {
    async check(videoIds: string[]): Promise<OpenLinkCheck> {
      const [url] = watchVideosLinks(videoIds.slice(0, 2));
      if (!url) throw new Error('확인할 링크가 없습니다.');
      await deps.budget.spend();
      return recordCall(
        deps.events,
        { target: 'youtube_link', op: 'watch_videos.check' },
        async () => {
          const res = await f(url, {
            method: 'GET',
            redirect: 'manual',
            signal: AbortSignal.timeout(deps.timeoutMs ?? OPEN_LINK_TIMEOUT_MS),
          });
          // 본문은 읽지 않는다
          await res.body?.cancel();
          const location = res.headers.get('location') ?? '';
          return {
            result: { status: res.status, listOk: /[?&]list=TL/.test(location) },
            status: res.status,
          };
        },
      );
    },
  };
}
