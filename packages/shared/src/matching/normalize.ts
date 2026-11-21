/**
 * 제목 정규화 (스킬 song-matching 1장, T09). 비교용이며 저장하지 않는다.
 */

/** 1단계: NFKC(전각→반각), 소문자, 따옴표·대시 통일, 공백 정리. */
export function normalize(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[‘’‚‛′`´]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‐‑‒–—―−]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 비교 키: 정규화 후 글자·숫자만 남긴다("Don't Stop!" ≈ "dont stop").
 * 라틴 글자의 악센트는 지운다("Beyoncé" ≈ "beyonce"). 가나 탁점·한글은 건드리지 않는다(라틴 글자 뒤의 결합 부호만).
 */
export function compareKey(s: string): string {
  return normalize(s)
    .normalize('NFD')
    .replace(/(\p{Script=Latin})\p{M}+/gu, '$1')
    .normalize('NFC')
    .replace(/'/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** 꼬리말: 괄호 안에 있거나 `|` 뒤에 있으면 지운다. 종류 판별 신호로 따로 돌려준다. */
const DECORATION = new RegExp(
  '^(?:' +
    [
      'official\\s+(?:music\\s+)?video',
      'official\\s+audio',
      'official\\s+visuali[sz]er',
      'official\\s+lyric(?:s)?\\s+video',
      'lyric(?:s)?\\s+video',
      'lyrics?',
      'm/?v',
      'audio',
      'visuali[sz]er',
      'hd',
      'hq',
      '4k',
      'remaster(?:ed)?(?:\\s+\\d{4})?',
      '\\d{4}\\s+remaster(?:ed)?',
      'explicit',
      'clean',
      'official',
      '뮤직비디오',
      '공식',
      '公式',
      'ミュージックビデオ',
      'music\\s+video',
    ].join('|') +
    ')$',
  'i',
);

/** 괄호 없이 끝에 붙은 꼬리말 (예: "밤편지 M/V", "'Dynamite' Official MV", "Song - Remastered 2009") */
const LOOSE_TAIL = new RegExp(
  '(?:^|\\s|-)\\s*(?:' +
    [
      'official\\s+(?:music\\s+)?video',
      'official\\s+audio',
      'official\\s+m/?v',
      'official\\s+visuali[sz]er',
      'music\\s+video',
      'lyric(?:s)?\\s+video',
      'm/?v',
      'visuali[sz]er',
      'audio',
      'official',
      'remaster(?:ed)?(?:\\s+\\d{4})?',
      '\\d{4}\\s+remaster(?:ed)?',
      'hd',
      '4k',
      '뮤직비디오',
      '뮤비',
      'ミュージックビデオ',
    ].join('|') +
    ')\\s*$',
  'i',
);

function stripTails(s: string): { rest: string; tails: string[] } {
  const tails: string[] = [];
  let t = s.trim();
  for (let i = 0; i < 5; i++) {
    const m = LOOSE_TAIL.exec(t);
    if (!m || m.index === 0) break;
    tails.push(m[0].replace(/^[\s-]+/, '').trim());
    t = t
      .slice(0, m.index)
      .replace(/[\s-]+$/, '')
      .trim();
  }
  return { rest: t, tails };
}

const BRACKETS = /[([{【「『]([^)\]}】」』]*)[)\]}】」』]/g;
const FEAT = /\s*(?:\(|\[)?\s*\b(?:feat\.?|ft\.?|featuring)\s+([^)\]]+?)\s*(?:\)|\]|$)/i;
const WITH_PAREN = /\s*[([]\s*with\s+([^)\]]+)[)\]]/i;

export interface CleanTitle {
  /** 꼬리말·피처링을 뗀 제목 (정규화됨) */
  core: string;
  /** 지운 꼬리말 (정규화됨). 예: ["official video"] */
  decorations: string[];
  /** 괄호 안에 남은 다른 글(다국어 제목, live 등) */
  bracketed: string[];
  featured: string[];
}

/** 꼬리말·피처링을 떼어 낸다. 괄호 안의 다른 글은 bracketed로 돌려준다(다국어 제목·live 표시 판단용). */
export function cleanTitle(raw: string): CleanTitle {
  let t = normalize(raw);
  const decorations: string[] = [];
  const bracketed: string[] = [];
  const featured: string[] = [];

  // 해시태그(#shorts, #아이유)는 제목이 아니다. 신호 판단용으로 꼬리말에 남긴다.
  t = t.replace(/(^|\s)#[\p{L}\p{N}_]+/gu, (m) => {
    decorations.push(m.trim());
    return ' ';
  });

  // `제목 | Official Video` 같은 꼬리
  const pipeParts = t.split(/\s+\|\s+/);
  t = pipeParts[0] ?? '';
  for (const p of pipeParts.slice(1)) decorations.push(p.trim());

  const withMatch = WITH_PAREN.exec(t);
  if (withMatch?.[1]) {
    featured.push(...splitNames(withMatch[1]));
    t = t.replace(withMatch[0], ' ');
  }

  t = t.replace(BRACKETS, (_all, inner: string) => {
    const v = inner.trim();
    if (!v) return ' ';
    const f = /^(?:feat\.?|ft\.?|featuring)\s+(.+)$/i.exec(v);
    if (f?.[1]) {
      featured.push(...splitNames(f[1]));
      return ' ';
    }
    if (DECORATION.test(v)) {
      decorations.push(v);
      return ' ';
    }
    // 「제목」처럼 괄호가 제목 자체를 감싼 경우는 아래 splitArtistTitle이 처리하도록 표시만 남긴다.
    bracketed.push(v);
    return ` \uE000${bracketed.length - 1}\uE000 `;
  });

  const feat = FEAT.exec(t);
  if (feat?.[1]) {
    featured.push(...splitNames(feat[1]));
    t = t.slice(0, feat.index);
  }

  // 괄호 자리 표시를 없앤 핵심 제목, 끝에 괄호 없이 붙은 꼬리말도 뗀다
  const joined = t
    .replace(/\uE000\d+\uE000/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-:_]+|[\s\-:_]+$/g, '')
    .trim();
  const { rest, tails } = stripTails(joined);
  decorations.push(...tails);
  return { core: rest, decorations, bracketed, featured };
}

/** 괄호 없이 붙은 꼬리말(예: 「제목」Official Music Video)을 지운다. */
function stripLooseDecorations(s: string): string {
  return stripTails(s).rest;
}

/** Topic 채널(YouTube 자동 생성 음원 채널) 이름에서 아티스트 부분. Topic이 아니면 null. */
export function topicArtist(channelTitle: string): string | null {
  const m = /^(.*?)\s*-\s*topic$/i.exec(normalize(channelTitle));
  return m?.[1] ? m[1] : null;
}

function splitNames(s: string): string[] {
  return s
    .split(/\s*(?:,|&|\bx\b|\band\b)\s*/i)
    .map((n) => n.trim())
    .filter(Boolean);
}

export interface SplitTitle {
  /** 곡 제목 후보들 (정규화됨). 다국어 제목이면 여러 개 */
  titles: string[];
  /** 제목에서 찾은 아티스트 부분 (없으면 null) */
  artistPart: string | null;
  /** 아티스트·제목을 나누지 못함 (애매함 판정에 씀) */
  failed: boolean;
}

/**
 * `아티스트 - 제목` / `제목 - 아티스트` / `아티스트 「제목」` / 채널이 아티스트면 제목 전체.
 * 다국어 제목 `한글제목 (English Title)`은 둘 다 후보로 남긴다.
 */
export function splitArtistTitle(
  videoTitle: string,
  channelTitle: string,
  artistNames: string[],
): SplitTitle {
  const artistKeys = artistNames.map(compareKey).filter(Boolean);
  const isArtist = (s: string) => {
    const k = compareKey(s);
    return (
      k.length > 0 &&
      artistKeys.some((a) => k === a || k.split(' ').join('') === a.split(' ').join(''))
    );
  };
  const containsArtist = (s: string) => {
    const k = ` ${compareKey(s)} `;
    return artistKeys.some((a) => k.includes(` ${a} `));
  };

  // 아티스트 쪽인지: 핵심 이름이나 괄호 안 이름(예: "IU(아이유)")이 아티스트와 같거나 포함
  const sideIsArtist = (side: string) => {
    const c = cleanTitle(side);
    return [c.core, ...c.bracketed].some((n) => isArtist(n) || containsArtist(n));
  };

  // 「제목」『제목』: 괄호 안이 제목
  const jp = /^(.*?)[「『](.+?)[」』](.*)$/.exec(normalize(videoTitle));
  if (jp?.[2]) {
    const inner = cleanTitle(jp[2]);
    const outside = stripLooseDecorations(cleanTitle(`${jp[1] ?? ''} ${jp[3] ?? ''}`).core);
    return { titles: withAlternates(inner), artistPart: outside || null, failed: false };
  }

  // 'Dynamite' / "Dynamite": 따옴표 안이 제목 (단어 사이 아포스트로피 "Don't"는 해당 없음)
  const quoted = /(?:^|\s)(['"])([^'"]+)\1(?=\s|$)/.exec(normalize(videoTitle));
  if (quoted?.[2]) {
    const inner = cleanTitle(quoted[2]);
    const outside = stripLooseDecorations(
      cleanTitle(normalize(videoTitle).replace(quoted[0], ' ')).core,
    );
    return { titles: withAlternates(inner), artistPart: outside || null, failed: false };
  }

  // `제목 | Official Video` 꼬리는 먼저 떼고, 구분자(" - ", " / ", " _ ")로 나눈 뒤 쪽마다 정리한다
  // (괄호가 어느 쪽 것인지 지키기 위함). 꼬리말뿐인 쪽(예: "- Remastered 2009")은 버린다.
  const base = normalize(videoTitle).split(/\s+\|\s+/)[0] ?? '';
  const parts = base
    .split(/\s+[-/_]\s+/)
    .map((p) => p.trim())
    .filter((p) => p && !DECORATION.test(p));
  const clean = cleanTitle(parts.join(' - '));
  const channelIsArtist = isArtist(topicArtist(channelTitle) ?? channelTitle);

  if (parts.length >= 2) {
    const first = parts[0] ?? '';
    const last = parts[parts.length - 1] ?? '';
    const rest = cleanTitle(parts.slice(1).join(' - '));
    const head = cleanTitle(parts.slice(0, -1).join(' - '));
    // 둘 다 아티스트처럼 보이면("Killer Queen - Queen") 정확히 아티스트 이름인 쪽을 고른다.
    const exactFirst = isArtist(cleanTitle(first).core);
    const exactLast = isArtist(cleanTitle(last).core);
    if (exactLast && !exactFirst) {
      return { titles: withAlternates(head), artistPart: last, failed: false };
    }
    if (exactFirst || sideIsArtist(first)) {
      return { titles: withAlternates(rest), artistPart: first, failed: false };
    }
    if (sideIsArtist(last)) {
      return { titles: withAlternates(head), artistPart: last, failed: false };
    }
    if (channelIsArtist) return { titles: withAlternates(clean), artistPart: null, failed: false };
    // 어느 쪽이 아티스트인지 모름: 둘 다 후보로 두고 실패 표시
    return {
      titles: [rest.core, cleanTitle(first).core].filter(Boolean),
      artistPart: null,
      failed: true,
    };
  }
  if (channelIsArtist || containsArtist(channelTitle)) {
    return { titles: withAlternates(clean), artistPart: null, failed: false };
  }
  return { titles: withAlternates(clean), artistPart: null, failed: !clean.core };
}

/**
 * 핵심 제목 + 괄호 안의 다른 이름(다국어 제목). live 같은 신호 단어가 든 괄호는 제목 후보에서 뺀다.
 * 아티스트 이름 괄호("IU(아이유)")는 splitArtistTitle이 아티스트 쪽으로 떼어 내므로 여기 오지 않는다.
 */
function withAlternates(c: CleanTitle): string[] {
  const out = [c.core];
  for (const b of c.bracketed) {
    if (!SIGNAL_ONLY.test(b)) out.push(cleanTitle(b).core);
  }
  return [...new Set(out.map((t) => t.trim()).filter(Boolean))];
}

const SIGNAL_ONLY =
  /\b(live|concert|session|cover|remix|rmx|edit|bootleg|sped\s*up|slowed|nightcore|8d|acoustic|ver\.?|version|teaser|trailer|inst\.?|instrumental|mr|karaoke|demo|fancam)\b|라이브|커버|리믹스|직캠|ライブ|ライヴ|カバー|リミックス|歌ってみた|弾いてみた/i;

/** 편집 거리 비율: 1 - 거리/긴 쪽 길이 (0~1). */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const s = [...a];
  const t = [...b];
  if (!s.length || !t.length) return 0;
  let prev = Array.from({ length: t.length + 1 }, (_, i) => i);
  for (let i = 1; i <= s.length; i++) {
    const cur = [i];
    for (let j = 1; j <= t.length; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      cur[j] = Math.min((prev[j] ?? 0) + 1, (cur[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    prev = cur;
  }
  return 1 - (prev[t.length] ?? 0) / Math.max(s.length, t.length);
}
