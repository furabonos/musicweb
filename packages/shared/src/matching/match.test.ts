import { describe, expect, it, vi } from 'vitest';
import {
  classify,
  decideLink,
  isAmbiguous,
  NO_EXTRAS,
  rankCandidates,
  titleMatch,
  type Judge,
  type LinkKind,
  type SongRef,
  type TitleMatch,
  type VideoCandidate,
} from './match.js';

// 예시 표 (스킬 song-matching 4장: 최소 40개). 영상 정보는 실제 형식을 본뜬 예시다.
const RH = 'UCq19-LqvG35A-30oyAiPiqA';
const IU_CH = 'UC3SyT4_WLHzN7JmHQwKQZww';
const HYBE = 'UC3IZKseVpdzPSBaWxBxundA';
const YOASOBI_CH = 'UCvpredjG93ifbCP1Y77JyFA';
const OASIS_CH = 'UCmTM_hPCeckqN3cPWtYZZcg';
const BIEBER_CH = 'UCIwFjwMjI0y7PDBVEO9-bkQ';

const SONGS = {
  karma: {
    title: 'Karma Police',
    artist: 'Radiohead',
    lengthMs: 264_000,
    officialChannelIds: [RH],
  },
  iu: {
    title: '밤편지',
    aliases: ['Through the Night'],
    artist: 'IU',
    artistAliases: ['아이유'],
    lengthMs: 253_000,
    officialChannelIds: [IU_CH],
  },
  oasis: {
    title: 'Live Forever',
    artist: 'Oasis',
    lengthMs: 276_000,
    officialChannelIds: [OASIS_CH],
  },
  springsteen: {
    title: 'Cover Me',
    artist: 'Bruce Springsteen',
    lengthMs: 207_000,
    officialChannelIds: [],
  },
  yoasobi: {
    title: '夜に駆ける',
    aliases: ['Yoru ni Kakeru', 'Racing into the Night'],
    artist: 'YOASOBI',
    lengthMs: 261_000,
    officialChannelIds: [YOASOBI_CH],
  },
  bts: {
    title: 'Dynamite',
    artist: 'BTS',
    artistAliases: ['방탄소년단'],
    lengthMs: 199_000,
    officialChannelIds: [HYBE],
  },
  bieber: {
    title: 'Peaches',
    artist: 'Justin Bieber',
    lengthMs: 198_000,
    officialChannelIds: [BIEBER_CH],
  },
  behind: { title: 'Behind Blue Eyes', artist: 'The Who', lengthMs: 222_000 },
  up: { title: 'Up', artist: 'Cardi B', lengthMs: 156_000 },
  over: { title: 'Over', artist: 'Drake', lengthMs: 234_000 },
  killer: { title: 'Killer Queen', artist: 'Queen', lengthMs: 180_000 },
  lightning: { title: 'Lightning Crashes', artist: 'Live', lengthMs: 325_000 },
  beyonce: { title: 'Halo', artist: 'Beyoncé', lengthMs: 261_000 },
  drive: { title: 'ドライブ', artist: 'Some Artist', lengthMs: 200_000 },
  it: { title: 'It', artist: 'Some Band', lengthMs: 200_000 },
} satisfies Record<string, SongRef>;

const v = (
  o: Partial<VideoCandidate> & { title: string; channelTitle: string },
): VideoCandidate => ({
  videoId: o.videoId ?? 'aaaaaaaaaaa',
  channelId: o.channelId ?? 'UCxxxxxxxxxxxxxxxxxxxxxx',
  durationSec: o.durationSec ?? 260,
  ...o,
});
const IU_OFFICIAL = { channelTitle: '이지금 [IU Official]', channelId: IU_CH };

