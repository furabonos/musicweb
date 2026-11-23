import { createHmac } from 'node:crypto';
import { FieldValue, Timestamp, type Firestore } from 'firebase-admin/firestore';
import type { Locale, ParsedRequest } from './parseRequest.js';

/**
 * 저장된 해석 (SPEC 4.2 1단계, T32, D-048).
 * - 키: 정규화한 문장(공백·대소문자 정리)과 화면 언어의 HMAC. 열쇠는 ACTOR_HASH_KEY에 용도 접두어 "parse:"를
 *   붙여 쓴다(새 비밀값 없음). 서버 비밀 없이는 문장으로 키를 거꾸로 맞춰 볼 수 없다.
 * - 저장: 해석 결과(기준 곡 이름·곡 수·조건)만. 문장 원문은 저장하지 않는다. 30일.
 * - AI가 해석한 결과만 저장한다. 규칙 해석은 다시 해도 비용이 없다.
 * - parseCache는 서버 전용(보안 규칙에 match 없음).
 */
export const PARSE_CACHE_DAYS = 30;
const DAY = 24 * 60 * 60 * 1000;

export function normalizeRequest(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

export function parseCacheKey(text: string, locale: Locale, hashKey: string): string {
  if (Buffer.byteLength(hashKey, 'utf8') < 32) throw new Error('해시 키가 너무 짧습니다.');
  return createHmac('sha256', hashKey)
    .update(`parse:${locale}:${normalizeRequest(text)}`)
    .digest('base64url');
}

export interface ParseCache {
  get(text: string, locale: Locale): Promise<ParsedRequest | null>;
  set(text: string, locale: Locale, value: ParsedRequest): Promise<void>;
}

export function firestoreParseCache(
  db: Firestore,
  hashKey: string,
  now: () => Date = () => new Date(),
): ParseCache {
  const ref = (text: string, locale: Locale) =>
    db.doc(`parseCache/${parseCacheKey(text, locale, hashKey)}`);
  return {
    async get(text, locale) {
      const snap = await ref(text, locale).get();
      const exp = snap.get('expiresAt') as unknown;
      if (!snap.exists || !(exp instanceof Timestamp) || exp.toMillis() <= now().getTime()) {
        return null;
      }
      return { ...(snap.get('value') as Omit<ParsedRequest, 'locale'>), locale };
    },
    async set(text, locale, value) {
      // 해석 결과만(문장 원문 없음). locale은 키에 들어 있다
      await ref(text, locale).set({
        value: {
          seed: value.seed,
          count: value.count,
          include: value.include,
          unsupported: value.unsupported,
        },
        at: FieldValue.serverTimestamp(),
        expiresAt: Timestamp.fromMillis(now().getTime() + PARSE_CACHE_DAYS * DAY),
      });
    },
  };
}
