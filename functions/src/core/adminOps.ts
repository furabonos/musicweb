import { FieldValue, Timestamp, type Firestore, type Transaction } from 'firebase-admin/firestore';
import { pacificDay } from './day.js';
import { JOBS } from './events.js';
import { addOpsLogInTx } from './opsLog.js';
import { readRuntimeConfig, SERVICE_COUNTERS } from './runtimeConfig.js';

/**
 * 관리자 작업 (SPEC 4.11, T22, D-043). api/admin.ts가 관리자 확인 뒤 부른다.
 * - 바꾸는 작업은 모두 한 트랜잭션에서 대상 문서·adminAudit(누가·언제·전후)·운영 일지(admin_change)를 함께 쓴다.
 * - 운영 일지는 누구나 읽으므로 uid·이메일·곡 이름을 넣지 않는다. 대상은 adminAudit(관리자만 읽음)에 있다.
 * - 검색 문장·재생목록 내용은 여기서 읽지 않는다(SPEC 4.11 보안).
 */
export class AdminOpError extends Error {
  override name = 'AdminOpError';
  constructor(
    readonly reason:
      | 'artistExists'
      | 'artistNotFound'
      | 'linkNotFound'
      | 'linkStale'
      | 'linkNotPlayable'
      | 'badTransition'
      | 'testersFull',
  ) {
    super(`admin: ${reason}`);
  }
}

export const MAX_TESTERS = 100;
/** 연결을 다시 켤 때 이만큼 안에 확인된 것만 (재확인 25일 규칙, D-004) */
const FRESH_MS = 25 * 24 * 60 * 60 * 1000;

function audit(
  db: Firestore,
  tx: Transaction,
  adminUid: string,
  action: string,
  before: unknown,
  after: unknown,
  message: string,
  target?: Record<string, string>,
) {
  tx.create(db.collection('adminAudit').doc(), {
    adminUid,
    at: FieldValue.serverTimestamp(),
    action,
    before: before ?? null,
    after: after ?? null,
    ...(target ? { target } : {}),
  });
  addOpsLogInTx(db, tx, { kind: 'admin_change', message });
}

// ---------- 수집 대상 아티스트 ----------

export async function addArtist(
  db: Firestore,
  adminUid: string,
  input: { mbid: string; name: string; channelId?: string | undefined },
  now = new Date(),
) {
  const ref = db.doc(`artists/${input.mbid}`);
  await db.runTransaction(async (tx) => {
    if ((await tx.get(ref)).exists) throw new AdminOpError('artistExists');
    const doc = {
      mbid: input.mbid,
      name: input.name,
      status: 'active',
      failCount: 0,
      // null이면 수집 줄 맨 앞(orderBy lastScannedAt). 재확인·정리 조회에도 걸리게 둔다(D-028)
      lastScannedAt: null,
      addedBy: 'admin',
      ...(input.channelId
        ? { channelId: input.channelId, ytVerifiedAt: Timestamp.fromDate(now) }
        : {}),
    };
    tx.create(ref, doc);
    audit(db, tx, adminUid, 'addArtist', null, doc, 'Admin added an artist to the catalog.', {
      artistId: input.mbid,
    });
  });
}

/** 빼기(paused) · 다시 켜기(active, 실패 횟수 0, 다음 수집 맨 앞) */
export async function setArtistStatus(
  db: Firestore,
  adminUid: string,
  input: { id: string; status: 'active' | 'paused' },
) {
  const ref = db.doc(`artists/${input.id}`);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new AdminOpError('artistNotFound');
    const before = { status: snap.get('status'), failCount: snap.get('failCount') ?? 0 };
    const after =
      input.status === 'active'
        ? { status: 'active', failCount: 0, lastScannedAt: null }
        : { status: 'paused' };
    tx.update(ref, after);
    audit(
      db,
      tx,
      adminUid,
      'setArtistStatus',
      before,
      { status: input.status },
      input.status === 'active'
        ? 'Admin re-enabled an artist for the next ingest.'
        : 'Admin paused an artist.',
      { artistId: input.id },
    );
  });
}

// ---------- 잘못된 연결 고치기 ----------

/**
 * blocked: 이 영상을 막는다(재생·추천에서 빠짐).
 * active: 이 영상으로 바꾼다. 같은 곡의 다른 active 연결은 막는다. 25일 안에 확인된 연결만.
 */