// [이름, 곡, 영상, 기대 종류, 제외 이유, 그 곡의 제목과 맞는가]
type Row = [string, SongRef, VideoCandidate, LinkKind, string | null, TitleMatch];
const CASES: Row[] = [
  // --- Topic 채널 → official_audio
  [
    'Topic 채널',
    SONGS.karma,
    v({ title: 'Karma Police', channelTitle: 'Radiohead - Topic' }),
    'official_audio',
    null,
    'exact',
  ],
  [
    'Topic 채널 (한글 제목)',
    SONGS.iu,
    v({ title: '밤편지', channelTitle: 'IU - Topic' }),
    'official_audio',
    null,
    'exact',
  ],
  [
    'Topic 채널 (일본어)',
    SONGS.yoasobi,
    v({ title: '夜に駆ける', channelTitle: 'YOASOBI - Topic' }),
    'official_audio',
    null,
    'exact',
  ],
  [
    'Topic + Remastered 괄호',
    SONGS.karma,
    v({ title: 'Karma Police (Remastered 2017)', channelTitle: 'Radiohead - Topic' }),
    'official_audio',
    null,
    'exact',
  ],
  [
    'Topic + 대시 뒤 Remastered',
    SONGS.karma,
    v({ title: 'Karma Police - Remastered 2009', channelTitle: 'Radiohead - Topic' }),
    'official_audio',
    null,
    'exact',
  ],
  [
    'Topic + 대시 뒤 2011 Remaster',
    SONGS.karma,
    v({ title: 'Karma Police - 2011 Remaster', channelTitle: 'Radiohead - Topic' }),
    'official_audio',
    null,
    'exact',
  ],
  [
    '다른 가수의 Topic 채널 = 커버',
    SONGS.karma,
    v({ title: 'Karma Police', channelTitle: 'Some Band - Topic' }),
    'cover',
    null,
    'exact',
  ],
  [
    '악센트 다른 아티스트 Topic (Beyoncé)',
    SONGS.beyonce,
    v({ title: 'Halo', channelTitle: 'Beyonce - Topic' }),
    'official_audio',
    null,
    'exact',
  ],
  // --- Provided to YouTube by: 공식 채널 ID와 함께일 때만
  [
    'Provided + 공식 채널',
    SONGS.karma,
    v({
      title: 'Karma Police',
      channelTitle: 'Radiohead',
      channelId: RH,
      description: 'Provided to YouTube by XL Recordings',
    }),
    'official_audio',
    null,
    'exact',
  ],
  [
    'Provided를 복사한 재업로드 = 커버',
    SONGS.karma,
    v({
      title: 'Radiohead - Karma Police',
      channelTitle: 'Label Uploads',
      description: 'Provided to YouTube by XL Recordings',
    }),
    'cover',
    null,
    'exact',
  ],
  // --- 공식 채널 + 표시
  [
    '공식 채널 Official Audio',
    SONGS.karma,
    v({
      title: 'Radiohead - Karma Police (Official Audio)',
      channelTitle: 'Radiohead',
      channelId: RH,
    }),
    'official_audio',
    null,
    'exact',
  ],
  [
    '공식 채널 Official Music Video',
    SONGS.karma,
    v({
      title: 'Radiohead - Karma Police (Official Music Video)',
      channelTitle: 'Radiohead',
      channelId: RH,
    }),
    'official_mv',
    null,
    'exact',
  ],
  [
    '공식 채널 [MV] _ 구분자 + 다국어',
    SONGS.iu,
    v({ title: '[MV] IU(아이유) _ Through the Night(밤편지)', ...IU_OFFICIAL }),
    'official_mv',
    null,
    'exact',
  ],
  [
    '공식 채널 M/V 괄호 없이',
    SONGS.iu,
    v({ title: 'IU - 밤편지 M/V', ...IU_OFFICIAL }),
    'official_mv',
    null,
    'exact',
  ],
  [
    '공식 채널 뮤직비디오 괄호 없이',
    SONGS.iu,
    v({ title: '아이유 - 밤편지 뮤직비디오', ...IU_OFFICIAL }),
    'official_mv',
    null,
    'exact',
  ],
  [
    '공식 채널 「」 + Official Music Video',
    SONGS.yoasobi,
    v({
      title: 'YOASOBI「夜に駆ける」Official Music Video',
      channelTitle: 'Ayase / YOASOBI',
      channelId: YOASOBI_CH,
    }),
    'official_mv',
    null,
    'exact',
  ],
  [
    "레이블 채널 'Dynamite' Official MV (작은따옴표 제목)",
    SONGS.bts,
    v({
      title: "BTS (방탄소년단) 'Dynamite' Official MV",
      channelTitle: 'HYBE LABELS',
      channelId: HYBE,
    }),
    'official_mv',
    null,
    'exact',
  ],
  [
    '공식 채널 | Official Video 꼬리',
    SONGS.karma,
    v({ title: 'Karma Police | Official Video', channelTitle: 'Radiohead', channelId: RH }),
    'official_mv',
    null,
    'exact',
  ],
  [
    '공식 채널 Visualizer = 음원',
    SONGS.karma,
    v({ title: 'Karma Police (Official Visualizer)', channelTitle: 'Radiohead', channelId: RH }),
    'official_audio',
    null,
    'exact',
  ],
  [
    '공식 채널 Lyric Video = 음원',
    SONGS.iu,
    v({ title: '[Lyric Video] IU - 밤편지', ...IU_OFFICIAL }),
    'official_audio',
    null,
    'exact',
  ],
  [
    '공식 채널인데 표시 없음 → 연결 안 함',
    SONGS.karma,
    v({ title: 'Karma Police', channelTitle: 'Radiohead', channelId: RH }),
    'other',
    'unlabeled_official_upload',
    'exact',
  ],
  [
    '일본어 " / " 구분자',
    SONGS.yoasobi,
    v({
      title: '夜に駆ける / YOASOBI',
      channelTitle: 'Ayase / YOASOBI',
      channelId: YOASOBI_CH,
      description: 'Provided to YouTube by Sony',
    }),
    'official_audio',
    null,
    'exact',
  ],
  // --- 라이브
  [
    'Live 괄호',
    SONGS.karma,
    v({ title: 'Radiohead - Karma Police (Live)', channelTitle: 'Radiohead', channelId: RH }),
    'live',
    null,
    'exact',
  ],
  [
    'Live at 장소 (괄호 없음)',
    SONGS.karma,
    v({
      title: 'Radiohead - Karma Police Live at Glastonbury 1997',
      channelTitle: 'Concert Archive',
    }),
    'live',
    null,
    'none',
  ],
  [
    '@ 장소',
    SONGS.karma,
    v({ title: 'Karma Police @ Coachella', channelTitle: 'fan cam' }),
    'live',
    null,
    'none',
  ],
  [
    '"@아이디" 언급은 라이브가 아님',
    SONGS.karma,
    v({ title: 'Karma Police (cover by @guitarguy)', channelTitle: 'guitarguy' }),
    'cover',
    null,
    'exact',
  ],
  [
    'Topic 채널의 (Live) 트랙도 라이브 (D-026)',
    SONGS.karma,
    v({ title: 'Karma Police (Live in Berlin)', channelTitle: 'Radiohead - Topic' }),
    'live',
    null,
    'exact',
  ],
  [
    '한국어 라이브',
    SONGS.iu,
    v({ title: '[라이브] 아이유 - 밤편지', channelTitle: 'KBS Kpop' }),
    'live',
    null,
    'exact',
  ],
  ['직캠', SONGS.iu, v({ title: '아이유 밤편지 직캠', channelTitle: 'fan' }), 'live', null, 'none'],
  [
    '일본어 ライブ',
    SONGS.yoasobi,
    v({
      title: 'YOASOBI「夜に駆ける」ライブ',
      channelTitle: 'Ayase / YOASOBI',
      channelId: YOASOBI_CH,
    }),
    'live',
    null,
    'exact',
  ],
  [
    'ドライブ 속 ライブ는 라이브가 아님',
    SONGS.drive,
    v({ title: 'ドライブ', channelTitle: 'Some Artist - Topic' }),
    'official_audio',
    null,
    'exact',
  ],
  [
    'Tiny Desk',
    SONGS.iu,
    v({ title: 'IU: Tiny Desk (Home) Concert', channelTitle: 'NPR Music' }),
    'live',
    null,
    'none',
  ],
  [
    '곡 제목 Live Forever는 라이브가 아님',
    SONGS.oasis,
    v({ title: 'Live Forever', channelTitle: 'Oasis - Topic' }),
    'official_audio',
    null,
    'exact',
  ],
  [
    '곡 제목 Live Forever + 진짜 라이브',
    SONGS.oasis,
    v({
      title: 'Oasis - Live Forever (Live at Knebworth)',
      channelTitle: 'Oasis',
      channelId: OASIS_CH,
    }),
    'live',
    null,
    'exact',
  ],
  [
    '밴드 이름이 Live여도 라이브가 아님',
    SONGS.lightning,
    v({ title: 'Live - Lightning Crashes', channelTitle: 'Live - Topic' }),
    'official_audio',
    null,
    'exact',
  ],
  // --- 커버
  [
    'Cover 표시',
    SONGS.karma,
    v({ title: 'Karma Police - Radiohead (Cover)', channelTitle: 'Guitar Guy' }),
    'cover',
    null,
    'exact',
  ],
  [
    '라이브로 부른 남의 커버는 커버',
    SONGS.karma,
    v({ title: 'Karma Police (Radiohead Cover) Live at Bar', channelTitle: 'Bar Band' }),
    'cover',
    null,
    'none',
  ],
  [
    '한국어 커버',
    SONGS.iu,
    v({ title: '밤편지 커버 (IU)', channelTitle: '노래하는 사람' }),
    'cover',
    null,
    'none',
  ],
  [
    '歌ってみた',
    SONGS.yoasobi,
    v({ title: '【歌ってみた】夜に駆ける / YOASOBI', channelTitle: 'utaite' }),
    'cover',
    null,
    'exact',
  ],
  [
    'カバー',
    SONGS.yoasobi,
    v({ title: '夜に駆ける (カバー)', channelTitle: 'utaite' }),
    'cover',
    null,
    'exact',
  ],
  [
    '공식이 아닌 채널의 재업로드 = 커버로 봄',
    SONGS.karma,
    v({ title: 'Radiohead - Karma Police', channelTitle: 'Best 90s Hits' }),
    'cover',
    null,
    'exact',
  ],
  [
    '곡 제목 Cover Me는 커버가 아님',
    SONGS.springsteen,
    v({ title: 'Cover Me', channelTitle: 'Bruce Springsteen - Topic' }),
    'official_audio',
    null,
    'exact',
  ],
  [
    '곡 제목 Over 안의 글자로 cover를 망가뜨리지 않음',
    SONGS.over,
    v({ title: 'Over (Cover)', channelTitle: 'singer' }),
    'cover',
    null,
    'exact',
  ],
  // --- 리믹스·변형
  [
    'Remix',
    SONGS.bts,
    v({ title: "BTS 'Dynamite' (Tropical Remix)", channelTitle: 'HYBE LABELS', channelId: HYBE }),
    'remix',
    null,
    'exact',
  ],
  [
    'sped up은 공식 채널이라도 리믹스',
    SONGS.karma,
    v({ title: 'Karma Police (sped up)', channelTitle: 'Radiohead', channelId: RH }),
    'remix',
    null,
    'exact',
  ],
  [
    '곡 제목 Up + (Sped Up)은 리믹스',
    SONGS.up,
    v({ title: 'Up (Sped Up)', channelTitle: 'Cardi B - Topic' }),
    'remix',
    null,
    'exact',
  ],
  [
    'slowed + reverb',
    SONGS.iu,
    v({ title: 'IU - 밤편지 (slowed + reverb)', channelTitle: 'lofi vibes' }),
    'remix',
    null,
    'exact',
  ],
  [
    'nightcore',
    SONGS.yoasobi,
    v({ title: 'Nightcore - 夜に駆ける', channelTitle: 'nightcore world' }),
    'remix',
    null,
    'exact',
  ],
  [
    '8D audio',
    SONGS.karma,
    v({ title: 'Radiohead - Karma Police (8D Audio)', channelTitle: '8D Tunes' }),
    'remix',
    null,
    'exact',
  ],
  [
    'Radio Edit도 변형',
    SONGS.bts,
    v({ title: 'Dynamite (Radio Edit)', channelTitle: 'BTS - Topic' }),
    'remix',
    null,
    'exact',
  ],
  [
    'Topic의 (리믹스)',
    SONGS.iu,
    v({ title: '밤편지 (리믹스)', channelTitle: 'IU - Topic' }),
    'remix',
    null,
    'exact',
  ],
  [
    '곡 제목 It이 edit 안의 글자를 지우지 않음 (단어 단위)',
    SONGS.it,
    v({ title: 'It - Radio Edit', channelTitle: 'Some Band - Topic' }),
    'remix',
    null,
    'none',
  ],
  // --- 원곡과 다른 판
  [
    'Topic의 (Inst.)',
    SONGS.iu,
    v({ title: '밤편지 (Inst.)', channelTitle: 'IU - Topic' }),
    'other',
    'alternate_version',
    'exact',
  ],
  [
    'Instrumental',
    SONGS.bts,
    v({ title: 'Dynamite (Instrumental)', channelTitle: 'BTS - Topic' }),
    'other',
    'alternate_version',
    'exact',
  ],
  [
    'Acoustic ver.',
    SONGS.karma,
    v({ title: 'Karma Police (Acoustic ver.)', channelTitle: 'Radiohead - Topic' }),
    'other',
    'alternate_version',
    'exact',
  ],
  [
    'Japanese ver.',
    SONGS.bts,
    v({ title: 'Dynamite (Japanese ver.)', channelTitle: 'BTS - Topic' }),
    'other',
    'alternate_version',
    'exact',
  ],
  // --- 연결하지 않는 것
  [
    'Teaser',
    SONGS.bts,
    v({
      title: "BTS (방탄소년단) 'Dynamite' Official Teaser",
      channelTitle: 'HYBE LABELS',
      channelId: HYBE,
    }),
    'other',
    'not_a_performance',
    'exact',
  ],
  [
    '비하인드',
    SONGS.iu,
    v({ title: "IU '밤편지' MV 비하인드", ...IU_OFFICIAL }),
    'other',
    'not_a_performance',
    'exact',
  ],
  [
    'Reaction',
    SONGS.karma,
    v({ title: 'First time hearing Radiohead - Karma Police REACTION', channelTitle: 'reactor' }),
    'other',
    'not_a_performance',
    'none',
  ],
  [
    '#shorts (길이는 충분)',
    SONGS.bts,
    v({ title: 'Dynamite #shorts', channelTitle: 'BTS - Topic', durationSec: 90 }),
    'other',
    'not_a_performance',
    'exact',
  ],
  [
    '60초 미만',
    SONGS.karma,
    v({ title: 'Karma Police', channelTitle: 'Radiohead - Topic', durationSec: 45 }),
    'other',
    'too_short',
    'exact',
  ],
  [
    '곡 제목 Behind Blue Eyes는 제외 안 함',
    SONGS.behind,
    v({ title: 'Behind Blue Eyes', channelTitle: 'The Who - Topic' }),
    'official_audio',
    null,
    'exact',
  ],
  // --- 피처링
  [
    '피처링 (feat.) Topic',
    SONGS.bieber,
    v({ title: 'Peaches (feat. Daniel Caesar & Giveon)', channelTitle: 'Justin Bieber - Topic' }),
    'official_audio',
    null,
    'exact',
  ],
  [
    '피처링 ft. 공식 MV',
    SONGS.bieber,
    v({
      title: 'Justin Bieber - Peaches ft. Daniel Caesar, Giveon (Official Video)',
      channelTitle: 'Justin Bieber',
      channelId: BIEBER_CH,
    }),
    'official_mv',
    null,
    'exact',
  ],
  // --- 제목·아티스트 분리
  [
    '제목 안에 아티스트 이름 (Killer Queen - Queen)',
    SONGS.killer,
    v({ title: 'Killer Queen - Queen', channelTitle: 'Queen - Topic' }),
    'official_audio',
    null,
    'exact',
  ],
  // --- 다른 곡 (같은 아티스트)
  [
    '같은 아티스트 Topic의 다른 곡',
    SONGS.karma,
    v({ title: 'No Surprises', channelTitle: 'Radiohead - Topic' }),
    'official_audio',
    null,
    'none',
  ],
  [
    '같은 아티스트 공식 MV의 다른 곡',
    SONGS.iu,
    v({ title: '[MV] IU(아이유) _ Palette(팔레트)', ...IU_OFFICIAL }),
    'official_mv',
    null,
    'none',
  ],
  [
    '비슷하지만 다른 제목',
    SONGS.karma,
    v({ title: 'Karma', channelTitle: 'Radiohead - Topic' }),
    'official_audio',
    null,
    'none',
  ],
  [
    '철자가 조금 다름 (비율 ≥ 0.9)',
    SONGS.karma,
    v({ title: 'Karma Polise', channelTitle: 'Radiohead - Topic' }),
    'official_audio',
    null,
    'close',
  ],
];

