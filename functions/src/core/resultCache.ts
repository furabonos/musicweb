import { createHash } from 'node:crypto';
import { FieldValue, Timestamp, type Firestore } from 'firebase-admin/firestore';
import { recommendableLinks, songKey } from './catalog.js';
import type { EventSink } from './events.js';
import { errName } from './jobErrors.js';
import type { ParsedRequest } from './parseRequest.js';
import type { RecommendItem, RecommendResult } from './recommend.js';

/**
 * 저장된 결과 (SPEC 4.3 2단계, T32, D-048).
 * - 키: (기준 곡 이름 비교 키, 곡 수, 조건, 화면 언어, 추천 방식)의 해시.
 * - 저장: 기준 곡과 곡 ID·이름·연도·이유만. 영상 ID 등 YouTube 데이터는 저장하지 않는다(D-031).
 *   쓸 때마다 지금 재생할 수 있는 연결을 곡 목록에서 고른다.
 * - 7일. 보이는 곡(요청 곡 수) 중 하나라도 지금 재생할 수 없으면 저장된 결과를 쓰지 않고 다시 계산한다.
 * - resultCache는 서버 전용(보안 규칙에 match 없음).
 */
export const RESULT_CACHE_DAYS = 7;
const DAY = 24 * 60 * 60 * 1000;

export function resultCacheKey(req: ParsedRequest, mode: string): string | null {
  if (!req.seed) return null;
  const inc = `${+req.include.live}${+req.include.cover}${+req.include.remix}`;
  return createHash('sha256')
    .update(
      `result:${songKey(req.seed.artist, req.seed.title)}|${req.count}|${inc}|${req.locale}|${mode}`,
    )
    .digest('base64url');
}

type Ok = Extract<RecommendResult, { ok: true }>;
interface Stored {
  seed: Ok['seed'];
  items: Pick<RecommendItem, 'songId' | 'artist' | 'title' | 'releaseYear' | 'reason'>[];
  shortfall: Ok['shortfall'];
}

/** 추천 함수에 저장된 결과를 씌운다. 저장된 결과를 쓰면 fromCache: true */
export function withResultCache(
  deps: {
    db: Firestore;
    mode: string;
    /** 이 방식의 저장된 결과도 먼저 읽는다(쓰기는 mode에만). 절약 모드에서 저장된 AI 결과를 쓰려고 (D-052) */
    alsoRead?: string | undefined;
    now?: () => Date;
    events?: EventSink;
  },
  recommend: (req: ParsedRequest, spares: number) => Promise<RecommendResult>,
): (req: ParsedRequest, spares: number) => Promise<RecommendResult> {
  const now = deps.now ?? (() => new Date());
  return async (req, spares) => {
    const key = resultCacheKey(req, deps.mode);
    if (!key) return recommend(req, spares);
    const ref = deps.db.doc(`resultCache/${key}`);
    const extra = deps.alsoRead ? resultCacheKey(req, deps.alsoRead) : null;
    for (const k of extra ? [extra, key] : [key]) {
      const snap = await deps.db.doc(`resultCache/${k}`).get();
      const exp = snap.get('expiresAt') as unknown;
      if (snap.exists && exp instanceof Timestamp && exp.toMillis() > now().getTime()) {
        const s = snap.data() as Stored;
        const links = await recommendableLinks(
          deps.db,
          s.items.map((i) => i.songId),
          now(),
          req.include,
        );
        const visible = s.items.slice(0, req.count);
        if (visible.length === req.count && visible.every((i) => links.has(i.songId))) {
          const items: RecommendItem[] = s.items.flatMap((i) => {
            const l = links.get(i.songId);
            return l
              ? [{ ...i, videoId: l.videoId, kind: l.kind, madeForKids: l.madeForKids }]
              : [];
          });
          return { ok: true, seed: s.seed, items, shortfall: s.shortfall, fromCache: true };
        }
      }
    }
    const rec = await recommend(req, spares);
    // 저장하지 않는 결과: 곡이 모자람(잠깐의 원인이 7일 고정되지 않게), AI 방식인데 AI 없이 고름(AI가 돌아오면 다시 고르게)
    const keep =
      rec.ok &&
      rec.items.length > 0 &&
      !rec.shortfall &&
      !(deps.mode === 'ai' && rec.pickedBy !== 'ai');
    if (keep && rec.ok) {
      const stored: Stored = {
        seed: rec.seed,
        items: rec.items.map((i) => ({
          songId: i.songId,
          artist: i.artist,
          title: i.title,
          releaseYear: i.releaseYear,
          reason: i.reason,
        })),
        shortfall: rec.shortfall,
      };
      try {
        await ref.set({
          ...stored,
          at: FieldValue.serverTimestamp(),
          expiresAt: Timestamp.fromMillis(now().getTime() + RESULT_CACHE_DAYS * DAY),
        });
      } catch (err) {
        // 이미 추천을 계산했으니 저장 실패로 만들기를 막지 않는다. 기록은 남긴다
        await deps.events?.record({
          type: 'error',
          attrs: { code: errName(err), where: 'resultCache.set' },
          outcome: 'error',
        });
      }
    }
    return rec;
  };
}
