import {
  cleanTitle,
  compareKey,
  normalize,
  similarity,
  splitArtistTitle,
  topicArtist,
} from './normalize.js';

/**
 * 곡 ↔ YouTube 영상 연결 (스킬 song-matching 2·3장, T09, D-026).
 * 규칙이 먼저이고, 애매한 것만 AI 판정 함수(judge)에 넘긴다. judge는 후보 ID 중 하나 또는 null만 돌려줄 수 있다.
 */

export type LinkKind = 'official_audio' | 'official_mv' | 'live' | 'cover' | 'remix' | 'other';

export interface SongRef {
  title: string;
  /** MusicBrainz 별칭·다국어 제목 */
  aliases?: string[];
  artist: string;
  artistAliases?: string[];
  /** MusicBrainz 녹음 길이 */
  lengthMs?: number | null;
  /** MB URL 관계·Wikidata P2397로 찾은 공식 채널 ID */
  officialChannelIds?: string[];
}

export interface VideoCandidate {
  videoId: string;
  title: string;
  channelId: string;
  channelTitle: string;
  description?: string;
  durationSec: number | null;
}

/** 요청 조건: 라이브·커버·리믹스 포함 여부 (SPEC 4.2) */
export interface Include {
  live: boolean;
  cover: boolean;
  remix: boolean;
}
export const NO_EXTRAS: Include = { live: false, cover: false, remix: false };

export interface Classification {
  kind: LinkKind;
  /** 연결하지 않는 이유 (티저·쇼츠·60초 미만 등). 있으면 후보에서 뺀다. */
  excluded: string | null;
  official: boolean;
}

// 가나 단어 안의 글자 덩어리(예: ドライブ 속 ライブ)는 신호가 아니다. 한글은 붙여 쓰는 말("라이브클립")이 많아 덩어리로 찾는다.
const kana = (w: string) =>
  new RegExp(`(?<!\\p{Script=Katakana})${w}(?!\\p{Script=Katakana})`, 'u');

