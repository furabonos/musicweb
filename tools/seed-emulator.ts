import { DEMO_SONGS } from '../packages/shared/src/demo/catalog.ts';

/**
 * 에뮬레이터 Firestore에 가짜 곡 목록을 넣는다 (T14, D-031).
 * - 화면을 직접 볼 때: `pnpm emulators`를 띄운 채 다른 창에서 `pnpm emulators:seed`.
 * - e2e(apps/web/e2e)도 테스트마다 이 함수로 지우고 다시 넣는다.
 * 에뮬레이터 REST API에 "Bearer owner"로 쓴다(보안 규칙을 건너뜀). 실제 Firebase에는 연결하지 않는다.
 */
export const EMULATOR_PROJECT = 'demo-musicweb';

function base(host: string) {
  return `http://${host}/v1/projects/${EMULATOR_PROJECT}/databases/(default)/documents`;
}

export async function clearEmulatorFirestore(host = '127.0.0.1:8080') {
  const res = await fetch(
    `http://${host}/emulator/v1/projects/${EMULATOR_PROJECT}/databases/(default)/documents`,
    { method: 'DELETE' },
  );
  if (!res.ok) throw new Error(`에뮬레이터 지우기 실패: ${res.status}`);
}

const str = (stringValue: string) => ({ stringValue });

export async function seedDemoCatalog(host = '127.0.0.1:8080', verifiedAt = new Date()) {
  const name = (path: string) =>
    `projects/${EMULATOR_PROJECT}/databases/(default)/documents/${path}`;
  const writes = DEMO_SONGS.flatMap((s) => [
    {
      update: {
        name: name(`songs/${s.mbid}`),
        fields: {
          mbid: str(s.mbid),
          artist: str(s.artist),
          artistMbid: str(s.artistMbid),
          title: str(s.title),
          key: str(s.key),
          releaseYear: { integerValue: String(s.releaseYear) },
          source: str('demo'),
        },
      },
    },
    {
      update: {
        name: name(`songs/${s.mbid}/links/${s.videoId}`),
        fields: {
          videoId: str(s.videoId),
          kind: str('official_audio'),
          status: str('active'),
          linkedBy: str('demo'),
          ytTitle: str(`${s.artist} - ${s.title} (demo)`),
          channelId: str('UCdemo0000000000000000'),
          embeddable: { booleanValue: true },
          madeForKids: { booleanValue: false },
          durationSec: { integerValue: '180' },
          verifiedAt: { timestampValue: verifiedAt.toISOString() },
        },
      },
    },
  ]);
  const res = await fetch(`${base(host)}:commit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner' },
    body: JSON.stringify({ writes }),
  });
  if (!res.ok) throw new Error(`가짜 곡 넣기 실패: ${res.status} ${await res.text()}`);
  return DEMO_SONGS.length;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const host = process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080';
  const n = await seedDemoCatalog(host);
  console.log(`가짜 곡 ${n}곡을 에뮬레이터(${host})에 넣었습니다.`);
}
