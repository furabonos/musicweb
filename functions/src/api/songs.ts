import { compareKey } from '@musicweb/shared';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { onCall } from './callable.js';
import { z } from 'zod';
import { handle } from './errors.js';

/**
 * 곡 고르기 제안 (`songs-suggest`, SPEC 4.2 "고르기 화면", T33, D-049). 로그인 없이 부른다(App Check는 T23).
 * - 입력 50자. 이름 비교 키 앞부분 일치: 아티스트로 시작(key = "아티스트|제목")하거나 제목으로 시작(titleKey).
 * - 최대 10개. 정보가 적은 곡(lowInfo·mbid 없음)은 제안하지 않는다.
 * - 곡 목록은 누구나 읽는 문서라 돌려주는 값도 공개 정보(곡 ID·아티스트·제목·연도)뿐이다. 입력은 저장·기록하지 않는다.
 */
export const SUGGEST_LIMIT = 10;

/** 고를 수 있는 곡: 정보가 적은 곡(lowInfo·mbid 없음)이 아니고 이름이 있다. 제안과 곡 ID 만들기가 같이 쓴다 */
export function isPickable(d: FirebaseFirestore.DocumentSnapshot): boolean {
  const artist = d.get('artist') as unknown;
  const title = d.get('title') as unknown;
  return (
    d.exists &&
    d.get('lowInfo') !== true &&
    !!d.get('mbid') &&
    typeof artist === 'string' &&
    typeof title === 'string' &&
    !!artist &&
    !!title
  );
}
const input = z.strictObject({ q: z.string().max(50) });

export interface Suggestion {
  songId: string;
  artist: string;
  title: string;
  releaseYear: number | null;
}

export async function suggestSongs(db: Firestore, q: string): Promise<Suggestion[]> {
  const p = compareKey(q);
  if (p.length < 2) return [];
  const range = (field: string) =>
    db
      .collection('songs')
      .where(field, '>=', p)
      .where(field, '<', `${p}`)
      .orderBy(field)
      .limit(SUGGEST_LIMIT * 2)
      .get();
  const [byArtist, byTitle] = await Promise.all([range('key'), range('titleKey')]);
  const out = new Map<string, Suggestion>();
  for (const d of [...byTitle.docs, ...byArtist.docs]) {
    if (out.size >= SUGGEST_LIMIT) break;
    // 걸러 낸 뒤라 정보가 적은 곡이 앞쪽에 몰리면 10개보다 적을 수 있다(받아들임, D-049)
    if (!isPickable(d)) continue;
    out.set(d.id, {
      songId: d.id,
      artist: String(d.get('artist') ?? ''),
      title: String(d.get('title') ?? ''),
      releaseYear: (d.get('releaseYear') as number | null | undefined) ?? null,
    });
  }
  return [...out.values()];
}

export const songs = {
  // 로그인 없이 부르므로 인스턴스·동시 처리 수를 묶는다(요청당 읽기 최대 40). App Check는 T23
  suggest: onCall({ maxInstances: 5, concurrency: 20 }, (req) =>
    handle(async () => {
      const parsed = input.safeParse(req.data);
      if (!parsed.success) {
        throw new HttpsError('invalid-argument', 'invalid input', { reason: 'input' });
      }
      return { items: await suggestSongs(getFirestore(), parsed.data.q) };
    }),
  ),
};
