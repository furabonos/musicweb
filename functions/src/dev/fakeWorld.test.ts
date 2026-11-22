import { DEMO_SEED, DEMO_SIMILAR } from '@musicweb/shared/demo';
import { describe, expect, it } from 'vitest';
import { FAKE_REASON, fakeLlm, fakeMusicAndYt } from './fakeWorld.js';

const parse = (request: string) =>
  fakeLlm().structured({
    op: 'llm.parseRequest',
    system: '',
    input: { request, uiLocale: 'en' },
    schema: {},
    maxTokens: 1,
  });

describe('가짜 AI (에뮬레이터 전용)', () => {
  it('요청 해석: 가짜 곡 목록의 곡 제목 → 기준 곡, 숫자 → 곡 수, 포함 조건·지원 안 하는 조건', async () => {
    expect(await parse('12 songs like Doja by Central Cee, include live, no slow ones')).toEqual({
      seed: { artist: 'Central Cee', title: 'Doja' },
      count: 12,
      include: { live: true, cover: false, remix: false },
      unsupported: ['mood'],
    });
    expect(await parse('songs from the 2010s like doja')).toMatchObject({
      seed: { title: 'Doja' },
      count: null,
      unsupported: ['year'],
    });
    expect(await parse('something nice')).toMatchObject({ seed: null });
  });

  it('곡 고르기: 후보 순서대로 요청 수만큼, 이유는 화면 언어로', async () => {
    const out = await fakeLlm().structured({
      op: 'llm.pick',
      system: '',
      input: {
        seed: { artist: 'Central Cee', title: 'Doja' },
        count: 2,
        locale: 'ko',
        candidates: [{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }],
      },
      schema: {},
      maxTokens: 1,
    });
    expect(out).toEqual({
      picks: [
        { id: 'c1', reason: FAKE_REASON.ko('Doja') },
        { id: 'c2', reason: FAKE_REASON.ko('Doja') },
      ],
    });
  });

  it('가짜 음악 데이터: 기준 곡의 비슷한 곡 = 나머지 가짜 곡, 다른 곡은 없음', async () => {
    const { music } = fakeMusicAndYt();
    const similar = await music.similarRecordings(DEMO_SEED.mbid, 50);
    expect(similar.map((s) => s.mbid)).toEqual(DEMO_SIMILAR.map((s) => s.mbid));
    expect(await music.similarRecordings(DEMO_SIMILAR[0]?.mbid ?? '', 50)).toEqual([]);
  });
});
