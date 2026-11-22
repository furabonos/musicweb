import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import type { Llm } from '../adapters/llm.js';
import { pacificDay } from '../core/day.js';
import type { EventSink } from '../core/events.js';
import { errName } from '../core/jobErrors.js';
import { parseRequest } from '../core/parseRequest.js';
import matchingData from '../../../evals/matching/cases.json' with { type: 'json' };
import parseData from '../../../evals/parse/cases.json' with { type: 'json' };
import {
  scoreMatchingCase,
  summarizeMatching,
  type MatchingCase,
} from '../../../evals/matching/score.js';
import { scoreCase, summarize, type ParseCase } from '../../../evals/parse/score.js';

/**
 * 매일 시험 (SPEC 4.9, T17, D-034). 결과를 metrics/{day}.eval과 metrics/current.eval에 쓴다(현황판, T21).
 * - matching(곡 연결 규칙): 배포된 규칙으로 시험 문제를 돌린다. AI 없음.
 * - parse(요청 해석): AI가 있을 때만(서비스 AI 키·하루 비용 상한 안). 없으면 건너뛰었다고 남긴다.
 * - recommend 시험은 매일 돌리지 않는다(손으로 만든 후보라 실제 데이터 측정이 아니고 호출이 많음). CI·직접 실행에서만.
 * 숫자마다 계산 방법을 같이 적는다(SPEC 4.10).
 */
export interface DailyEvalDeps {
  db: Firestore;
  events: EventSink;
  /** 없으면 AI 시험은 건너뜀. AI 비용 기록(external_call)은 실제 비용이라 운영 기록에 남는다. */
  llm: Llm | null;
  now?: () => Date;
}

const matchingCases = (matchingData as { cases: MatchingCase[] }).cases;
const parseCases = (parseData as { cases: ParseCase[] }).cases;

const METHOD = {
  matching: `Share of the ${matchingCases.length} song-matching test cases where the rules pick the expected video (or correctly pick none).`,
  parse: `Share of the ${parseCases.length} request-parsing test cases where the AI extracts every expected field.`,
};

/** 시험 문항의 해석 결과 이벤트(request_parsed 등)는 운영 기록에 남기지 않는다: 실제 사용자 요청 통계를 왜곡하므로. */
const discard: EventSink = { record: async () => {} };

export async function runDailyEval(deps: DailyEvalDeps) {
  const { db, events } = deps;
  const now = (deps.now ?? (() => new Date()))();
  await events.record({ type: 'job_started', attrs: { job: 'dailyEval' }, outcome: 'ok' });
  let failed = 0;

  const matchingResults = [];
  for (const c of matchingCases) matchingResults.push(await scoreMatchingCase(c));
  const matching = summarizeMatching(matchingResults);

  let parse: Record<string, unknown> = { skipped: 'no AI key' };
  if (deps.llm) {
    try {
      const results = [];
      for (const c of parseCases) {
        const out = await parseRequest({ llm: deps.llm, events: discard }, c.input, c.locale);
        results.push({ id: c.id, wrong: scoreCase(c, out) });
      }
      const s = summarize(results);
      parse = { score: s.accuracy, cases: s.cases, failedIds: s.failedIds };
    } catch (err) {
      // 한도·긴급 정지·AI 장애: 그날 요청 해석 시험만 빠진다
      failed++;
      parse = { skipped: errName(err) };
      await events.record({
        type: 'error',
        attrs: { code: errName(err), where: 'dailyEval.parse' },
        outcome: 'error',
      });
    }
  }

  const evalDoc = {
    at: FieldValue.serverTimestamp(),
    matching: {
      score: matching.score,
      cases: matching.cases,
      pendingAi: matching.pendingAi,
      method: METHOD.matching,
    },
    parse: { ...parse, method: METHOD.parse },
  };
  const day = pacificDay(now);
  const batch = db.batch();
  batch.set(db.doc(`metrics/${day}`), { eval: evalDoc }, { merge: true });
  batch.set(db.doc('metrics/current'), { eval: evalDoc }, { merge: true });
  await batch.commit();
  await events.record({
    type: 'job_finished',
    attrs: { job: 'dailyEval', processed: matching.cases, failed },
    outcome: failed ? 'error' : 'ok',
  });
  return { matching, parse };
}