export async function setLinkStatus(
  db: Firestore,
  adminUid: string,
  input: { songId: string; videoId: string; status: 'active' | 'blocked' },
  now = new Date(),
) {
  const ref = db.doc(`songs/${input.songId}/links/${input.videoId}`);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new AdminOpError('linkNotFound');
    const before = snap.get('status') as string;
    // 원래 누가 연결했는지(rule·ai·lookup)는 감사 기록에 남긴다(덮어쓰기 전에)
    const beforeLinkedBy = (snap.get('linkedBy') as string | undefined) ?? null;
    const others = await tx.get(
      db.collection(`songs/${input.songId}/links`).where('status', '==', 'active'),
    );
    if (input.status === 'blocked') {
      // 막을 수 있는 것은 아직 YouTube 정보가 있는 연결만. gone(영상 없어짐)은 다시 확인 대상에 넣지 않는다
      if (!['active', 'pending_ai', 'rejected'].includes(before)) {
        throw new AdminOpError('badTransition');
      }
      tx.update(ref, { status: 'blocked', linkedBy: 'admin' });
    } else {
      if (!['blocked', 'pending_ai', 'rejected'].includes(before)) {
        throw new AdminOpError('badTransition');
      }
      const verifiedAt = snap.get('verifiedAt') as unknown;
      const fresh =
        verifiedAt instanceof Timestamp && now.getTime() - verifiedAt.toMillis() < FRESH_MS;
      if (!fresh) throw new AdminOpError('linkStale');
      // 추천은 퍼가기 되는 연결만 쓴다(catalog.ts). 안 되는 영상으로 바꾸면 곡이 조용히 빠진다
      if (snap.get('embeddable') !== true) throw new AdminOpError('linkNotPlayable');
      tx.update(ref, { status: 'active', linkedBy: 'admin' });
      for (const d of others.docs) {
        if (d.id !== input.videoId) tx.update(d.ref, { status: 'blocked', linkedBy: 'admin' });
      }
    }
    const replaced = input.status === 'active' ? others.docs.map((d) => d.id) : [];
    audit(
      db,
      tx,
      adminUid,
      'setLinkStatus',
      { status: before, linkedBy: beforeLinkedBy },
      { status: input.status, blocked: replaced },
      input.status === 'blocked'
        ? 'Admin blocked a song video link.'
        : 'Admin switched a song to a different video.',
      { songId: input.songId, videoId: input.videoId },
    );
    return { before, after: input.status, blockedOthers: replaced.length };
  });
}

// ---------- 사용자 ----------

export async function setUserFlag(
  db: Firestore,
  adminUid: string,
  input: { uid: string; flag: 'blocked' | 'exportTester'; value: boolean },
) {
  const ref = db.doc(`users/${input.uid}`);
  // 테스트 사용자 상한: 트랜잭션 밖에서 센다. 관리자만 부르므로 동시에 101번째가 들어갈 경쟁은 받아들인다.
  if (input.flag === 'exportTester' && input.value) {
    const already = (await ref.get()).get('exportTester') === true;
    const n = (await db.collection('users').where('exportTester', '==', true).count().get()).data()
      .count;
    if (!already && n >= MAX_TESTERS) throw new AdminOpError('testersFull');
  }
  await db.runTransaction(async (tx) => {
    const before = (await tx.get(ref)).get(input.flag) === true;
    tx.set(ref, { [input.flag]: input.value }, { merge: true });
    const what = input.flag === 'blocked' ? 'blocking' : 'export tester access';
    audit(
      db,
      tx,
      adminUid,
      input.flag === 'blocked' ? 'setUserBlocked' : 'setExportTester',
      { [input.flag]: before },
      { [input.flag]: input.value },
      `Admin turned ${input.value ? 'on' : 'off'} ${what} for an account.`,
      { uid: input.uid },
    );
  });
}

// ---------- 한눈에 보기 ----------

export interface JobResult {
  job: string;
  at: string | null;
  outcome: string;
  processed: number;
  failed: number;
}

export async function adminOverview(db: Firestore, now = new Date()) {
  const since = Timestamp.fromMillis(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const [config, usage, jobSnap, artists, testers, blocked] = await Promise.all([
    readRuntimeConfig(db),
    db.doc(`usage/${pacificDay(now)}`).get(),
    db
      .collection('events')
      .where('type', '==', 'job_finished')
      .where('at', '>=', since)
      .orderBy('at', 'desc')
      .limit(200)
      .get(),
    db.collection('artists').orderBy('name').limit(500).get(),
    db.collection('users').where('exportTester', '==', true).limit(MAX_TESTERS).get(),
    db.collection('users').where('blocked', '==', true).limit(200).get(),
  ]);

  const jobs: JobResult[] = [];
  for (const d of jobSnap.docs) {
    const job = d.get('attrs.job') as string;
    if (!(JOBS as readonly string[]).includes(job) || jobs.some((j) => j.job === job)) continue;
    const at = d.get('at') as unknown;
    jobs.push({
      job,
      at: at instanceof Timestamp ? at.toDate().toISOString() : null,
      outcome: d.get('outcome') as string,
      processed: Number(d.get('attrs.processed') ?? 0),
      failed: Number(d.get('attrs.failed') ?? 0),
    });
  }
  const used = Object.fromEntries(
    SERVICE_COUNTERS.map((k) => {
      const v = usage.get(k) as unknown;
      return [k, typeof v === 'number' ? v : 0];
    }),
  );
  const iso = (v: unknown) => (v instanceof Timestamp ? v.toDate().toISOString() : null);
  return {
    killSwitches: config.killSwitches,
    limits: config.limits,
    usage: { day: pacificDay(now), used },
    jobs,
    artists: artists.docs.map((d) => ({
      id: d.id,
      name: String(d.get('name') ?? ''),
      status: String(d.get('status') ?? ''),
      failCount: Number(d.get('failCount') ?? 0),
      channelId: (d.get('channelId') as string | undefined) ?? null,
      lastScannedAt: iso(d.get('lastScannedAt')),
    })),
    testerUids: testers.docs.map((d) => d.id),
    blockedUids: blocked.docs.map((d) => d.id),
  };
}
export type AdminOverview = Awaited<ReturnType<typeof adminOverview>>;
