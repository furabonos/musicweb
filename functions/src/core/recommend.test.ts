import { describe, expect, it } from 'vitest';
import type { Llm, StructuredRequest } from '../adapters/llm.js';
import type { VideoDetail } from '../adapters/youtube-read.js';
import { memoryEvents } from '../testing/music.js';
import { SourceUnavailableError } from '../adapters/music-http.js';
import { BudgetExceededError } from './budget.js';
import { songKey, type SongDoc } from './catalog.js';
import type { ParsedRequest } from './parseRequest.js';
import { recommend, type RecommendPorts } from './recommend.js';

const NOW = new Date('2026-11-22T00:00:00Z');
const RH = 'a74b1b7f-71a5-4011-9441-d0b5e4122711';
const RH_CHANNEL = 'UCq19-LqvG35A-30oyAiPiqA';
const mbid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const SEED = {
  mbid: mbid(1),
  artist: 'Radiohead',
  artistMbid: RH,
  title: 'Karma Police',
  releaseYear: 1997,
};
const NO_SURPRISES = {
  mbid: mbid(2),
  artist: 'Radiohead',
  artistMbid: RH,
  title: 'No Surprises',
  releaseYear: 1997,
};
const PARANOID = {
  mbid: mbid(3),
  artist: 'Radiohead',
  artistMbid: RH,
  title: 'Paranoid Android',
  releaseYear: 1997,
};
const LUCKY = {
  mbid: mbid(4),
  artist: 'Radiohead',
  artistMbid: RH,
  title: 'Lucky',
  releaseYear: 1997,
};
const AIRBAG = {
  mbid: mbid(5),
  artist: 'Radiohead',
  artistMbid: RH,
  title: 'Airbag',
  releaseYear: 1997,
};
const LET_DOWN = {
  mbid: mbid(6),
  artist: 'Radiohead',
  artistMbid: RH,
  title: 'Let Down',
  releaseYear: 1997,
};

const link = (videoId: string, kind = 'official_audio') => ({
  videoId,
  kind,
  status: 'active',
  embeddable: true,
  madeForKids: false,
  durationSec: 240,
  verifiedAt: new Date(NOW.getTime() - 86_400_000),
});

function video(id: string, title: string): VideoDetail {
  return {
    videoId: id,
    title,
    channelId: RH_CHANNEL,
    channelTitle: 'Radiohead',
    description: '',
    durationSec: 260,
    publishedAt: '2020-01-01T00:00:00Z',
    embeddable: true,
    madeForKids: false,
    privacyStatus: 'public',
  };
}

interface World {
  catalog: SongDoc[];
  links: Record<string, ReturnType<typeof link>[]>;
  lbSimilar: { mbid: string; title: string; artist: string }[];
  aiCandidates: { artist: string; title: string }[];
  /** AI 고르기 응답을 만드는 함수. 기본: 받은 후보를 순서대로 다 고름 */
  pick?: (req: StructuredRequest) => unknown;
  recordings?: Record<string, { youtubeVideoIds: string[] }>;
  videos?: Record<string, VideoDetail>;
  searchResults?: Record<string, string[]>;
  searchBudgetLeft?: number;
  /** 이미 어느 곡에든 연결된 영상(saveLink가 저장하지 않음) */
  alreadyLinked?: string[];
  /** 이 출처는 장애 */
  down?: ('listenbrainz' | 'ai_candidates')[];
  /** YouTube 단위 한도 초과 */
  ytUnitsExhausted?: boolean;
  mbSearch?: { mbid: string; title: string; artist: string; artistMbid: string | null }[];
}

function world(over: Partial<World> = {}): World {
  return {
    catalog: [SEED, NO_SURPRISES, PARANOID],
    links: {
      [SEED.mbid]: [link('seedVideo01')],
      [NO_SURPRISES.mbid]: [link('noSurp00001')],
      [PARANOID.mbid]: [link('paranoidLv1', 'live')],
    },
    lbSimilar: [NO_SURPRISES, PARANOID, LUCKY, AIRBAG],
    aiCandidates: [
      { artist: 'Nobody Real', title: 'A Song That Does Not Exist' },
      { artist: 'Radiohead', title: 'No Surprises' },
    ],
    ...over,
  };
}

