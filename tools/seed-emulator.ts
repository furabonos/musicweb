import { DEMO_SONGS } from '../packages/shared/src/demo/catalog.ts';
import { compareKey } from '../packages/shared/src/matching/normalize.ts';

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
          titleKey: str(compareKey(s.title)),
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

/** e2e용: 재생목록 문서와 비공개 문서(검색 문장)를 직접 넣는다. items는 가짜 곡 목록의 순서 번호. */
export async function seedPlaylist(
  opts: { id: string; state: 'draft' | 'saved'; songs: number[]; privateText: string },
  host = '127.0.0.1:8080',
) {
  const name = (path: string) =>
    `projects/${EMULATOR_PROJECT}/databases/(default)/documents/${path}`;
  const seed = DEMO_SONGS[0];
  const items = opts.songs.map((n) => {
    const s = DEMO_SONGS[n];
    if (!s) throw new Error(`가짜 곡 ${n}번이 없습니다.`);
    return {
      mapValue: {
        fields: {
          songId: str(s.mbid),
          artist: str(s.artist),
          title: str(s.title),
          reason: str(`Demo reason for ${s.title}`),
        },
      },
    };
  });
  const no = { booleanValue: false };
  const writes = [
    {
      update: {
        name: name(`playlists/${opts.id}`),
        fields: {
          ownerUid: str('e2e-owner'),
          title: str(`${seed?.title} — ${seed?.artist}`),
          seed: {
            mapValue: {
              fields: {
                songId: str(seed?.mbid ?? ''),
                artist: str(seed?.artist ?? ''),
                title: str(seed?.title ?? ''),
              },
            },
          },
          items: { arrayValue: { values: items } },
          include: { mapValue: { fields: { live: no, cover: no, remix: no } } },
          locale: str('en'),
          state: str(opts.state),
        },
      },
    },
    {
      update: {
        name: name(`playlists/${opts.id}/private/request`),
        fields: { text: str(opts.privateText) },
      },
    },
  ];
  await commit(host, writes);
}

/** e2e용: config/runtime의 필드를 바꾼다(다른 필드는 그대로). savingMode: 오늘(태평양) 절약 모드 켜기(T22b) */
export async function setRuntime(
  fields: { youtubeOpenLink?: 'direct' | 'fallback'; savingMode?: boolean },
  host = '127.0.0.1:8080',
) {
  const doc: Record<string, unknown> = {};
  if (fields.youtubeOpenLink) doc.youtubeOpenLink = str(fields.youtubeOpenLink);
  if (fields.savingMode) {
    const day = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Los_Angeles',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
    doc.savingMode = toValue({
      active: true,
      day,
      since: new Date(),
      reason: 'ai_limit',
      limitAtStart: 3_000_000,
    });
  }
  await commit(host, [
    {
      update: {
        name: `projects/${EMULATOR_PROJECT}/databases/(default)/documents/config/runtime`,
        fields: doc,
      },
      updateMask: { fieldPaths: Object.keys(doc) },
    },
  ]);
}

/** JS 값 → Firestore REST 값 (e2e 시드용: 문자열·숫자·불·null·Date·배열·객체) */
function toValue(v: unknown): unknown {
  if (v === null) return { nullValue: null };
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number')
    return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toValue) } };
  if (typeof v === 'object') {
    return {
      mapValue: {
        fields: Object.fromEntries(Object.entries(v as object).map(([k, x]) => [k, toValue(x)])),
      },
    };
  }
  throw new Error(`시드에 넣을 수 없는 값: ${String(v)}`);
}

/** e2e·화면 보기용: 현황판 문서(metrics/current)와 운영 일지 줄을 넣는다 (T21). */
export async function seedStatus(
  data: { current: Record<string, unknown>; opsLog: Record<string, unknown>[] },
  host = '127.0.0.1:8080',
) {
  const name = (path: string) =>
    `projects/${EMULATOR_PROJECT}/databases/(default)/documents/${path}`;
  const fields = (o: Record<string, unknown>) =>
    (toValue(o) as { mapValue: { fields: unknown } }).mapValue.fields;
  await commit(host, [
    { update: { name: name('metrics/current'), fields: fields(data.current) } },
    ...data.opsLog.map((e, i) => ({
      update: { name: name(`opsLog/e2e${i}`), fields: fields(e) },
    })),
  ]);
}

async function commit(host: string, writes: unknown[]) {
  const res = await fetch(`${base(host)}:commit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner' },
    body: JSON.stringify({ writes }),
  });
  if (!res.ok) throw new Error(`에뮬레이터 쓰기 실패: ${res.status} ${await res.text()}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const host = process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080';
  const n = await seedDemoCatalog(host);
  console.log(`가짜 곡 ${n}곡을 에뮬레이터(${host})에 넣었습니다.`);
}
