/**
 * 곡 연결 시험 채점 (T17, 스킬 song-matching). 규칙만으로 돈다(AI 없음, 결정적 → CI에서도 실행).
 * - 맞음: decideLink가 정답 영상을 골랐다(종류도 적혀 있으면 종류까지). 정답이 "연결 안 함"이면 연결하지 않았다.
 * - 애매해서 AI에 넘긴 것(pending_ai)은 "아직 연결 안 함"으로 본다. 정답이 영상이면 틀림, 정답이 없음이면 맞음.
 *   그 수는 따로 센다(AI 판정이 몇 곡을 맡는지).
 */
import {
  decideLink,
  type Include,
  type SongRef,
  type VideoCandidate,
} from '../../packages/shared/src/index.js';

export interface MatchingCase {
  id: string;
  note?: string;
  song: SongRef;
  include?: Include;
  videos: VideoCandidate[];
  expect: { videoId: string | null; kind?: string };
}

export interface MatchingOutcome {
  id: string;
  correct: boolean;
  pendingAi: boolean;
  got: string | null;
}

export async function scoreMatchingCase(c: MatchingCase): Promise<MatchingOutcome> {
  const d = await decideLink(c.song, c.videos, c.include);
  const got = d.status === 'active' ? d.videoId : null;
  const kindOk = d.status !== 'active' || !c.expect.kind || d.kind === c.expect.kind;
  return {
    id: c.id,
    correct: got === c.expect.videoId && kindOk,
    pendingAi: d.status === 'pending_ai',
    got,
  };
}

export function summarizeMatching(results: MatchingOutcome[]) {
  const correct = results.filter((r) => r.correct).length;
  return {
    cases: results.length,
    correct,
    score: results.length ? round2(correct / results.length) : 0,
    pendingAi: results.filter((r) => r.pendingAi).length,
    failedIds: results.filter((r) => !r.correct).map((r) => r.id),
  };
}

export const round2 = (x: number) => Math.round(x * 100) / 100;