describe('종류 판별과 곡 일치 예시 표', () => {
  it(`예시가 40개 이상이다 (지금 ${CASES.length}개)`, () => {
    expect(CASES.length).toBeGreaterThanOrEqual(40);
  });

  it.each(CASES)('%s', (_name, song, video, kind, excluded, match) => {
    expect(classify(video, song)).toMatchObject({ kind, excluded });
    expect(titleMatch(video, song).match).toBe(match);
  });
});

describe('곡 일치와 점수', () => {
  it('제목이 그 곡과 맞지 않는 영상(같은 아티스트의 다른 곡)은 후보에서 빠진다', () => {
    const other = v({ title: 'No Surprises', channelTitle: 'Radiohead - Topic', durationSec: 264 });
    expect(rankCandidates([other], SONGS.karma, NO_EXTRAS)).toEqual([]);
  });

  it('다국어 제목 "한글 (English)" 둘 다 곡 제목·별칭과 맞으면 완전 일치', () => {
    const [c] = rankCandidates(
      [
        v({
          title: '[MV] IU(아이유) _ Through the Night(밤편지)',
          ...IU_OFFICIAL,
          durationSec: 255,
        }),
      ],
      SONGS.iu,
      NO_EXTRAS,
    );
    expect(c?.reasons).toEqual(
      expect.arrayContaining(['title_exact', 'official_channel', 'duration']),
    );
  });

  it('로마자 제목도 별칭으로 맞는다 (Yoru ni Kakeru)', () => {
    expect(
      titleMatch(v({ title: 'Yoru ni Kakeru', channelTitle: 'YOASOBI - Topic' }), SONGS.yoasobi)
        .match,
    ).toBe('exact');
  });

  it('레이블 표준 형식(작은따옴표 제목)이 규칙만으로 연결된다', async () => {
    const mv = v({
      videoId: 'dynamite000',
      title: "BTS (방탄소년단) 'Dynamite' Official MV",
      channelTitle: 'HYBE LABELS',
      channelId: HYBE,
      durationSec: 199,
    });
    const judge = vi.fn<Judge>(async () => ({ choice: null }));
    expect(await decideLink(SONGS.bts, [mv], NO_EXTRAS, judge)).toMatchObject({
      status: 'active',
      kind: 'official_mv',
      score: 105,
    });
    expect(judge).not.toHaveBeenCalled();
  });

  it('점수: 완전 일치 50 + 공식 30 + 길이 ±10초 15 + 아티스트 이름 10', () => {
    const [c] = rankCandidates(
      [
        v({
          title: 'Radiohead - Karma Police (Official Audio)',
          channelTitle: 'Radiohead',
          channelId: RH,
          durationSec: 270,
        }),
      ],
      SONGS.karma,
      NO_EXTRAS,
    );
    expect(c?.score).toBe(105);
  });

  it('철자가 조금 다르면 30 (50과 더하지 않음)', () => {
    const [c] = rankCandidates(
      [v({ title: 'Karma Polise', channelTitle: 'Radiohead - Topic', durationSec: 400 })],
      SONGS.karma,
      NO_EXTRAS,
    );
    expect(c?.score).toBe(30 + 30 + 10);
  });

  it('요청 조건에 없는 종류(라이브·커버·리믹스)는 후보에서 빠지고, 조건이 있으면 들어온다', () => {
    const live = v({ title: 'Karma Police (Live)', channelTitle: 'Radiohead', channelId: RH });
    expect(rankCandidates([live], SONGS.karma, NO_EXTRAS)).toEqual([]);
    expect(rankCandidates([live], SONGS.karma, { ...NO_EXTRAS, live: true })).toHaveLength(1);
  });
});