const LIVE = [
  /\blive\b/,
  /\bconcert\b/,
  /\bsession(s)?\b/,
  /\btiny desk\b/,
  /\bunplugged\b/,
  /\bfancam\b/,
  /라이브/,
  /직캠/,
  kana('ライ[ブヴ]'),
  // "@ 장소" (뒤에 공백). "@아이디" 같은 언급은 아니다.
  /\s@\s\S/,
];
const COVER = [/\bcover(ed)?\b/, /커버/, /歌ってみた/, /弾いてみた/, kana('カバー')];
const REMIX = [
  /\bremix(ed)?\b/,
  /\brmx\b/,
  /\bedit\b/,
  /\bbootleg\b/,
  /\bsped\s*up\b/,
  /\bslowed\b/,
  /\bnightcore\b/,
  /\b8d\b/,
  /\breverb\b/,
  /리믹스/,
  kana('リミックス'),
];
const EXCLUDE = [
  /\bteaser\b/,
  /\btrailer\b/,
  /\bbehind\b/,
  /\bmaking\b/,
  /\binterview\b/,
  /\breaction\b/,
  /#?\bshorts\b/,
  /티저/,
  /비하인드/,
  /메이킹/,
  /리액션/,
  /인터뷰/,
  /예고/,
  /予告/,
  kana('ティザー'),
  kana('メイキング'),
];
/** 원곡과 다른 판: 반주·노래방·어쿠스틱·데모·다른 언어판. 원곡 자리에 쓰지 않는다. */
const ALTERNATE = [
  /\binst(rumental)?\b\.?/,
  /\bmr\b/,
  /\bkaraoke\b/,
  /\boff vocal\b/,
  /\bacoustic\b/,
  /\bdemo\b/,
  /\b(japanese|korean|english|chinese|jp|kr|eng)\s+ver(sion)?\b/,
  /반주/,
  /노래방/,
  kana('カラオケ'),
];
const AUDIO = [/\bofficial audio\b/, /\baudio\b/, /\bvisuali[sz]er\b/, /\blyric(s)? video\b/];
const MV = [
  /\bofficial (music )?video\b/,
  /\bofficial m\/?v\b/,
  /\bmusic video\b/,
  /\bm\/?v\b/,
  /뮤직비디오/,
  /뮤비/,
  kana('ミュージックビデオ'),
];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** 단어 경계(앞뒤가 글자·숫자가 아님)로만 지운다. */
function removeWord(text: string, word: string): string {
  const w = normalize(word);
  if (!w) return text;
  return text.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(w)}(?![\\p{L}\\p{N}])`, 'gu'), ' ');
}

/**
 * 종류 신호를 찾을 글. 곡 제목·아티스트 이름에 든 단어는 신호로 보지 않는다("Live Forever", "Cover Me", 밴드 Live).
 * 제목은 핵심 부분에서만 단어 단위로 지우고, 괄호·꼬리말은 괄호 전체가 곡 제목일 때만 지운다
 * ("Up (Sped Up)"의 괄호는 남겨야 리믹스로 잡힌다).
 */
function signalText(video: VideoCandidate, song: SongRef): string {
  const c = cleanTitle(video.title);
  const names = [song.title, ...(song.aliases ?? []), ...artistNames(song)];
  let core = c.core;
  for (const n of names) core = removeWord(core, n);
  const nameKeys = names.map((n) => compareKey(n));
  const brackets = c.bracketed.filter((b) => !nameKeys.includes(compareKey(b)));
  return ` ${[core, ...brackets, ...c.decorations].join(' | ')} `;
}

const any = (res: RegExp[], s: string) => res.some((r) => r.test(s));

function artistNames(song: SongRef): string[] {
  return [song.artist, ...(song.artistAliases ?? [])].filter(Boolean);
}

function channelArtistMatches(channelTitle: string, song: SongRef): boolean {
  const ch = compareKey((topicArtist(channelTitle) ?? channelTitle).replace(/vevo$/i, ''));
  return artistNames(song).some((a) => {
    const k = compareKey(a);
    return k.length > 0 && (ch === k || ch.replace(/ /g, '') === k.replace(/ /g, ''));
  });
}

export function classify(video: VideoCandidate, song: SongRef): Classification {
  const sig = signalText(video, song);
  const isTopic = topicArtist(video.channelTitle) !== null;
  const provided = /^\s*provided to youtube by\b/i.test(video.description ?? '');
  const ownChannel = (song.officialChannelIds ?? []).includes(video.channelId);
  const artistChannel = channelArtistMatches(video.channelTitle, song);
  // Topic은 그 곡 아티스트의 Topic일 때만 공식 음원이다(다른 가수의 Topic = 커버).
  // "Provided to YouTube by" 설명은 재업로드가 그대로 복사하기 쉬워서, 공식 채널 ID와 함께일 때만 인정한다.
  const autoAudio = (isTopic && artistChannel) || (provided && ownChannel);
  const official = ownChannel || autoAudio;

  if (video.durationSec !== null && video.durationSec < 60) {
    return { kind: 'other', excluded: 'too_short', official };
  }
  if (any(EXCLUDE, sig)) return { kind: 'other', excluded: 'not_a_performance', official };
  // 변형(리믹스 → 커버 → 라이브) 표시는 공식·자동 음원보다 먼저 본다(D-026): Topic의 "(Live)" 트랙은 라이브다.
  // 커버를 라이브보다 먼저: 남이 라이브로 부른 커버는 커버다.
  if (any(REMIX, sig)) return { kind: 'remix', excluded: null, official };
  if (any(COVER, sig)) return { kind: 'cover', excluded: null, official: false };
  if (any(LIVE, sig)) return { kind: 'live', excluded: null, official };
  if (any(ALTERNATE, sig)) return { kind: 'other', excluded: 'alternate_version', official };
  if (autoAudio) return { kind: 'official_audio', excluded: null, official: true };
  if (ownChannel && any(AUDIO, sig))
    return { kind: 'official_audio', excluded: null, official: true };
  if (ownChannel && any(MV, sig)) return { kind: 'official_mv', excluded: null, official: true };
  if (ownChannel) return { kind: 'other', excluded: 'unlabeled_official_upload', official: true };
  // 공식이 아닌 채널의 그 곡 = 재업로드·커버로 본다(채널이 아티스트와 무관).
  return { kind: 'cover', excluded: null, official: false };
}

export function kindAllowed(kind: LinkKind, include: Include): boolean {
  switch (kind) {
    case 'official_audio':
    case 'official_mv':
      return true;
    case 'live':
      return include.live;
    case 'cover':
      return include.cover;
    case 'remix':
      return include.remix;
    default:
      return false;
  }
}

export interface ScoredCandidate {
  video: VideoCandidate;
  kind: LinkKind;
  score: number;
  splitFailed: boolean;
  /** 점수 근거 (테스트·로그용) */
  reasons: string[];
}

/** 후보 점수. 종류가 요청과 맞지 않거나 연결하지 않는 영상이면 null(후보 제외). */
export function scoreCandidate(
  video: VideoCandidate,
  song: SongRef,
  include: Include,
): ScoredCandidate | null {
  const c = classify(video, song);
  if (c.excluded || !kindAllowed(c.kind, include)) return null;

  const reasons: string[] = [];
  let score = 0;
  const { match, splitFailed } = titleMatch(video, song);
  // 곡 제목이 맞지 않으면 그 곡의 영상이 아니다(같은 아티스트의 다른 곡 등). 후보에서 뺀다.
  if (match === 'none') return null;
  if (match === 'exact') {
    score += 50;
    reasons.push('title_exact');
  } else {
    score += 30;
    reasons.push('title_close');
  }
  if (c.official) {
    score += 30;
    reasons.push('official_channel');
  }
  if (
    song.lengthMs &&
    video.durationSec !== null &&
    Math.abs(song.lengthMs / 1000 - video.durationSec) <= 10
  ) {
    score += 15;
    reasons.push('duration');
  }
  const hay = ` ${compareKey(video.title)} ${compareKey(video.channelTitle)} `;
  if (artistNames(song).some((a) => compareKey(a) && hay.includes(` ${compareKey(a)} `))) {
    score += 10;
    reasons.push('artist_named');
  }
  return { video, kind: c.kind, score, splitFailed, reasons };
}

export type TitleMatch = 'exact' | 'close' | 'none';

/** 영상 제목이 그 곡의 제목(또는 별칭)과 맞는가: 완전 일치 / 편집 거리 비율 ≥ 0.9 / 아님 */
export function titleMatch(
  video: VideoCandidate,
  song: SongRef,
): { match: TitleMatch; splitFailed: boolean } {
  const split = splitArtistTitle(video.title, video.channelTitle, artistNames(song));
  const songKeys = [song.title, ...(song.aliases ?? [])]
    .map((t) => compareKey(cleanTitle(t).core))
    .filter(Boolean);
  const titleKeys = split.titles.map(compareKey).filter(Boolean);
  if (titleKeys.some((t) => songKeys.includes(t)))
    return { match: 'exact', splitFailed: split.failed };
  const best = Math.max(0, ...titleKeys.flatMap((t) => songKeys.map((k) => similarity(t, k))));
  return { match: best >= 0.9 ? 'close' : 'none', splitFailed: split.failed };
}

/** 종류 우선순위: 점수가 같으면 official_audio > official_mv > 나머지 */
const KIND_RANK: Record<LinkKind, number> = {
  official_audio: 0,
  official_mv: 1,
  live: 2,
  remix: 2,
  cover: 3,
  other: 9,
};

export function rankCandidates(
  videos: VideoCandidate[],
  song: SongRef,
  include: Include,
): ScoredCandidate[] {
  return videos
    .map((v) => scoreCandidate(v, song, include))
    .filter((c): c is ScoredCandidate => c !== null)
    .sort((a, b) => b.score - a.score || KIND_RANK[a.kind] - KIND_RANK[b.kind]);
}

export const AMBIGUOUS_TOP_BELOW = 95;
export const AMBIGUOUS_GAP_BELOW = 10;

/**
 * 애매함 판정: 1등 < 70, 1·2등 차이 < 10, 1등 제목 분리 실패.
 * 차이는 우선순위가 같은 종류끼리만 본다: 같은 아티스트의 공식 음원과 공식 MV가 비슷한 점수인 것은 애매한 게 아니라
 * SPEC 3.1 우선순위(official_audio > official_mv)로 정해진다(D-026).
 */
export function isAmbiguous(ranked: ScoredCandidate[]): boolean {
  const [first] = ranked;
  if (!first) return false;
  if (first.score < AMBIGUOUS_TOP_BELOW) return true;
  const rival = ranked.slice(1).find((c) => KIND_RANK[c.kind] === KIND_RANK[first.kind]);
  if (rival && first.score - rival.score < AMBIGUOUS_GAP_BELOW) return true;
  return first.splitFailed;
}

/** AI 판정에 넘기는 데이터. 영상 제목·채널 이름은 외부 글이므로 판정 함수는 이것을 데이터로만 다뤄야 한다. */
export interface JudgeInput {
  song: { title: string; artist: string; aliases: string[]; lengthSec: number | null };
  candidates: {
    id: string;
    title: string;
    channelTitle: string;
    durationSec: number | null;
    kind: LinkKind;
  }[];
}
/** 후보 id 중 하나 또는 null("맞는 것 없음")만 돌려준다. */
export type Judge = (input: JudgeInput) => Promise<{ choice: string | null }>;

export const MAX_JUDGE_CANDIDATES = 5;

export type Decision =
  | { status: 'active'; videoId: string; kind: LinkKind; score: number; byAi: boolean }
  | { status: 'pending_ai'; candidates: ScoredCandidate[] }
  | { status: 'rejected'; reason: 'ai_none' | 'ai_invalid_choice' }
  | { status: 'none' };

/**
 * 규칙으로 고르고, 애매하면 judge에 넘긴다. judge가 없으면 pending_ai(SPEC 3.1).
 * judge가 후보 밖의 id를 돌려주면 받지 않는다(rejected).
 */
export async function decideLink(
  song: SongRef,
  videos: VideoCandidate[],
  include: Include = NO_EXTRAS,
  judge?: Judge,
): Promise<Decision> {
  const ranked = rankCandidates(videos, song, include);
  const first = ranked[0];
  if (!first) return { status: 'none' };
  if (!isAmbiguous(ranked)) {
    return {
      status: 'active',
      videoId: first.video.videoId,
      kind: first.kind,
      score: first.score,
      byAi: false,
    };
  }
  const top = ranked.slice(0, MAX_JUDGE_CANDIDATES);
  if (!judge) return { status: 'pending_ai', candidates: top };
  const { choice } = await judge({
    song: {
      title: song.title,
      artist: song.artist,
      aliases: song.aliases ?? [],
      lengthSec: song.lengthMs ? Math.round(song.lengthMs / 1000) : null,
    },
    candidates: top.map((c) => ({
      id: c.video.videoId,
      title: c.video.title,
      channelTitle: c.video.channelTitle,
      durationSec: c.video.durationSec,
      kind: c.kind,
    })),
  });
  if (choice === null) return { status: 'rejected', reason: 'ai_none' };
  const picked = top.find((c) => c.video.videoId === choice);
  if (!picked) return { status: 'rejected', reason: 'ai_invalid_choice' };
  return {
    status: 'active',
    videoId: picked.video.videoId,
    kind: picked.kind,
    score: picked.score,
    byAi: true,
  };
}
