import type { Llm } from '../adapters/llm.js';
import { BudgetExceededError } from './budget.js';
import type { EventSink } from './events.js';
import {
  COUNT_DEFAULT,
  COUNT_MAX,
  COUNT_MIN,
  MAX_REQUEST_CHARS,
  parseRequest,
  type Locale,
  type ParsedRequest,
  type ParseFailReason,
  type ParseResult,
} from './parseRequest.js';
import { errName } from './jobErrors.js';
import type { ParseCache } from './parseCache.js';
import { KillSwitchError } from './runtimeConfig.js';

/**
 * 규칙 해석 (SPEC 4.2 2단계, T22b, D-039·D-040). AI 없이 검색창 문장에서 읽는다:
 * - 기준 곡: `<곡> by <아티스트>`(마지막 by로 나눔), `<아티스트> - <곡>`(대시 종류 무관)
 * - 곡 수: `15 songs`, `15 tracks`, `15곡` (5~30으로 맞춤, 없으면 10)
 * - 조건 낱말: live/cover/remix, 라이브/커버/리믹스
 * 기준 곡을 못 읽으면 null(AI 해석 또는 다시 묻기). 분위기 같은 자유 조건은 읽지 않는다.
 */
const MAX_NAME = 100;

const INC = String.raw`(?:live|covers?|remix(?:es)?)`;
const INC_KO = '(?:라이브|커버|리믹스)';

/**
 * 문장 앞뒤에 붙은 군더더기만 지운다(이름 안쪽은 건드리지 않는다: "Smells Like Teen Spirit", "Live Forever", "Little Mix").
 * 지운 조각에서만 곡 수·조건 낱말을 읽는다.
 */
const PREFIX: RegExp[] = [
  /^\d{1,4}\s*(?:songs?|tracks?)\s+(?:like|similar\s+to)\s+/i,
  /^\d{1,4}\s*(?:songs?|tracks?)\s+/i,
  /^(?:songs?|tracks?|music)\s+(?:like|similar\s+to)\s+/i,
  // 맨 앞 "like" 하나만은 지우지 않는다("Like a Rolling Stone"). 못 찾으면 AI가 다시 해석한다
  /^similar\s+to\s+/i,
];
const SUFFIX: RegExp[] = [
  new RegExp(
    String.raw`\s*,?\s*\b(?:include|including|with|plus)\s+${INC}(?:\s*(?:,|and|&)\s*${INC})*\s*$`,
    'i',
  ),
  /\s+\d{1,4}\s*(?:songs?|tracks?)$/i,
  /\s+\d{1,4}\s*곡$/,
  new RegExp(
    `\\s*${INC_KO}(?:\\s*(?:,|와|과|랑|및)\\s*${INC_KO})*\\s*(?:도\\s*)?(?:포함|넣어\\s*줘|넣어)$`,
  ),
  /\s*(?:이랑|하고|과|와)?\s*(?:비슷한|같은)\s*(?:노래|곡)(?:들)?$/,
  /\s+playlist$/i,
];

