import { createHmac } from 'node:crypto';
import { compareKey } from '@musicweb/shared';
import { Timestamp, type DocumentSnapshot, type Firestore } from 'firebase-admin/firestore';
import { pacificDay } from './day.js';
import type { Locale } from './parseRequest.js';

/**
 * 요청 횟수 집계 (SPEC 4.3b, T42, D-056). 사람 구분 없이 "서로 다른 사람 수"만 센다.
 *
 * - 성공한 요청: 기준 곡 ID·아티스트 MBID·화면 언어 → `requestTally/{kind}_{id}`.
 * - 곡 목록·MusicBrainz 어디에서도 못 찾은 요청: 이름 비교 키의 HMAC → `failedSeedTally/{hmac}`.
 *   이름은 서로 다른 3명이 된 그 요청에서만 `label`로 저장한다(밤 다시 찾기용, T43).
 * - 같은 사람·대상·날짜(태평양)는 한 번만: `requestTallySeen/{hmac}` 표시(2일 뒤 정리). uid 원문은 어디에도 없다.
 * - 하루 단위로 `days{yyyy-mm-dd: 사람 수}`에 쌓고, 오늘 포함 30일만 합한다. 창 밖 날짜는 쓸 때 지운다.
 * - 열쇠는 ACTOR_HASH_KEY에 용도 접두어(`tally:`)를 붙여 쓴다(새 비밀값 없음, parseCache와 같은 방식).
 * - 세 컬렉션 모두 서버 전용(보안 규칙에 match 없음).
 */
export const MIN_PEOPLE = 3;
export const WINDOW_DAYS = 30;
export const SEEN_KEEP_DAYS = 2;
const DAY_MS = 24 * 60 * 60 * 1000;
/** 조회 때 읽는 최대 문서 수(최근 갱신 순). 넘으면 오래된 쪽이 빠진다 */
const SCAN_LIMIT = 5000;

type Days = Record<string, number>;

const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

/** 30일 창의 첫날(오늘 포함 30일) */
export function windowStartDay(now: Date): string {
  // 태평양 날짜에서 날짜 단위로 뺀다(시간으로 빼면 서머타임 전환 주에 창이 하루 길어진다)
  const today = new Date(`${pacificDay(now)}T00:00:00Z`);
  return new Date(today.getTime() - (WINDOW_DAYS - 1) * DAY_MS).toISOString().slice(0, 10);
}

export function peopleInWindow(days: Days | undefined, now: Date): number {
  const start = windowStartDay(now);
  let n = 0;
  for (const [day, v] of Object.entries(days ?? {})) if (day >= start) n += count(v);
  return n;
}

export function prunedDays(days: Days | undefined, now: Date): Days {
  const start = windowStartDay(now);
  return Object.fromEntries(
    Object.entries(days ?? {}).filter(([day, v]) => day >= start && count(v) > 0),
  );
}