function setup(w: World) {
  const calls: string[] = [];
  const saved: string[] = [];
  const ev = memoryEvents();
  const songs = new Map(w.catalog.map((s) => [s.mbid, s]));
  const llm: Llm = {
    structured: async (req) => {
      calls.push(req.op);
      if (req.op === 'llm.candidates') {
        if (w.down?.includes('ai_candidates')) throw new Error('llm down');
        return { songs: w.aiCandidates };
      }
      if (w.pick) return w.pick(req);
      const cands = (req.input as { candidates: { id: string }[] }).candidates;
      return { picks: cands.map((c) => ({ id: c.id, reason: `fits ${c.id}` })) };
    },
  };
  let searchLeft = w.searchBudgetLeft ?? Infinity;
  const ports: RecommendPorts = {
    songs: {
      byIds: async (ids) =>
        new Map(ids.flatMap((id) => (songs.has(id) ? [[id, songs.get(id) as SongDoc]] : []))),
      byKeys: async (keys) =>
        new Map(
          [...songs.values()].flatMap((s) => {
            const k = songKey(s.artist, s.title);
            return keys.includes(k) ? [[k, s]] : [];
          }),
        ),
      byArtists: async () => [],
    },
    links: async (ids) => {
      calls.push(`links:${ids.length}`);
      return new Map(ids.flatMap((id) => (w.links[id] ? [[id, w.links[id]]] : [])));
    },
    music: {
      lbSearch: async () => [
        { mbid: SEED.mbid, title: SEED.title, artist: SEED.artist, releaseName: null },
      ],
      mbSearch: async () =>
        (w.mbSearch ?? []).map((r) => ({
          ...r,
          firstReleaseYear: 1997,
          score: 100,
          disambiguation: null,
          lengthMs: null,
        })),
      similarRecordings: async () => {
        if (w.down?.includes('listenbrainz')) throw new SourceUnavailableError('listenbrainz', 503);
        return w.lbSimilar.map((s, i) => ({ ...s, releaseName: null, score: 100 - i }));
      },
      similarArtists: async () => [],
      getRecording: async (id) => {
        calls.push(`getRecording:${id}`);
        const s = [LUCKY, AIRBAG, LET_DOWN].find((x) => x.mbid === id);
        if (!s) return null;
        return {
          mbid: s.mbid,
          title: s.title,
          artist: s.artist,
          artistMbid: s.artistMbid,
          firstReleaseYear: s.releaseYear,
          youtubeVideoIds: w.recordings?.[id]?.youtubeVideoIds ?? [],
          workMbids: [],
          genres: [],
          tags: [],
        };
      },
      works: async () => new Map(),
    },
    yt: {
      videos: async (ids) => {
        calls.push(`videos:${ids.join(',')}`);
        if (w.ytUnitsExhausted)
          throw new BudgetExceededError('service', 'ytUnits', 9000, 9000, NOW);
        return ids.flatMap((id) => (w.videos?.[id] ? [w.videos[id]] : []));
      },
      search: async (q) => {
        calls.push(`search:${q}`);
        if (searchLeft <= 0) throw new BudgetExceededError('user', 'searches', 10, 10, NOW);
        searchLeft--;
        return w.searchResults?.[q] ?? [];
      },
    },
    officialChannels: async () => [RH_CHANNEL],
    saveLink: async (song, v) => {
      if (w.alreadyLinked?.includes(v.videoId)) return false;
      saved.push(`${song.mbid}:${v.videoId}`);
      return true;
    },
    llm,
    events: ev.sink,
    now: () => NOW,
  };
  return { ports, calls, saved, events: ev.events };
}

const req = (over: Partial<ParsedRequest> = {}): ParsedRequest => ({
  seed: { artist: 'Radiohead', title: 'Karma Police' },
  count: 10,
  include: { live: false, cover: false, remix: false },
  locale: 'en',
  unsupported: [],
  ...over,
});
const stepOf = (events: { type: string; attrs: Record<string, unknown> }[], step: string) =>
  events.find((e) => e.type === 'recommend_step' && e.attrs.step === step)?.attrs;

