/**
 * 요청 해석 시험 채점 (T12). 문항의 expect에 적은 필드만 본다.
 * - seed: 대소문자·공백·문장부호를 무시하고 artist·title 비교. null이면 null이어야 맞음.
 * - unsupported: 기대한 코드가 모두 들어 있으면 맞음(더 있어도 됨).
 */

export interface ParseCase {
  id: string;
  locale: 'en' | 'ko';
  input: string;
  expect: {
    seed?: { artist: string; title: string } | null;
    count?: number;
    include?: { live: boolean; cover: boolean; remix: boolean };
    unsupported?: string[];
  };
}

export interface ParseOutcome {
  ok: boolean;
  value?: {
    seed: { artist: string; title: string } | null;
    count: number;
    include: { live: boolean; cover: boolean; remix: boolean };
    unsupported: string[];
  };
}

const norm = (s: string) =>
  s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{P}\p{S}\s]+/gu, '');

/** 틀린 필드 이름 목록(빈 배열이면 통과). */
export function scoreCase(c: ParseCase, out: ParseOutcome): string[] {
  if (!out.ok || !out.value) return ['parse_failed'];
  const v = out.value;
  const wrong: string[] = [];
  const e = c.expect;
  if (e.seed !== undefined) {
    const same =
      e.seed === null
        ? v.seed === null
        : v.seed !== null &&
          norm(v.seed.artist) === norm(e.seed.artist) &&
          norm(v.seed.title) === norm(e.seed.title);
    if (!same) wrong.push('seed');
  }
  if (e.count !== undefined && v.count !== e.count) wrong.push('count');
  if (e.include) {
    for (const k of ['live', 'cover', 'remix'] as const) {
      if (v.include[k] !== e.include[k]) wrong.push(`include.${k}`);
    }
  }
  if (e.unsupported && !e.unsupported.every((u) => v.unsupported.includes(u))) {
    wrong.push('unsupported');
  }
  return wrong;
}

export function summarize(results: { id: string; wrong: string[] }[]) {
  const failed = results.filter((r) => r.wrong.length);
  return {
    cases: results.length,
    passed: results.length - failed.length,
    accuracy: results.length
      ? Math.round(((results.length - failed.length) / results.length) * 100) / 100
      : 0,
    failedIds: failed.map((r) => r.id),
  };
}
