/**
 * 이유 문장 (SPEC 4.3 5단계, T30, D-047). 겹치는 태그(최대 2개)와 같은 연도대로 한 줄을 조립한다.
 * - 태그는 낱말 목록(vocab)의 낱말뿐이라 자유 글이 들어가지 않는다. 화면은 글자로만 그린다.
 * - HTML 특수문자(< > " ' &)를 넣지 않는다: 'r&b'는 'R and B'로 쓴다.
 * - 겹치는 태그가 없으면 null(호출하는 쪽이 출처 문장을 쓴다).
 */
const DISPLAY: Record<string, string> = {
  'r&b': 'R and B',
  'contemporary r&b': 'contemporary R and B',
  'alternative r&b': 'alternative R and B',
  'k pop': 'K-pop',
  'j pop': 'J-pop',
  'c pop': 'C-pop',
  'j rock': 'J-rock',
  'k hip hop': 'K-hip hop',
  'k ballad': 'K-ballad',
  'hip hop': 'hip-hop',
  edm: 'EDM',
  idm: 'IDM',
  mpb: 'MPB',
  'uk garage': 'UK garage',
  'uk drill': 'UK drill',
  'lo fi': 'lo-fi',
};

export function tagLabel(word: string): string {
  return (DISPLAY[word] ?? word).replace(/[<>"'&]/g, '');
}

/** 1910~1990년대만 두 자리(90년대·90s), 나머지는 네 자리(1900년대·2000s) — 1900년대가 2000년대와 헷갈리지 않게 */
const decadeLabel = (decade: number, locale: 'en' | 'ko') => {
  const short = decade >= 1910 && decade <= 1990;
  const n = short ? String(decade % 100) : String(decade);
  return locale === 'ko' ? `${n}년대` : `${n}s`;
};

export function tagReason(
  tags: readonly string[],
  sharedDecade: number | null,
  locale: 'en' | 'ko',
): string | null {
  const shown = tags.slice(0, 2).map(tagLabel).filter(Boolean);
  if (!shown.length) return null;
  if (locale === 'ko') {
    return sharedDecade
      ? `${shown.join('·')} 느낌이 비슷하고 같은 ${decadeLabel(sharedDecade, 'ko')}에 나온 곡이에요.`
      : `${shown.join('·')} 느낌이 비슷한 곡이에요.`;
  }
  const when = sharedDecade ? `, also from the ${decadeLabel(sharedDecade, 'en')}` : '';
  return `Similar ${shown.join(' · ')} sound${when}.`;
}
