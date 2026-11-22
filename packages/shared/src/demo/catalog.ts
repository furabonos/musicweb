/**
 * 에뮬레이터 전용 가짜 곡 목록 (T14). 실제 서비스 데이터가 아니다.
 * - `pnpm emulators:seed`, e2e, 통합 테스트가 이 곡들을 에뮬레이터 Firestore에 넣는다.
 * - 에뮬레이터의 가짜 음악 데이터(functions/src/dev/fakeWorld.ts)는 기준 곡과 비슷한 곡으로 이 목록을 돌려준다.
 * - MBID·영상 ID는 지어낸 값이다(실제 MusicBrainz·YouTube ID 아님). `key`는 songKey(artist, title)와 같아야 한다
 *   (단위 테스트가 확인). 씨앗 도구(tools/seed-emulator.ts)가 공용 패키지를 불러오지 못해 미리 계산해 둔다.
 */
export interface DemoSong {
  mbid: string;
  artist: string;
  artistMbid: string;
  title: string;
  key: string;
  releaseYear: number;
  videoId: string;
}

const song = (
  n: number,
  artist: string,
  artistN: number,
  title: string,
  key: string,
  releaseYear: number,
): DemoSong => ({
  mbid: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  artist,
  artistMbid: `00000000-0000-4000-9000-${String(artistN).padStart(12, '0')}`,
  title,
  key,
  releaseYear,
  videoId: `demoVid${String(n).padStart(4, '0')}`,
});

/** 기준 곡 */
export const DEMO_SEED = song(1, 'Central Cee', 1, 'Doja', 'central cee|doja', 2022);

/** 기준 곡과 비슷한 곡(순서 = 비슷한 정도) */
export const DEMO_SIMILAR: DemoSong[] = [
  song(2, 'Dave & Central Cee', 2, 'Sprinter', 'dave central cee|sprinter', 2023),
  song(3, 'Central Cee', 1, 'Commitment Issues', 'central cee|commitment issues', 2021),
  song(4, 'Tion Wayne & Russ Millions', 3, 'Body', 'tion wayne russ millions|body', 2021),
  song(5, 'Dave', 4, 'Clash', 'dave|clash', 2022),
  song(6, 'AJ Tracey', 5, 'Ladbroke Grove', 'aj tracey|ladbroke grove', 2019),
  song(7, 'Stormzy', 6, 'Vossi Bop', 'stormzy|vossi bop', 2019),
  song(8, 'Dave & AJ Tracey', 7, 'Thiago Silva', 'dave aj tracey|thiago silva', 2016),
  song(9, 'Central Cee', 1, 'Loading', 'central cee|loading', 2021),
  song(10, 'Central Cee', 1, 'Obsessed With You', 'central cee|obsessed with you', 2022),
  song(11, 'Headie One', 8, 'Daily Duppy', 'headie one|daily duppy', 2020),
  song(12, 'Skepta', 9, 'Shutdown', 'skepta|shutdown', 2015),
  song(13, 'Digga D', 10, 'Woi', 'digga d|woi', 2020),
  song(14, 'Unknown T', 11, 'Homerton B', 'unknown t|homerton b', 2019),
  song(15, 'Aitch', 12, 'Taste', 'aitch|taste', 2019),
  song(16, 'Stormzy', 6, 'Shut Up', 'stormzy|shut up', 2015),
];

export const DEMO_SONGS: DemoSong[] = [DEMO_SEED, ...DEMO_SIMILAR];