describe('recommend — AI가 지어낸 곡·목록 밖 선택', () => {
  it('AI가 지어낸 곡은 결과에 없고 catalog_filter의 hallucinated로 기록', async () => {
    const { ports, events } = setup(world());
    const r = await recommend(ports, req(), { uid: 'u1' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.items.map((i) => i.title)).not.toContain('A Song That Does Not Exist');
    expect(stepOf(events, 'catalog_filter')).toMatchObject({ hallucinated: 1 });
    // AI와 ListenBrainz가 함께 낸 곡(No Surprises)은 지어낸 것이 아님
    expect(r.items.map((i) => i.title)).toContain('No Surprises');
    // 기준 곡 자신은 후보에서 빠짐
    expect(r.items.map((i) => i.songId)).not.toContain(SEED.mbid);
  });

  it('AI가 목록 밖 id를 고르면 버리고 ai_pick에 기록, 중복 선택도 버림', async () => {
    const pick = (q: StructuredRequest) => {
      const ids = (q.input as { candidates: { id: string }[] }).candidates.map((c) => c.id);
      return {
        picks: [
          { id: 'c99', reason: 'not in the list' },
          { id: 'Radiohead - Creep', reason: 'made up' },
          { id: ids[0], reason: 'first' },
          { id: ids[0], reason: 'again' },
        ],
      };
    };
    const { ports, events } = setup(world({ pick }));
    const r = await recommend(ports, req({ count: 5 }), { uid: 'u1' });
    if (!r.ok) throw new Error('fail');
    expect(r.items.filter((i) => i.reason === 'first')).toHaveLength(1);
    expect(
      r.items.some(
        (i) => i.reason === 'not in the list' || i.reason === 'made up' || i.reason === 'again',
      ),
    ).toBe(false);
    expect(stepOf(events, 'ai_pick')).toMatchObject({ hallucinated: 2, filtered: 3 });
  });

  it('AI 고르기가 실패하면 AI 없는 방식으로 고르고 고정 이유 문장(ai_fallback: ai_error)', async () => {
    const { ports, events } = setup(
      world({
        pick: () => {
          throw new Error('llm down');
        },
      }),
    );
    const r = await recommend(ports, req(), { uid: 'u1' });
    if (!r.ok) throw new Error('fail');
    expect(r.items.length).toBeGreaterThan(0);
    expect(r.items.every((i) => i.reason === 'People who play Karma Police also play this.')).toBe(
      true,
    );
    expect(events.filter((e) => e.type === 'ai_fallback').map((e) => e.attrs)).toEqual([
      { reason: 'ai_error' },
    ]);
  });

  it('이유는 한 줄·140자로 자름', async () => {
    const pick = (q: StructuredRequest) => ({
      picks: [
        {
          id: (q.input as { candidates: { id: string }[] }).candidates[0]?.id,
          reason: `line1\nline2 ${'x'.repeat(300)}`,
        },
      ],
    });
    const { ports } = setup(world({ pick }));
    const r = await recommend(ports, req(), { uid: 'u1' });
    if (!r.ok) throw new Error('fail');
    const reason = r.items[0]?.reason ?? '';
    expect(reason).not.toContain('\n');
    expect([...reason].length).toBe(140);
  });
});

describe('recommend — 모자랄 때', () => {
  it('후보가 모자라면 모자란 대로 돌려주고 이유 코드를 붙임', async () => {
    const { ports } = setup(world());
    const r = await recommend(ports, req({ count: 10 }), { uid: 'u1' });
    if (!r.ok) throw new Error('fail');
    expect(r.items.length).toBeLessThan(10);
    expect(r.shortfall).toEqual({
      requested: 10,
      got: r.items.length,
      reason: 'not_enough_playable',
    });
  });

  it('충분하면 shortfall null이고 요청 수만큼만', async () => {
    const many = Array.from({ length: 8 }, (_, i) => ({
      mbid: mbid(100 + i),
      artist: 'Radiohead',
      artistMbid: RH,
      title: `Song ${i}`,
      releaseYear: 1997,
    }));
    const { ports } = setup(
      world({
        catalog: [SEED, ...many],
        links: Object.fromEntries(
          many.map((s, i) => [s.mbid, [link(`vid${String(i).padStart(8, '0')}`)]]),
        ),
        lbSimilar: many,
        aiCandidates: [],
      }),
    );
    const r = await recommend(ports, req({ count: 5 }), { uid: 'u1' });
    if (!r.ok) throw new Error('fail');
    expect(r.items).toHaveLength(5);
    expect(r.shortfall).toBeNull();
  });

  it('예비 곡(spares)은 남는 후보에서만 더 고르고, 요청 수를 채웠으면 조회·검색하지 않음 (D-031)', async () => {
    const many = Array.from({ length: 7 }, (_, i) => ({
      mbid: mbid(200 + i),
      artist: 'Radiohead',
      artistMbid: RH,
      title: `Spare ${i}`,
      releaseYear: 1997,
    }));
    const { ports, calls } = setup(
      world({
        catalog: [SEED, ...many],
        links: Object.fromEntries(
          many.map((s, i) => [s.mbid, [link(`spr${String(i).padStart(8, '0')}`)]]),
        ),
        lbSimilar: [...many, AIRBAG],
        aiCandidates: [],
        searchResults: { 'Radiohead Airbag': ['airbagSrch1'] },
      }),
    );
    const r = await recommend(ports, req({ count: 5 }), { uid: 'u1' }, { spares: 5 });
    if (!r.ok) throw new Error('fail');
    // 재생할 수 있는 7곡: 요청 5 + 예비 2. 예비 3곡이 모자라도 조회·검색은 하지 않음
    expect(r.items).toHaveLength(7);
    expect(r.shortfall).toBeNull();
    expect(calls.filter((c) => c.startsWith('getRecording:') || c.startsWith('search:'))).toEqual(
      [],
    );
  });

  it('기준 곡이 없거나 못 찾으면 실패 이유와 request_parse_failed', async () => {
    const a = setup(world());
    expect(await recommend(a.ports, req({ seed: null }), { uid: 'u1' })).toEqual({
      ok: false,
      reason: 'no_seed',
    });
    expect(a.events[0]).toMatchObject({
      type: 'request_parse_failed',
      attrs: { reason: 'no_seed' },
    });

    const b = setup(world({ catalog: [] }));
    expect(
      await recommend(b.ports, req({ seed: { artist: 'Nobody', title: 'Nothing' } }), {
        uid: 'u1',
      }),
    ).toEqual({
      ok: false,
      reason: 'seed_not_found',
    });
    expect(
      b.events.some(
        (e) => e.type === 'request_parse_failed' && e.attrs.reason === 'seed_not_found',
      ),
    ).toBe(true);
    expect(b.calls.filter((c) => c.startsWith('llm'))).toHaveLength(0);
  });
});

describe('recommend — 조회 순서: 곡 목록 → 음악 데이터 링크 → 검색', () => {
  const w = () =>
    world({
      recordings: { [LUCKY.mbid]: { youtubeVideoIds: ['luckyMB0001'] } },
      videos: {
        luckyMB0001: video('luckyMB0001', 'Radiohead - Lucky (Official Video)'),
        airbagSrch1: video('airbagSrch1', 'Radiohead - Airbag (Official Video)'),
      },
      searchResults: { 'Radiohead Airbag': ['airbagSrch1'] },
    });

  it('곡 목록에서 재생할 수 있는 곡은 조회하지 않고, 음악 데이터 링크가 있으면 검색하지 않으며, 없을 때만 검색', async () => {
    const { ports, calls, saved } = setup(w());
    const r = await recommend(ports, req(), { uid: 'u1' });
    if (!r.ok) throw new Error('fail');
    // 곡 목록에 있는 곡(No Surprises)은 조회하지 않음
    expect(calls).not.toContain(`getRecording:${NO_SURPRISES.mbid}`);
    // 곡 목록 확인(links)이 어떤 조회보다 먼저
    const firstLinks = calls.findIndex((c) => c.startsWith('links:'));
    const firstLookup = calls.findIndex((c) => c.startsWith('getRecording:'));
    expect(firstLinks).toBeGreaterThanOrEqual(0);
    expect(firstLinks).toBeLessThan(firstLookup);
    // Lucky: 음악 데이터 링크 → videos.list, 검색 없음
    const luckyRec = calls.indexOf(`getRecording:${LUCKY.mbid}`);
    expect(calls[luckyRec + 1]).toBe('videos:luckyMB0001');
    expect(calls).not.toContain('search:Radiohead Lucky');
    // Airbag: 음악 데이터 링크 없음 → 검색 → videos.list
    const airbagRec = calls.indexOf(`getRecording:${AIRBAG.mbid}`);
    const airbagSearch = calls.indexOf('search:Radiohead Airbag');
    expect(airbagRec).toBeGreaterThan(-1);
    expect(airbagSearch).toBeGreaterThan(airbagRec);
    expect(calls[airbagSearch + 1]).toBe('videos:airbagSrch1');
    // 찾은 연결은 곡 목록에 저장되고 결과에 들어감
    expect(saved).toEqual([`${LUCKY.mbid}:luckyMB0001`, `${AIRBAG.mbid}:airbagSrch1`]);
    expect(r.items.map((i) => i.videoId)).toEqual(
      expect.arrayContaining(['luckyMB0001', 'airbagSrch1']),
    );
  });

  it('사용자 검색 한도가 소진되면 검색하지 않음(더 시도하지도 않음)', async () => {
    const base = w();
    const { ports, calls } = setup({
      ...base,
      lbSimilar: [NO_SURPRISES, AIRBAG, LET_DOWN],
      searchBudgetLeft: 0,
    });
    const r = await recommend(ports, req(), { uid: 'u1' });
    if (!r.ok) throw new Error('fail');
    const searches = calls.filter((c) => c.startsWith('search:'));
    // 한도 초과는 첫 시도에서 알 수 있다: 그 뒤 후보(Let Down)는 검색하지 않음
    expect(searches).toEqual(['search:Radiohead Airbag']);
    expect(calls).not.toContain('videos:airbagSrch1');
    expect(r.items.map((i) => i.title)).not.toContain('Airbag');
  });
});

describe('recommend — 라이브·커버·리믹스는 요청 조건이 있을 때만', () => {
  it('라이브 연결만 있는 곡은 기본 제외, include.live면 포함', async () => {
    const off = setup(world());
    const r1 = await recommend(off.ports, req(), { uid: 'u1' });
    if (!r1.ok) throw new Error('fail');
    expect(r1.items.map((i) => i.title)).not.toContain('Paranoid Android');

    const on = setup(world());
    const r2 = await recommend(
      on.ports,
      req({ include: { live: true, cover: false, remix: false } }),
      { uid: 'u1' },
    );
    if (!r2.ok) throw new Error('fail');
    expect(r2.items.find((i) => i.title === 'Paranoid Android')?.kind).toBe('live');
  });

  it.each(['cover', 'remix'] as const)('%s 연결도 요청 조건이 있을 때만', async (kind) => {
    const w = world({ links: { ...world().links, [PARANOID.mbid]: [link('paranoidX01', kind)] } });
    const r1 = await recommend(setup(w).ports, req(), { uid: 'u1' });
    const r2 = await recommend(
      setup(w).ports,
      req({ include: { live: false, cover: kind === 'cover', remix: kind === 'remix' } }),
      { uid: 'u1' },
    );
    if (!r1.ok || !r2.ok) throw new Error('fail');
    expect(r1.items.map((i) => i.videoId)).not.toContain('paranoidX01');
    expect(r2.items.map((i) => i.videoId)).toContain('paranoidX01');
  });
});

describe('recommend — 조회의 예외 경로', () => {
  const w = (over: Partial<World> = {}) =>
    world({
      recordings: { [LUCKY.mbid]: { youtubeVideoIds: ['luckyMB0001'] } },
      videos: {
        luckyMB0001: video('luckyMB0001', 'Radiohead - Lucky (Official Video)'),
        airbagSrch1: video('airbagSrch1', 'Radiohead - Airbag (Official Video)'),
      },
      searchResults: { 'Radiohead Airbag': ['airbagSrch1'] },
      ...over,
    });

  it('이미 다른 연결(막힘·거절·다른 곡)이 있는 영상은 저장도 안 되고 결과에도 안 나옴', async () => {
    const { ports } = setup(w({ alreadyLinked: ['luckyMB0001'] }));
    const r = await recommend(ports, req(), { uid: 'u1' });
    if (!r.ok) throw new Error('fail');
    expect(r.items.map((i) => i.videoId)).not.toContain('luckyMB0001');
  });

  it('YouTube 단위 한도에 닿으면 조회 전체를 멈추고(다음 후보도 안 봄) 있는 것으로 결과를 냄', async () => {
    const { ports, calls } = setup(
      w({ ytUnitsExhausted: true, lbSimilar: [NO_SURPRISES, LUCKY, AIRBAG] }),
    );
    const r = await recommend(ports, req(), { uid: 'u1' });
    if (!r.ok) throw new Error('fail');
    // Lucky의 videos.list에서 한도 → Airbag은 조회하지 않음
    expect(calls.filter((c) => c.startsWith('getRecording:'))).toEqual([
      `getRecording:${LUCKY.mbid}`,
    ]);
    expect(calls.filter((c) => c.startsWith('search:'))).toHaveLength(0);
    expect(r.items.map((i) => i.title)).toContain('No Surprises');
  });

  it('요청 하나에서 검색은 최대 3번', async () => {
    const extra = Array.from({ length: 6 }, (_, i) => ({
      ...LET_DOWN,
      mbid: mbid(200 + i),
      title: `Extra ${i}`,
    }));
    const { ports, calls } = setup(w({ lbSimilar: [NO_SURPRISES, ...extra] }));
    const getRec = ports.music.getRecording;
    ports.music.getRecording = async (id) => {
      const e = extra.find((x) => x.mbid === id);
      if (!e) return getRec(id);
      calls.push(`getRecording:${id}`);
      return {
        mbid: e.mbid,
        title: e.title,
        artist: e.artist,
        artistMbid: e.artistMbid,
        firstReleaseYear: 1997,
        youtubeVideoIds: [],
        workMbids: [],
        genres: [],
        tags: [],
      };
    };
    await recommend(ports, req(), { uid: 'u1' });
    expect(calls.filter((c) => c.startsWith('search:'))).toHaveLength(3);
  });

  it('ListenBrainz 장애·AI 후보 실패는 그 출처만 건너뛰고 결과를 냄', async () => {
    const { ports, events } = setup(
      w({ down: ['listenbrainz', 'ai_candidates'], aiCandidates: [] }),
    );
    // 다른 출처: 비슷한 아티스트의 곡 목록 내 곡
    ports.music.similarArtists = async () => [{ mbid: RH, name: 'Radiohead', score: 1 }];
    ports.songs.byArtists = async () => [NO_SURPRISES];
    const r = await recommend(ports, req(), { uid: 'u1' });
    if (!r.ok) throw new Error('fail');
    expect(r.items.map((i) => i.title)).toEqual(['No Surprises']);
    const wheres = events.filter((e) => e.type === 'error').map((e) => e.attrs.where);
    expect(wheres).toEqual(expect.arrayContaining(['recommend.source', 'recommend.ai_candidates']));
  });

  it('기준 곡이 곡 목록에 없으면 MusicBrainz에서 제목·아티스트가 모두 같은 것만 (다른 아티스트의 같은 제목은 안 됨)', async () => {
    const cover = {
      mbid: mbid(900),
      title: 'Karma Police',
      artist: 'Some Cover Band',
      artistMbid: null,
    };
    const a = setup(w({ catalog: [NO_SURPRISES], mbSearch: [cover] }));
    expect(await recommend(a.ports, req(), { uid: 'u1' })).toEqual({
      ok: false,
      reason: 'seed_not_found',
    });

    const real = { mbid: mbid(901), title: 'Karma Police', artist: 'Radiohead', artistMbid: RH };
    const b = setup(w({ catalog: [NO_SURPRISES], mbSearch: [cover, real] }));
    const r = await recommend(b.ports, req(), { uid: 'u1' });
    if (!r.ok) throw new Error('fail');
    expect(r.seed.songId).toBe(mbid(901));
  });
});

describe('recommend — AI 없는 방식 (절약 모드·키 없음·AI 오류, T22b)', () => {
  const PORTISHEAD = {
    mbid: mbid(20),
    artist: 'Portishead',
    artistMbid: null,
    title: 'Glory Box',
    releaseYear: 1994,
  };
  const variety = () =>
    world({
      catalog: [SEED, NO_SURPRISES, PARANOID, PORTISHEAD],
      links: {
        [SEED.mbid]: [link('seedVideo01')],
        [NO_SURPRISES.mbid]: [link('noSurp00001')],
        [PARANOID.mbid]: [link('paranoid001')],
        [PORTISHEAD.mbid]: [link('gloryBox001')],
      },
      // 점수 순: No Surprises, Paranoid Android(같은 아티스트), Glory Box
      lbSimilar: [NO_SURPRISES, PARANOID, PORTISHEAD],
    });

  it.each(['saving', 'no_key'] as const)(
    '%s: AI 호출 0건, 재생목록은 나오고 같은 아티스트가 연달아 나오지 않는다',
    async (mode) => {
      const { ports, calls, events } = setup(variety());
      const r = await recommend(ports, req({ count: 5 }), { uid: 'u1' }, { ai: { mode } });
      if (!r.ok) throw new Error('fail');
      expect(calls.filter((c) => c.startsWith('llm.'))).toEqual([]);
      expect(r.items.map((i) => i.title)).toEqual([
        'No Surprises',
        'Glory Box',
        'Paranoid Android',
      ]);
      expect(r.items[0]?.reason).toBe('People who play Karma Police also play this.');
      expect(events.filter((e) => e.type === 'ai_fallback').map((e) => e.attrs)).toEqual([
        { reason: mode },
      ]);
      expect(stepOf(events, 'rule_pick')).toMatchObject({ candidates: 3 });
      expect(stepOf(events, 'ai_pick')).toBeUndefined();
    },
  );

  it('AI 비용 상한에 닿으면 절약 모드를 켜고(onLimit) 그 요청은 AI 없이 끝낸다', async () => {
    const w = variety();
    const { ports, calls, events } = setup(w);
    ports.llm = {
      structured: async (q) => {
        calls.push(q.op);
        throw new BudgetExceededError('service', 'aiCostMicroUsd', 3_000_000, 3_000_000, NOW);
      },
    };
    let limitHit = 0;
    const r = await recommend(
      ports,
      req({ count: 5 }),
      { uid: 'u1' },
      { ai: { mode: 'on', onLimit: async () => void limitHit++ } },
    );
    if (!r.ok) throw new Error('fail');
    expect(limitHit).toBe(1);
    // 후보 단계에서 한 번 실패한 뒤 고르기 단계는 AI를 부르지 않는다
    expect(calls.filter((c) => c.startsWith('llm.'))).toEqual(['llm.candidates']);
    expect(r.items).toHaveLength(3);
    expect(events.filter((e) => e.type === 'ai_fallback').map((e) => e.attrs)).toEqual([
      { reason: 'saving' },
    ]);
  });

  it('AI 오류(고르기 실패)여도 같은 아티스트가 연달아 나오지 않는다', async () => {
    const w = variety();
    w.pick = () => {
      throw new Error('llm down');
    };
    const { ports } = setup(w);
    const r = await recommend(ports, req({ count: 5 }), { uid: 'u1' });
    if (!r.ok) throw new Error('fail');
    const artists = r.items.map((i) => i.artist);
    for (let i = 1; i < artists.length - 1; i++) expect(artists[i]).not.toBe(artists[i - 1]);
    expect(r.items.map((i) => i.title)).toEqual(['No Surprises', 'Glory Box', 'Paranoid Android']);
  });

  it('한국어 화면은 한국어 고정 문장', async () => {
    const { ports } = setup(variety());
    const r = await recommend(
      ports,
      req({ count: 5, locale: 'ko' }),
      { uid: 'u1' },
      {
        ai: { mode: 'no_key' },
      },
    );
    if (!r.ok) throw new Error('fail');
    expect(r.items[0]?.reason).toBe('「Karma Police」 청취자들이 함께 듣는 곡이에요.');
  });
});
