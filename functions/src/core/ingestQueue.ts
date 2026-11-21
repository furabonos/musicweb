import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { pacificDay } from './day.js';

/**
 * 사용자가 찾은 아티스트 대기열 (SPEC 3.3, T10). 요청 처리(T13)에서 기준 곡 아티스트가 곡 목록에 없으면 넣는다.
 * - 하루(태평양 시간) 최대 50명. 이미 수집 대상이거나 대기 중이면 넣지 않는다.
 * - 대기열에는 누가 찾았는지 남기지 않는다(MusicBrainz 아티스트 ID와 이름만).
 */
export const MAX_QUEUE_PER_DAY = 50;
const MBID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type EnqueueResult = 'queued' | 'already_tracked' | 'already_queued' | 'daily_limit';

export async function enqueueArtist(
  db: Firestore,
  artist: { mbid: string; name: string },
  now = new Date(),
): Promise<EnqueueResult> {
  if (!MBID.test(artist.mbid)) throw new Error('아티스트 MBID 형식이 잘못됐습니다.');
  const name = artist.name.trim().slice(0, 200);
  if (!name) throw new Error('아티스트 이름이 비었습니다.');
  const day = pacificDay(now);
  const dayRef = db.doc(`ingestQueueDays/${day}`);
  const queueRef = db.doc(`ingestQueue/${artist.mbid}`);
  const artistRef = db.doc(`artists/${artist.mbid}`);
  return db.runTransaction(async (tx) => {
    const [daySnap, queued, tracked] = await Promise.all([
      tx.get(dayRef),
      tx.get(queueRef),
      tx.get(artistRef),
    ]);
    if (tracked.exists) return 'already_tracked';
    if (queued.exists) return 'already_queued';
    const count = Number(daySnap.get('count') ?? 0);
    if (!Number.isFinite(count) || count >= MAX_QUEUE_PER_DAY) return 'daily_limit';
    tx.set(queueRef, { mbid: artist.mbid, name, queuedAt: FieldValue.serverTimestamp() });
    tx.set(dayRef, { count: FieldValue.increment(1) }, { merge: true });
    return 'queued';
  });
}
