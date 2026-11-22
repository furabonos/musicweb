import { Timestamp, type Firestore, type Query } from 'firebase-admin/firestore';
import { purgeExpiredCache, type LastfmCacheStore } from '../adapters/lastfm.js';
import type { EventSink } from '../core/events.js';
import { addOpsLog } from '../core/opsLog.js';
import { errName } from '../core/jobErrors.js';
import { ARTIST_YT_FIELDS, daysBefore, DELETE_AFTER_DAYS } from '../core/retention.js';

/**
 * 30일 정리 (SPEC 3.1, 4.4, T11, D-028). 재확인(refresh)이 실패하거나 멈춰도 YouTube 데이터가 30일을 넘지 않게 하는 안전장치.
 *
 * - 연결: 마지막 확인이 30일을 넘은 연결은 상태와 관계없이 문서째 지운다(영상 ID가 문서 ID라서).
 * - 아티스트: 채널 정보 확인 시각이 30일을 넘었으면 채널·업로드 목록·기준 시각을 지운다.
 * - 내보낸 재생목록 기록(ytExports): 만든 지 30일이 지나면 지운다. 사용자 토큰 없이는 재확인할 수 없기 때문이다.
 *   지운 뒤에는 그 재생목록에 곡을 더 넣을 수 없다(addItems가 찾지 못함). YouTube의 재생목록 자체는 사용자 것이라 그대로 있다.
 * - Last.fm 캐시: HTTP 캐시 기간이 지난 것을 지운다(D-024).
 * - 외부 호출이 없고 지우기만 하므로 긴급 정지와 관계없이 돈다.
 */

const BATCH = 400;

export interface PurgeDeps {
  db: Firestore;
  events: EventSink;
  /** 운영은 firestoreLastfmCache(db). 빠뜨리면 캐시 정리가 조용히 빠지므로 필수다. */
  lastfmCache: LastfmCacheStore;
  now?: () => Date;
}

export interface PurgeSummary {
  links: number;
  artists: number;
  ytExports: number;
  lastfmCache: number;
}

export async function runPurge(deps: PurgeDeps): Promise<PurgeSummary> {
  const { db } = deps;
  const now = (deps.now ?? (() => new Date()))();
  const cutoff = Timestamp.fromDate(daysBefore(now, DELETE_AFTER_DAYS));
  await deps.events.record({ type: 'job_started', attrs: { job: 'purge' }, outcome: 'ok' });

  // 한 단계가 실패해도 나머지 단계는 지운다(정리가 안전장치이므로). 실패는 기록하고 끝에 던진다.
  const failures: unknown[] = [];
  const step = async (where: string, fn: () => Promise<number>) => {
    try {
      return await fn();
    } catch (err) {
      failures.push(err);
      await deps.events.record({
        type: 'error',
        attrs: { code: errName(err), where: `purge.${where}` },
        outcome: 'error',
      });
      return 0;
    }
  };

  const links = await step('links', () =>
    drain(
      db.collectionGroup('links').where('verifiedAt', '<=', cutoff).orderBy('verifiedAt'),
      (b, d) => b.delete(d.ref),
    ),
  );
  const artists = await step('artists', () =>
    drain(
      db.collection('artists').where('ytVerifiedAt', '<=', cutoff).orderBy('ytVerifiedAt'),
      (b, d) =>
        b.update(d.ref, {
          ...Object.fromEntries(ARTIST_YT_FIELDS.map((f) => [f, null])),
          ytVerifiedAt: null,
        }),
    ),
  );
  const ytExports = await step('yt_exports', () =>
    drain(
      db.collection('ytExports').where('createdAt', '<=', cutoff).orderBy('createdAt'),
      (b, d) => b.delete(d.ref),
    ),
  );
  const lastfmCache = await step('lastfm_cache', () =>
    purgeExpiredCache(deps.lastfmCache, now.getTime()),
  );

  const summary = { links, artists, ytExports, lastfmCache };
  await deps.events.record({
    type: 'job_finished',
    attrs: {
      job: 'purge',
      processed: links + artists + ytExports + lastfmCache,
      failed: failures.length,
    },
    outcome: failures.length ? 'error' : 'ok',
  });
  await addOpsLog(db, {
    kind: failures.length ? 'job_failed' : 'job',
    message: `Purge finished: removed ${links} links, ${artists} artist channels, ${ytExports} export records, ${lastfmCache} Last.fm cache entries${failures.length ? ` (${failures.length} steps failed)` : ''}.`,
  });
  if (failures.length) throw failures[0];
  return summary;
}

/**
 * 조건에 맞는 문서가 없을 때까지 BATCH개씩 처리한다. 처리한 문서는 조건에서 빠지므로(삭제·null) 같은 조회를 반복한다.
 * 처리가 먹히지 않아 같은 문서가 다시 나오면 끝없이 돌지 않게 멈추고 오류를 던진다.
 */
async function drain(
  query: Query,
  apply: (b: FirebaseFirestore.WriteBatch, d: FirebaseFirestore.QueryDocumentSnapshot) => void,
): Promise<number> {
  let total = 0;
  const seen = new Set<string>();
  for (;;) {
    const snap = await query.limit(BATCH).get();
    if (snap.empty) return total;
    const batch = query.firestore.batch();
    for (const d of snap.docs) {
      if (seen.has(d.ref.path)) throw new Error(`정리가 진행되지 않습니다: ${d.ref.parent.id}`);
      seen.add(d.ref.path);
      apply(batch, d);
    }
    await batch.commit();
    total += snap.size;
  }
}