/** 3명(기본) 이상만, 사람 수 많은 순, 같으면 ID 순 */
export function rankTally<T extends { id: string; days?: Days }>(
  docs: T[],
  now: Date,
  minPeople = MIN_PEOPLE,
): (T & { people: number })[] {
  return docs
    .map((d) => ({ ...d, people: peopleInWindow(d.days, now) }))
    .filter((d) => d.people >= minPeople)
    .sort((a, b) => b.people - a.people || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function hmac(hashKey: string, data: string): string {
  if (Buffer.byteLength(hashKey, 'utf8') < 32) throw new Error('해시 키가 너무 짧습니다.');
  return createHmac('sha256', hashKey).update(`tally:${data}`).digest('base64url');
}

/** 실패한 이름의 키: 비교 키(대소문자·공백·기호 무시)의 HMAC. 이름이 드러나지 않는다 */
export function failedSeedId(hashKey: string, name: { artist: string; title: string }): string {
  return hmac(hashKey, `fail:${compareKey(name.artist)}\u0000${compareKey(name.title)}`);
}

export interface TallySuccess {
  uid: string;
  songId: string;
  artistMbid: string | null;
  locale: Locale;
}
export interface TallyFailure {
  uid: string;
  artist: string;
  title: string;
}

export interface RequestTally {
  success(hit: TallySuccess): Promise<void>;
  failure(miss: TallyFailure): Promise<void>;
}

export interface RequestTallyReader {
  topSongs(
    limit: number,
    minPeople?: number,
  ): Promise<{ id: string; people: number; locales: Locale[] }[]>;
  topArtists(limit: number, minPeople?: number): Promise<{ id: string; people: number }[]>;
  /** 3명 이상 실패했고 이름이 저장됐으며 다시 찾기를 그만두지 않은 것 */
  failedLabels(limit: number): Promise<
    {
      id: string;
      people: number;
      label: { artist: string; title: string };
      /** 이름이 저장된 시각(30일 못 찾으면 그만, T43) */
      labeledAt: Date | null;
      lastTryAt: Date | null;
    }[]
  >;
}

const SAFE_ID = /^[^/]{1,200}$/;

interface Target {
  /** 중복 확인 표시의 대상 이름 */
  key: string;
  path: string;
  build(prev: DocumentSnapshot, t: Date): object;
}
const LOCALES: Locale[] = ['en', 'ko'];

export function firestoreRequestTally(
  db: Firestore,
  hashKey: string,
  now: () => Date = () => new Date(),
): RequestTally & RequestTallyReader {
  /** 대상마다 오늘 처음 찾은 사람이면 build로 새 문서를 쓴다. 한 트랜잭션 */
  async function bump(uid: string, targets: Target[]) {
    const t = now();
    const day = pacificDay(t);
    const rows = targets.map((x) => ({
      x,
      seen: db.doc(`requestTallySeen/${hmac(hashKey, `seen:${uid}\u0000${x.key}\u0000${day}`)}`),
      ref: db.doc(x.path),
    }));
    await db.runTransaction(async (tx) => {
      const snaps = await tx.getAll(...rows.map((r) => r.seen), ...rows.map((r) => r.ref));
      const seen = snaps.slice(0, rows.length);
      const prev = snaps.slice(rows.length);
      rows.forEach((r, i) => {
        const p = prev[i];
        if (seen[i]?.exists || !p) return;
        tx.set(r.seen, { expiresAt: Timestamp.fromMillis(t.getTime() + SEEN_KEEP_DAYS * DAY_MS) });
        tx.set(r.ref, r.x.build(p, t));
      });
    });
  }

  const addDay = (prev: DocumentSnapshot, field: string, t: Date): Days => {
    const days = { ...((prev.get(field) as Days | undefined) ?? {}) };
    const day = pacificDay(t);
    days[day] = count(days[day]) + 1;
    return prunedDays(days, t);
  };

  return {
    async success(hit) {
      if (!SAFE_ID.test(hit.songId)) throw new Error('곡 ID 형식이 잘못됐습니다.');
      if (hit.artistMbid !== null && !SAFE_ID.test(hit.artistMbid)) {
        throw new Error('아티스트 ID 형식이 잘못됐습니다.');
      }
      const targets: Target[] = [
        {
          key: `song:${hit.songId}`,
          path: `requestTally/song_${hit.songId}`,
          build: (prev: DocumentSnapshot, t: Date) => {
            const locales: Record<string, Days> = {};
            for (const l of LOCALES) {
              const old = (prev.get(`locales.${l}`) as Days | undefined) ?? {};
              const next = l === hit.locale ? addDay(prev, `locales.${l}`, t) : prunedDays(old, t);
              if (Object.keys(next).length) locales[l] = next;
            }
            return {
              kind: 'song',
              id: hit.songId,
              days: addDay(prev, 'days', t),
              locales,
              updatedAt: Timestamp.fromDate(t),
            };
          },
        },
      ];
      if (hit.artistMbid) {
        const id = hit.artistMbid;
        targets.push({
          key: `artist:${id}`,
          path: `requestTally/artist_${id}`,
          build: (prev, t) => ({
            kind: 'artist',
            id,
            days: addDay(prev, 'days', t),
            updatedAt: Timestamp.fromDate(t),
          }),
        });
      }
      await bump(hit.uid, targets);
    },

    async failure(miss) {
      const label = {
        artist: miss.artist.trim().slice(0, 200),
        title: miss.title.trim().slice(0, 200),
      };
      if (!label.artist || !label.title) return;
      const id = failedSeedId(hashKey, label);
      // 이름을 남길지는 날짜별 합계가 아니라 30일 동안 실제로 다른 사람 수로 정한다(한 사람이 사흘 치면 1명).
      // 사람 표시는 (사용자·이름 키)의 HMAC이라 uid로 되돌릴 수 없고, 30일이 지나면 지운다.
      const person = hmac(hashKey, `person:${miss.uid}\u0000${id}`);
      await bump(miss.uid, [
        {
          key: `fail:${id}`,
          path: `failedSeedTally/${id}`,
          build: (prev, t) => {
            const days = addDay(prev, 'days', t);
            const start = windowStartDay(t);
            const people = Object.fromEntries(
              Object.entries(
                (prev.get('people') as Record<string, string> | undefined) ?? {},
              ).filter(([, day]) => typeof day === 'string' && day >= start),
            );
            people[person] = pacificDay(t);
            const old = prev.get('label') as typeof label | null | undefined;
            const gaveUp = prev.get('gaveUp') === true;
            // 서로 다른 3명이 된 그때에만 이름을 남긴다. 그 전에는 이름이 어디에도 없다.
            // 다시 찾기를 그만둔 이름(T43)은 다시 저장하지 않는다
            const labelNow = !old && !gaveUp && Object.keys(people).length >= MIN_PEOPLE;
            return {
              days,
              people,
              label: gaveUp ? null : (old ?? (labelNow ? label : null)),
              labeledAt:
                (prev.get('labeledAt') as Timestamp | null | undefined) ??
                (labelNow ? Timestamp.fromDate(t) : null),
              firstSeenAt:
                (prev.get('firstSeenAt') as Timestamp | undefined) ?? Timestamp.fromDate(t),
              lastTryAt: (prev.get('lastTryAt') as Timestamp | undefined) ?? null,
              gaveUp: prev.get('gaveUp') === true,
              updatedAt: Timestamp.fromDate(t),
            };
          },
        },
      ]);
    },
    ...firestoreTallyReader(db, now),
  };
}

const toDate = (v: unknown): Date | null => (v instanceof Timestamp ? v.toDate() : null);

/** 집계 읽기(서버 비밀 없이). 밤 작업(T43·T44)이 쓴다 */
export function firestoreTallyReader(
  db: Firestore,
  now: () => Date = () => new Date(),
): RequestTallyReader {
  /** 30일 안에 바뀐 문서(최근 순). requestTally는 kind로 나눠 읽는다(firestore.indexes.json의 kind+updatedAt 색인) */
  async function recent(col: string, kind?: 'song' | 'artist'): Promise<Record<string, unknown>[]> {
    const cutoff = Timestamp.fromMillis(now().getTime() - WINDOW_DAYS * DAY_MS);
    const base = kind ? db.collection(col).where('kind', '==', kind) : db.collection(col);
    const snap = await base
      .where('updatedAt', '>=', cutoff)
      .orderBy('updatedAt', 'desc')
      .limit(SCAN_LIMIT)
      .get();
    return snap.docs.map((d) => ({ ...d.data(), docId: d.id }));
  }

  return {
    async topSongs(limit, minPeople = MIN_PEOPLE) {
      const t = now();
      const docs = (await recent('requestTally', 'song')).map((d) => ({
        id: String(d['id']),
        days: d['days'] as Days,
        locales: (d['locales'] ?? {}) as Record<string, Days>,
      }));
      return rankTally(docs, t, minPeople)
        .slice(0, limit)
        .map((d) => ({
          id: d.id,
          people: d.people,
          locales: LOCALES.filter((l) => peopleInWindow(d.locales[l], t) > 0),
        }));
    },

    async topArtists(limit, minPeople = MIN_PEOPLE) {
      const docs = (await recent('requestTally', 'artist')).map((d) => ({
        id: String(d['id']),
        days: d['days'] as Days,
      }));
      return rankTally(docs, now(), minPeople)
        .slice(0, limit)
        .map(({ id, people }) => ({ id, people }));
    },

    async failedLabels(limit) {
      const docs = (await recent('failedSeedTally'))
        .filter((d) => d['label'] && d['gaveUp'] !== true)
        .map((d) => ({
          id: String(d['docId']),
          days: d['days'] as Days,
          label: d['label'] as { artist: string; title: string },
          // 이름 저장 시각이 없는 옛 문서는 처음 센 시각으로 본다(그만 찾기 판단이 끝없이 밀리지 않게)
          labeledAt: toDate(d['labeledAt']) ?? toDate(d['firstSeenAt']),
          lastTryAt: toDate(d['lastTryAt']),
        }));
      return rankTally(docs, now())
        .slice(0, limit)
        .map(({ id, people, label, labeledAt, lastTryAt }) => ({
          id,
          people,
          label,
          labeledAt,
          lastTryAt,
        }));
    },
  };
}

/** 아티스트마다 최근 30일 찾은 사람 수(3명 기준 없이, 순서용). 기록이 없으면 0 */
export async function readArtistPeople(
  db: Firestore,
  mbids: string[],
  now: Date,
): Promise<Map<string, number>> {
  const ids = [...new Set(mbids)].filter((id) => SAFE_ID.test(id));
  const out = new Map<string, number>(ids.map((id) => [id, 0]));
  if (!ids.length) return out;
  const snaps = await db.getAll(...ids.map((id) => db.doc(`requestTally/artist_${id}`)));
  snaps.forEach((snap, i) => {
    const id = ids[i];
    if (id && snap.exists) out.set(id, peopleInWindow(snap.get('days') as Days | undefined, now));
  });
  return out;
}
