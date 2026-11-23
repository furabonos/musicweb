import { FieldValue, Timestamp, type Firestore } from 'firebase-admin/firestore';
import { pacificDay } from './day.js';

/**
 * 요청 때 계산 (SPEC 4.3 "범위", T29, D-046).
 * - 계산이 없는 아티스트는 처음 요청될 때 계산한다. 같은 아티스트를 동시에 여러 요청이 원하면 한 번만 계산하고
 *   모두 같은 결과를 기다린다(인스턴스 안). 이 계산을 하는 함수는 최대 인스턴스 1개로 둬서
 *   음악 데이터 초당 1회 줄이 한 곳에서 지켜지게 한다(D-024). 추천 경로 연결은 T30.
 */
export function createOnDemand<T>(compute: (artistMbid: string) => Promise<T>) {
  const inflight = new Map<string, Promise<T>>();
  return {
    ensure(artistMbid: string): Promise<T> {
      const running = inflight.get(artistMbid);
      if (running) return running;
      const p = compute(artistMbid).finally(() => inflight.delete(artistMbid));
      inflight.set(artistMbid, p);
      return p;
    },
    /** 지금 계산 중인 아티스트 수 (테스트·기록용) */
    get running() {
      return inflight.size;
    },
  };
}

/** 마지막 조회 시각을 오늘(태평양) 이미 썼으면 다시 쓰지 않는다(쓰기 비용 절약) */
export function needsTouch(last: Date | null, now: Date): boolean {
  return !last || pacificDay(last) !== pacificDay(now);
}

/**
 * 곡·아티스트의 lastRequestedAt을 하루 한 번만 쓴다. 밤 미리 계산(T29)이 최근 조회 순으로 대상을 고른다.
 * artistVectors 문서가 없으면 lastRequestedAt만 있는 문서가 생기고, 밤 작업이 그 아티스트를 계산한다.
 */
export async function touchRequested(
  db: Firestore,
  ids: { songIds: string[]; artistMbids: string[] },
  now: Date = new Date(),
): Promise<number> {
  const refs = [
    ...[...new Set(ids.songIds)].map((id) => db.doc(`songs/${id}`)),
    ...[...new Set(ids.artistMbids)].map((id) => db.doc(`artistVectors/${id}`)),
  ];
  if (!refs.length) return 0;
  const snaps = await db.getAll(...refs);
  const batch = db.batch();
  let n = 0;
  for (const s of snaps) {
    const last = s.get('lastRequestedAt') as unknown;
    if (!needsTouch(last instanceof Timestamp ? last.toDate() : null, now)) continue;
    // 곡 문서는 있는 것만(없는 곡을 만들지 않는다), 아티스트 문서는 없으면 만든다
    if (!s.exists && s.ref.parent.id === 'songs') continue;
    batch.set(
      s.ref,
      {
        lastRequestedAt: FieldValue.serverTimestamp(),
        // 새 아티스트 문서는 computedAt null: 밤 작업의 "오래 계산 안 된 순"(오름차순)에서 맨 앞
        ...(!s.exists ? { computedAt: null } : {}),
      },
      { merge: true },
    );
    n++;
  }
  if (n) await batch.commit();
  return n;
}
