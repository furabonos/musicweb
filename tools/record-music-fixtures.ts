/**
 * 음악 데이터 어댑터 테스트용 녹화 응답을 다시 받는다 (T08, D-024).
 *   node --experimental-strip-types tools/record-music-fixtures.ts [파일 이름 ...]   (이름을 주면 그것만)
 *
 * - 무료 공개 API(MusicBrainz, ListenBrainz Labs, Wikidata)에만 요청한다. 키가 필요한 Last.fm은 손으로 만든다.
 * - 요청 사이 1.2초 이상 쉰다(초당 1회 이하, 스킬 music-data-terms).
 * - User-Agent 연락처는 공개 저장소 주소다. 개인 이메일을 넣지 않는다.
 * - 결과는 tests/fixtures/music/에 응답 본문 그대로 저장한다. 상태 코드·헤더는 저장하지 않는다.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const UA = 'musicweb/0.1 ( https://github.com/furabonos/musicweb )';
const OUT = join(import.meta.dirname, '..', 'tests', 'fixtures', 'music');
const MB = 'https://musicbrainz.org/ws/2';
const LABS = 'https://labs.api.listenbrainz.org';
const WD = 'https://query.wikidata.org/sparql';

const RADIOHEAD = 'a74b1b7f-71a5-4011-9441-d0b5e4122711';
const KARMA_POLICE = '9e2ad5bc-c6f9-40d2-a36f-3122ee2072a3'; // ListenBrainz가 쓰는 대표 녹음
const KARMA_POLICE_WORK = 'babefb9d-3d87-3378-bfac-e13f89ae7a48';
export const LB_RECORDING_ALGORITHM =
  'session_based_days_7500_session_300_contribution_5_threshold_15_limit_50_skip_30_top_n_listeners_1000';
export const LB_ARTIST_ALGORITHM =
  'session_based_days_7500_session_300_contribution_5_threshold_10_limit_100_filter_True_skip_30';

const qs = (params: Record<string, string>) => new URLSearchParams(params).toString();

/** 어댑터가 보내는 요청과 같아야 한다(tools/record-music-fixtures.test.ts). */
export const FIXTURES: [string, string][] = [
  [
    'mb-recording-search-karma-police.json',
    `${MB}/recording/?${qs({ query: 'artist:"Radiohead" AND recording:"Karma Police"', fmt: 'json', limit: '5' })}`,
  ],
  [
    'mb-recording-search-iu.json',
    `${MB}/recording/?${qs({ query: 'artist:"IU" AND recording:"밤편지"', fmt: 'json', limit: '3' })}`,
  ],
  [
    'mb-recording-karma-police.json',
    `${MB}/recording/${KARMA_POLICE}?${qs({ inc: 'artist-credits+url-rels+genres+work-rels', fmt: 'json' })}`,
  ],
  [
    'mb-artist-radiohead.json',
    `${MB}/artist/${RADIOHEAD}?${qs({ inc: 'url-rels+genres', fmt: 'json' })}`,
  ],
  [
    'lb-recording-search-karma-police.json',
    `${LABS}/recording-search/json?${qs({ query: 'Radiohead Karma Police' })}`,
  ],
  [
    'lb-similar-recordings-karma-police.json',
    `${LABS}/similar-recordings/json?${qs({ recording_mbids: KARMA_POLICE, algorithm: LB_RECORDING_ALGORITHM })}`,
  ],
  [
    'lb-similar-artists-radiohead.json',
    `${LABS}/similar-artists/json?${qs({ artist_mbids: RADIOHEAD, algorithm: LB_ARTIST_ALGORITHM })}`,
  ],
  [
    'wd-work-karma-police.json',
    `${WD}?${qs({
      query: `SELECT ?item ?work ?yt ?genreLabel ?date WHERE { VALUES ?work { "${KARMA_POLICE_WORK}" } ?item wdt:P435 ?work . OPTIONAL { ?item wdt:P1651 ?yt } OPTIONAL { ?item wdt:P136 ?genre } OPTIONAL { ?item wdt:P577 ?date } SERVICE wikibase:label { bd:serviceParam wikibase:language "en". } }`,
    })}`,
  ],
  [
    'wd-artist-radiohead.json',
    `${WD}?${qs({
      query: `SELECT ?item ?artist ?channel WHERE { VALUES ?artist { "${RADIOHEAD}" } ?item wdt:P434 ?artist . OPTIONAL { ?item wdt:P2397 ?channel } }`,
    })}`,
  ],
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  mkdirSync(OUT, { recursive: true });
  const only = process.argv.slice(2);
  for (const [name, url] of FIXTURES) {
    if (only.length && !only.includes(name)) continue;
    let body = '';
    for (let attempt = 1; attempt <= 3; attempt++) {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: 'application/json, application/sparql-results+json' },
      });
      body = await res.text();
      console.log(`${res.status} ${name} (${body.length} bytes)`);
      if (res.ok) break;
      if (attempt === 3) throw new Error(`${name}: ${res.status}`);
      await sleep(3000 * attempt);
    }
    writeFileSync(join(OUT, name), JSON.stringify(JSON.parse(body), null, 1) + '\n');
    await sleep(1200);
  }
}

// 직접 실행할 때만 요청한다(테스트에서 import할 때는 요청하지 않음).
if (process.argv[1] && import.meta.filename === process.argv[1]) await main();