const clean = (s: string) =>
  s
    .replace(/^[\s"'“”‘’「」『』,.:;!?]+|[\s"'“”‘’「」『』,.:;!?]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/** 이름 하나의 상한: 글자 100, 낱말 12 (지시문이 통째로 섞인 문장은 이름으로 받지 않는다) */
const okName = (s: string) =>
  s.length > 0 && [...s].length <= MAX_NAME && s.split(' ').length <= MAX_NAME_WORDS;
const MAX_NAME_WORDS = 12;

export function parseFallback(text: string, locale: Locale): ParsedRequest | null {
  let rest = text.replace(/\s+/g, ' ').trim();
  if (!rest || [...rest].length > MAX_REQUEST_CHARS) return null;

  // 앞뒤 군더더기를 더 지울 게 없을 때까지 지우고, 지운 조각을 모은다
  const removed: string[] = [];
  for (let changed = true; changed;) {
    changed = false;
    for (const re of [...PREFIX, ...SUFFIX]) {
      const m = re.exec(rest);
      if (m && m[0].trim()) {
        removed.push(m[0]);
        rest = (rest.slice(0, m.index) + rest.slice(m.index + m[0].length)).trim();
        changed = true;
      }
    }
  }
  const extra = removed.join(' ');
  const include = {
    live: /\blive\b|라이브/i.test(extra),
    cover: /\bcovers?\b|커버/i.test(extra),
    remix: /\bremix(?:es)?\b|리믹스/i.test(extra),
  };
  const countMatch = /(\d{1,4})\s*(?:songs?|tracks?|곡)/i.exec(extra);
  const n = countMatch ? Number(countMatch[1]) : null;
  const count = n === null ? COUNT_DEFAULT : Math.min(COUNT_MAX, Math.max(COUNT_MIN, n));

  let seed: { artist: string; title: string } | null = null;
  const by = /^(.*)\s+by\s+(.+)$/i.exec(rest);
  const dash = /^(.+?)\s+[-–—―]\s+(.+)$/.exec(rest);
  if (by) {
    seed = { title: clean(by[1] ?? ''), artist: clean(by[2] ?? '') };
  } else if (dash) {
    seed = { artist: clean(dash[1] ?? ''), title: clean(dash[2] ?? '') };
  }
  if (!seed || !okName(seed.artist) || !okName(seed.title)) return null;

  return { seed, count, include, locale, unsupported: [] };
}

/**
 * 검색창 해석 순서 (SPEC 4.2, T22b): 규칙 → (AI를 쓸 수 있으면) AI.
 * - 규칙으로 기준 곡을 읽으면 AI를 부르지 않는다(비용 0).
 * - AI를 못 쓰면(절약 모드·키 없음) 또는 AI가 실패하면(오류·비용 상한) ai_fallback을 남기고 "다시 묻기"(not_understood).
 *   비용 상한이면 onAiLimit으로 절약 모드를 켠다.
 * 저장된 해석(parseCache)은 T32에서 이 앞에 붙는다.
 */
export async function parseWithFallback(
  deps: {
    llm: Llm | null;
    events: EventSink;
    actorUid?: string;
    aiMode: 'on' | 'saving' | 'no_key';
    onAiLimit?: () => Promise<void>;
    /** 규칙을 건너뛰고 AI로만 (규칙으로 읽은 기준 곡을 못 찾았을 때 다시 읽기) */
    skipRule?: boolean;
    /** 저장된 해석(T32). AI가 해석한 결과를 30일 다시 쓴다 */
    cache?: ParseCache;
  },
  text: string,
  locale: Locale,
): Promise<ParseResult> {
  const actor = deps.actorUid ? { actorUid: deps.actorUid } : {};
  const fail = async (reason: ParseFailReason): Promise<ParseResult> => {
    await deps.events.record({
      type: 'request_parse_failed',
      attrs: { reason },
      outcome: 'rejected',
      ...actor,
    });
    return { ok: false, reason };
  };
  const fallback = (reason: 'saving' | 'no_key' | 'ai_error') =>
    deps.events.record({ type: 'ai_fallback', attrs: { reason }, outcome: 'ok', ...actor });

  const request = text.trim();
  if (!request) return fail('empty');
  if ([...request].length > MAX_REQUEST_CHARS) return fail('too_long');

  // 1. 저장된 해석 (AI가 전에 읽은 같은 문장)
  if (deps.cache && !deps.skipRule) {
    const hit = await deps.cache.get(request, locale);
    if (hit) {
      await deps.events.record({
        type: 'request_parsed',
        attrs: { locale, requestedCount: hit.count, path: 'cache' },
        outcome: 'ok',
        ...actor,
      });
      return { ok: true, value: hit, via: 'ai' };
    }
  }

  // 2. 규칙
  const rule = deps.skipRule ? null : parseFallback(request, locale);
  if (rule) {
    await deps.events.record({
      type: 'request_parsed',
      attrs: { locale, requestedCount: rule.count, path: 'rule' },
      outcome: 'ok',
      ...actor,
    });
    return { ok: true, value: rule, via: 'rule' };
  }

  if (deps.aiMode !== 'on' || !deps.llm) {
    await fallback(deps.aiMode === 'on' ? 'no_key' : deps.aiMode);
    return fail('not_understood');
  }
  try {
    const r = await parseRequest(
      { llm: deps.llm, events: deps.events, ...(deps.actorUid ? { actorUid: deps.actorUid } : {}) },
      request,
      locale,
    );
    if (r.ok && r.value.seed) {
      try {
        await deps.cache?.set(request, locale, r.value);
      } catch (err) {
        // 저장 실패는 이번 요청에 영향 없음. 기록은 남긴다
        await deps.events.record({
          type: 'error',
          attrs: { code: errName(err), where: 'parse.cache_set' },
          outcome: 'error',
        });
      }
    }
    return r.ok ? { ...r, via: 'ai' } : r;
  } catch (err) {
    if (err instanceof BudgetExceededError && err.counter === 'aiCostMicroUsd') {
      await deps.onAiLimit?.();
      await fallback('saving');
    } else if (err instanceof BudgetExceededError || err instanceof KillSwitchError) {
      // 사용자 한도·긴급 정지 같은 다른 거부는 그대로 올린다
      throw err;
    } else {
      await fallback('ai_error');
    }
    return fail('not_understood');
  }
}
