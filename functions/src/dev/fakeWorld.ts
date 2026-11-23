import { compareKey } from '@musicweb/shared';
import { DEMO_SEED, DEMO_SIMILAR, DEMO_SONGS } from '@musicweb/shared/demo';
import type { Llm, LlmBudget, StructuredRequest } from '../adapters/llm.js';
import type { RecommendPorts } from '../core/recommend.js';

/**
 * 에뮬레이터 전용 가짜 외부 서비스 (T14, D-031). config/runtimeEnv.ts의 fakeExternalEnabled()가 켜졌을 때만 쓴다.
 * 실제 AI·MusicBrainz·ListenBrainz·YouTube를 부르지 않고, 가짜 곡 목록(packages/shared/src/demo)으로 답한다.
 * - 요청 해석: 문장에 가짜 곡 목록의 곡 제목이 있으면 그 곡을 기준 곡으로. 숫자는 곡 수, live/cover/remix 단어는 포함 조건.
 * - 곡 고르기: 후보를 순서대로, 이유는 화면 언어(en/ko)로. 화면 언어가 AI까지 전달되는지 e2e가 이 글로 확인한다.
 */

export const FAKE_REASON = {
  en: (title: string) => `Demo pick: people who play ${title} also play this.`,
  ko: (title: string) => `데모 선택: ${title}을(를) 듣는 사람들이 함께 듣는 곡입니다.`,
};

function fakeParse(input: Record<string, unknown>) {
  const text = typeof input.request === 'string' ? input.request : '';
  const key = compareKey(text);
  const found = [...DEMO_SONGS]
    .sort((a, b) => b.title.length - a.title.length)
    .find((s) => ` ${key} `.includes(` ${compareKey(s.title)} `));
  const year = /\b(19|20)\d\ds?\b|\b\d0s\b|년대/i.test(text);
  const count = /\b(\d{1,2})\b/.exec(text.replace(/\b(19|20)\d\ds?\b/g, ''));
  const unsupported: string[] = [];
  if (year) unsupported.push('year');
  if (/\b(slow|chill|sad|happy|mood)\b|느린|신나는|잔잔/i.test(text)) unsupported.push('mood');
  return {
    seed: found ? { artist: found.artist, title: found.title } : null,
    count: count ? Number(count[1]) : null,
    include: {
      live: /\blive\b|라이브/i.test(text),
      cover: /\bcovers?\b|커버/i.test(text),
      remix: /\bremix(es)?\b|리믹스/i.test(text),
    },
    unsupported,
  };
}

function fakePick(input: Record<string, unknown>) {
  const count = typeof input.count === 'number' ? input.count : 10;
  const locale = input.locale === 'ko' ? 'ko' : 'en';
  const seed = input.seed as { title?: string } | undefined;
  const candidates = Array.isArray(input.candidates) ? (input.candidates as { id: string }[]) : [];
  return {
    picks: candidates
      .slice(0, count)
      .map((c) => ({ id: c.id, reason: FAKE_REASON[locale](seed?.title ?? '') })),
  };
}

/**
 * budget을 주면 진짜 AI처럼 호출마다 비용 상한을 거친다(1 microUSD 예약, 실제 비용 0).
 * 에뮬레이터에서 AI 비용 상한을 0으로 두면 절약 모드로 바뀌는 흐름을 확인할 수 있다(T22b).
 */
export function fakeLlm(budget?: LlmBudget): Llm {
  const answer = (req: StructuredRequest) => {
    switch (req.op) {
      case 'llm.parseRequest':
        return fakeParse(req.input);
      case 'llm.pick':
        return fakePick(req.input);
      case 'llm.candidates':
        return { songs: [] };
      case 'llm.judgeLink':
        return { choice: null };
    }
  };
  return {
    async structured(req: StructuredRequest) {
      if (budget) return budget.run(1, async () => ({ result: answer(req), costMicroUsd: 0 }));
      return answer(req);
    },
  };
}

/** 가짜 음악 데이터·YouTube. 기준 곡의 비슷한 곡 = 가짜 곡 목록의 나머지. */
export function fakeMusicAndYt(): Pick<RecommendPorts, 'music' | 'yt'> {
  return {
    music: {
      lbSearch: async () => [],
      mbSearch: async () => [],
      similarRecordings: async (mbid) =>
        mbid === DEMO_SEED.mbid
          ? DEMO_SIMILAR.map((s, i) => ({
              mbid: s.mbid,
              title: s.title,
              artist: s.artist,
              releaseName: null,
              score: DEMO_SIMILAR.length - i,
            }))
          : [],
      similarArtists: async () => [],
      getRecording: async () => null,
      works: async () => new Map(),
    },
    yt: { videos: async () => [], search: async () => [] },
  };
}