describe('애매함 판정과 AI 호출 (호출 횟수 검증)', () => {
  const audio = v({
    videoId: 'audio000000',
    title: 'Karma Police',
    channelTitle: 'Radiohead - Topic',
    durationSec: 264,
  });
  const mv = v({
    videoId: 'mv000000000',
    title: 'Karma Police (Official Video)',
    channelTitle: 'Radiohead',
    channelId: RH,
    durationSec: 268,
  });
  const covers = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      v({
        videoId: `cover${i}`.padEnd(11, '0'),
        title: 'Karma Police (Cover)',
        channelTitle: `singer ${i}`,
        durationSec: 300 + i,
      }),
    );
  const withCovers = { ...NO_EXTRAS, cover: true };

  it('분명하면 AI를 부르지 않는다', async () => {
    const judge = vi.fn<Judge>(async () => ({ choice: null }));
    expect(await decideLink(SONGS.karma, [audio], NO_EXTRAS, judge)).toEqual({
      status: 'active',
      videoId: 'audio000000',
      kind: 'official_audio',
      score: 105,
      byAi: false,
    });
    expect(judge).not.toHaveBeenCalled();
  });

  it('공식 음원과 공식 MV가 같은 점수여도 애매하지 않다 — 우선순위로 음원 (D-026)', async () => {
    const judge = vi.fn<Judge>(async () => ({ choice: null }));
    const d = await decideLink(SONGS.karma, [mv, audio], NO_EXTRAS, judge);
    expect(d).toMatchObject({ status: 'active', videoId: 'audio000000', kind: 'official_audio' });
    expect(judge).not.toHaveBeenCalled();
  });

  it('1등 점수가 70 미만이면 AI를 한 번 부른다', async () => {
    const judge = vi.fn<Judge>(async () => ({ choice: 'cover000000' }));
    const d = await decideLink(SONGS.karma, covers(1), withCovers, judge);
    expect(judge).toHaveBeenCalledOnce();
    expect(d).toMatchObject({ status: 'active', videoId: 'cover000000', byAi: true });
  });

  it('같은 종류 1·2등 차이가 10 미만이면 AI를 부른다', async () => {
    const mv2 = v({
      videoId: 'mv200000000',
      title: 'Radiohead - Karma Police [Official Music Video] HD',
      channelTitle: 'Radiohead',
      channelId: RH,
      durationSec: 266,
    });
    const ranked = rankCandidates([mv, mv2], SONGS.karma, NO_EXTRAS);
    expect(ranked.map((r) => r.score)).toEqual([105, 105]);
    expect(isAmbiguous(ranked)).toBe(true);
    const judge = vi.fn<Judge>(async () => ({ choice: 'mv200000000' }));
    expect(await decideLink(SONGS.karma, [mv, mv2], NO_EXTRAS, judge)).toMatchObject({
      videoId: 'mv200000000',
      byAi: true,
    });
    expect(judge).toHaveBeenCalledOnce();
  });

  it('점수가 높고 경쟁 후보가 없어도 제목 분리에 실패하면 AI를 부른다', async () => {
    const odd = v({
      videoId: 'odd00000000',
      title: 'Karma Police - Remastered Classics (Official Audio)',
      channelTitle: 'XL Recordings',
      channelId: RH,
      durationSec: 264,
    });
    const [c] = rankCandidates([odd], SONGS.karma, NO_EXTRAS);
    expect(c?.score).toBeGreaterThanOrEqual(70);
    expect(c?.splitFailed).toBe(true);
    const judge = vi.fn<Judge>(async () => ({ choice: null }));
    expect(await decideLink(SONGS.karma, [odd], NO_EXTRAS, judge)).toEqual({
      status: 'rejected',
      reason: 'ai_none',
    });
    expect(judge).toHaveBeenCalledOnce();
  });

  it('AI가 목록에 없는 id나 상위 5개 밖의 후보를 고르면 받지 않는다', async () => {
    for (const choice of ['injected000', 'cover500000']) {
      const judge = vi.fn<Judge>(async () => ({ choice }));
      expect(await decideLink(SONGS.karma, covers(7), withCovers, judge)).toEqual({
        status: 'rejected',
        reason: 'ai_invalid_choice',
      });
    }
  });

  it('애매한데 AI 판정 함수가 없으면 pending_ai (SPEC 3.1)', async () => {
    expect(await decideLink(SONGS.karma, covers(1), withCovers)).toMatchObject({
      status: 'pending_ai',
    });
  });

  it('맞는 후보가 하나도 없으면 AI를 부르지 않고 none', async () => {
    const judge = vi.fn<Judge>(async () => ({ choice: null }));
    const none = [
      v({ title: 'Karma Police teaser', channelTitle: 'Radiohead', channelId: RH }),
      v({ title: 'No Surprises', channelTitle: 'Radiohead - Topic' }),
    ];
    expect(await decideLink(SONGS.karma, none, NO_EXTRAS, judge)).toEqual({ status: 'none' });
    expect(judge).not.toHaveBeenCalled();
  });

  it('AI에는 후보를 최대 5개까지만, 데이터 필드로만 넘긴다', async () => {
    const judge = vi.fn<Judge>(async () => ({ choice: null }));
    await decideLink(SONGS.karma, covers(8), withCovers, judge);
    const input = judge.mock.calls[0]?.[0];
    expect(input?.candidates).toHaveLength(5);
    expect(Object.keys(input?.candidates[0] ?? {}).sort()).toEqual([
      'channelTitle',
      'durationSec',
      'id',
      'kind',
      'title',
    ]);
    expect(Object.keys(input?.song ?? {}).sort()).toEqual([
      'aliases',
      'artist',
      'lengthSec',
      'title',
    ]);
  });
});
