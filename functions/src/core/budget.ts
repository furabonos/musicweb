import {
  FieldValue,
  type DocumentReference,
  type Firestore,
  type Transaction,
} from 'firebase-admin/firestore';
import { nextPacificMidnight, pacificDay } from './day.js';
import {
  KillSwitchError,
  RUNTIME_DOC,
  parseRuntimeConfig,
  SERVICE_COUNTERS,
  USER_COUNTERS,
  type Feature,
  type ServiceCounter,
  type UserCounter,
} from './runtimeConfig.js';

/**
 * 비용·호출 상한 (SPEC 6.2, 6.3, T04, D-020).
 * 모든 외부 호출(YouTube, AI, GitHub …)은 호출 전에 쓸 양을 예약(reserve)하고, 끝나면 실제 양으로 맞춘다(settle).
 * 보통은 withBudget()으로 감싸서 쓴다 — 실패해도 정산이 빠지지 않는다.
 *
 * - 서비스 카운터: usage/{day}. 사용자 카운터: users/{uid}/usage/{day}. 분리돼 한 사용자의 소진이 남에게 영향 없음.
 * - 한 트랜잭션 안에서 설정 읽기 → (선택) 긴급 정지 확인 → 한도 확인 → 증가 → 예약 기록까지 한다.
 * - 예약 기록: usage/{day}/reservations/{id} (서버 전용, 보안 규칙에 match 없음). 정산 후 uid는 지운다.
 * - 날짜는 태평양 시간(pacificDay). 정산은 예약한 날짜 기준.
 * - 막는 쪽으로 실패: 설정이 깨졌거나 카운터 값이 숫자가 아니면 거부한다.
 * - 정산되지 않은 예약은 예약한 양만큼 계속 잡혀 있다(안전한 쪽).
 *
 * 오류 메시지는 서버 로그용이다. 화면 문구는 api 계층에서 scope·counter·resetAt으로 언어에 맞게 만든다.
 */
export interface ReserveRequest {
  service?: Partial<Record<ServiceCounter, number>>;
  user?: { uid: string; counters: Partial<Record<UserCounter, number>> };
  /** 주면 같은 트랜잭션에서 긴급 정지 스위치도 확인한다. */
  feature?: Feature;
  now?: Date;
}

export interface Reservation {
  id: string;
  day: string;
  uid?: string;
  service: Partial<Record<ServiceCounter, number>>;
  user: Partial<Record<UserCounter, number>>;
}

export class BudgetExceededError extends Error {
  override name = 'BudgetExceededError';
  constructor(
    readonly scope: 'service' | 'user',
    readonly counter: string,
    readonly limit: number,
    readonly used: number,
    /** 한도가 초기화되는 시각 (다음 태평양 자정). */
    readonly resetAt: Date,
  ) {
    super(
      `budget exceeded: ${scope}.${counter} used=${used} limit=${limit} resetAt=${resetAt.toISOString()}`,
    );
  }
}

export class BudgetStateError extends Error {
  override name = 'BudgetStateError';
}

export class AlreadySettledError extends Error {
  override name = 'AlreadySettledError';
}

// 서비스 카운터 문서 하나에 요청이 몰릴 때 서버 SDK 트랜잭션이 잠금 대기 후 재시도한다.
// 기본 5회로는 동시 요청 20개 시험에서 일부가 경합 오류로 끝날 수 있어 넉넉히 둔다.
const MAX_TRANSACTION_ATTEMPTS = 30;

function validateAmounts(amounts: Record<string, number | undefined>): boolean {
  let positive = false;
  for (const [name, v] of Object.entries(amounts)) {
    if (v === undefined) continue;
    if (!Number.isInteger(v) || v < 0)
      throw new Error(`사용량은 0 이상의 정수여야 합니다: ${name}=${v}`);
    if (v > 0) positive = true;
  }
  return positive;
}

function validateUid(uid: string) {
  if (!uid || uid.includes('/') || uid.length > 128)
    throw new Error('uid가 비었거나 형식이 잘못됐습니다.');
}

/** 저장된 카운터 값. 없으면 0, 숫자가 아니면 막는 쪽으로 실패. */
function counterValue(
  snap: FirebaseFirestore.DocumentSnapshot | undefined,
  counter: string,
): number {
  const raw: unknown = snap?.get(counter);
  if (raw === undefined || raw === null) return 0;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    throw new BudgetStateError(
      `${snap?.ref.path}.${counter} 값이 숫자가 아닙니다. 관리자가 확인해야 합니다.`,
    );
  }
  return raw;
}

const serviceRef = (db: Firestore, day: string) => db.doc(`usage/${day}`);
const userRef = (db: Firestore, uid: string, day: string) => db.doc(`users/${uid}/usage/${day}`);

export async function reserve(db: Firestore, req: ReserveRequest): Promise<Reservation> {
  return reserveInternal(db, req, true);
}

/**
 * 정산이 필요 없는 호출용(쓴 양이 항상 예약한 양과 같을 때, 예: 무료 API 요청 1회 = 1).
 * reserve와 같은 검사(긴급 정지, 한도, 막는 쪽 실패)를 하되 예약 기록을 남기지 않아 Firestore 쓰기가 한 번이다(D-024).
 */
export async function consume(db: Firestore, req: ReserveRequest): Promise<void> {
  await reserveInternal(db, req, false);
}

async function reserveInternal(
  db: Firestore,
  req: ReserveRequest,
  keepRecord: boolean,
): Promise<Reservation> {
  const service = pick(req.service ?? {}, SERVICE_COUNTERS);
  const user = pick(req.user?.counters ?? {}, USER_COUNTERS);
  const anyPositive = [validateAmounts(service), validateAmounts(user)].some(Boolean);
  if (!anyPositive) throw new Error('사용량이 하나 이상 1 이상이어야 합니다.');
  if (req.user) validateUid(req.user.uid);

  const now = req.now ?? new Date();
  const day = pacificDay(now);
  const sRef = serviceRef(db, day);
  const uRef = req.user ? userRef(db, req.user.uid, day) : undefined;
  const needService = entries(service).length > 0;
  const needUser = uRef !== undefined && entries(user).length > 0;
  const resRef = sRef.collection('reservations').doc();

  await db.runTransaction(
    async (tx) => {
      // 필요한 문서만 읽는다: 사용자 카운터만 쓰는 예약이 서비스 문서에서 줄 서지 않게.
      const [cfgSnap, sSnap, uSnap] = await Promise.all([
        tx.get(db.doc(RUNTIME_DOC)),
        needService ? tx.get(sRef) : Promise.resolve(undefined),
        needUser && uRef ? tx.get(uRef) : Promise.resolve(undefined),
      ]);
      const cfg = parseRuntimeConfig(cfgSnap.exists ? cfgSnap.data() : undefined);
      if (req.feature && !cfg.killSwitches[req.feature]) throw new KillSwitchError(req.feature);

      for (const [counter, amount] of entries(service)) {
        const current = counterValue(sSnap, counter);
        const limit = cfg.limits.service[counter];
        if (current + amount > limit) {
          throw new BudgetExceededError(
            'service',
            counter,
            limit,
            current,
            nextPacificMidnight(now),
          );
        }
      }
      for (const [counter, amount] of entries(user)) {
        const current = counterValue(uSnap, counter);
        const limit = cfg.limits.user[counter];
        if (current + amount > limit) {
          throw new BudgetExceededError('user', counter, limit, current, nextPacificMidnight(now));
        }
      }

      incrementAll(tx, sRef, service);
      if (uRef) incrementAll(tx, uRef, user);
      if (!keepRecord) return;
      tx.set(resRef, {
        uid: req.user?.uid ?? null,
        service,
        user,
        settled: false,
        at: FieldValue.serverTimestamp(),
      });
    },
    { maxAttempts: MAX_TRANSACTION_ATTEMPTS },
  );

  return { id: resRef.id, day, ...(req.user ? { uid: req.user.uid } : {}), service, user };
}

export interface SettleActual {
  service?: Partial<Record<ServiceCounter, number>>;
  user?: Partial<Record<UserCounter, number>>;
}

/**
 * 예약한 양을 실제 사용량으로 맞춘다. 적힌 카운터만 바꾸고, 적지 않은 카운터는 예약한 양 그대로 둔다.
 * - 실제가 예약보다 많아도 기록한다(이미 쓴 비용).
 * - 돌려줄 때(실제 < 예약)는 카운터가 0 아래로 내려가지 않게 하고, 카운터 문서가 지워졌으면 건너뛴다.
 * - 사용자 카운터 경로는 예약 문서에 저장된 uid로 정한다(넘어온 값과 다르면 거부).
 * - 같은 예약은 한 번만 맞출 수 있다(AlreadySettledError).
 */
export async function settle(
  db: Firestore,
  reservation: Reservation,
  actual: SettleActual,
): Promise<void> {
  const service = pick(actual.service ?? {}, SERVICE_COUNTERS);
  const user = pick(actual.user ?? {}, USER_COUNTERS);
  validateAmounts(service);
  validateAmounts(user);

  const sRef = serviceRef(db, reservation.day);
  const resRef = sRef.collection('reservations').doc(reservation.id);

  await db.runTransaction(
    async (tx) => {
      const snap = await tx.get(resRef);
      if (!snap.exists)
        throw new BudgetStateError(`예약 ${reservation.id}을(를) 찾을 수 없습니다.`);
      if (snap.get('settled') === true)
        throw new AlreadySettledError(`예약 ${reservation.id}은(는) 이미 맞췄습니다.`);
      const storedUid = (snap.get('uid') as string | null) ?? undefined;
      if ((reservation.uid ?? undefined) !== storedUid) {
        throw new BudgetStateError(`예약 ${reservation.id}의 사용자가 일치하지 않습니다.`);
      }
      if (entries(user).length && !storedUid) {
        throw new BudgetStateError('사용자 없이 예약한 것은 사용자 카운터를 맞출 수 없습니다.');
      }
      const uRef = storedUid ? userRef(db, storedUid, reservation.day) : undefined;

      const serviceDelta = deltas(
        (snap.get('service') ?? {}) as Partial<Record<ServiceCounter, number>>,
        service,
      );
      const userDelta = deltas(
        (snap.get('user') ?? {}) as Partial<Record<UserCounter, number>>,
        user,
      );
      const needsRead = (d: Record<string, number | undefined>) =>
        Object.values(d).some((v) => (v ?? 0) < 0);
      const [sSnap, uSnap] = await Promise.all([
        needsRead(serviceDelta) ? tx.get(sRef) : Promise.resolve(undefined),
        uRef && needsRead(userDelta) ? tx.get(uRef) : Promise.resolve(undefined),
      ]);

      incrementAll(tx, sRef, clampRefunds(serviceDelta, sSnap));
      if (uRef) incrementAll(tx, uRef, clampRefunds(userDelta, uSnap));
      tx.update(resRef, {
        settled: true,
        uid: null, // 개인정보 최소화: 정산 뒤에는 누구 예약이었는지 남기지 않는다
        actualService: service,
        actualUser: user,
        settledAt: FieldValue.serverTimestamp(),
      });
    },
    { maxAttempts: MAX_TRANSACTION_ATTEMPTS },
  );
}

/**
 * 예약 → 외부 호출 → 정산을 한 번에. fn이 실제 사용량을 돌려주면 그대로 정산하고,
 * fn이 실패하면 아무것도 안 쓴 것으로(0) 정산한 뒤 원래 오류를 다시 던진다.
 * 실패했지만 비용이 이미 났을 수 있는 호출(예: AI 응답을 받은 뒤 파싱 실패)은 fn 안에서 처리해 actual을 돌려준다.
 */
export async function withBudget<T>(
  db: Firestore,
  req: ReserveRequest,
  fn: (reservation: Reservation) => Promise<{ result: T; actual: SettleActual }>,
): Promise<T> {
  const reservation = await reserve(db, req);
  let outcome: { result: T; actual: SettleActual };
  try {
    outcome = await fn(reservation);
  } catch (err) {
    await settle(db, reservation, zeroOf(reservation));
    throw err;
  }
  await settle(db, reservation, outcome.actual);
  return outcome.result;
}

function zeroOf(r: Reservation): SettleActual {
  const zero = <K extends string>(o: Partial<Record<K, number>>) =>
    Object.fromEntries(Object.keys(o).map((k) => [k, 0])) as Partial<Record<K, number>>;
  return { service: zero(r.service), ...(r.uid ? { user: zero(r.user) } : {}) };
}

function pick<K extends string>(
  obj: Partial<Record<string, number>>,
  keys: readonly K[],
): Partial<Record<K, number>> {
  const unknown = Object.keys(obj).filter((k) => !(keys as readonly string[]).includes(k));
  if (unknown.length) throw new Error(`모르는 카운터: ${unknown.join(', ')}`);
  return obj as Partial<Record<K, number>>;
}

function entries<K extends string>(obj: Partial<Record<K, number>>): [K, number][] {
  return (Object.entries(obj) as [K, number | undefined][]).filter(
    (e): e is [K, number] => e[1] !== undefined && e[1] !== 0,
  );
}

function deltas<K extends string>(
  reserved: Partial<Record<K, number>>,
  actual: Partial<Record<K, number>>,
) {
  const out: Partial<Record<K, number>> = {};
  for (const [k, v] of Object.entries(actual) as [K, number | undefined][]) {
    if (v !== undefined) out[k] = v - (reserved[k] ?? 0);
  }
  return out;
}

/** 돌려주는 양(음수)은 현재 값까지만. 카운터 문서가 없으면 돌려줄 것도 없다. */
function clampRefunds<K extends string>(
  delta: Partial<Record<K, number>>,
  snap: FirebaseFirestore.DocumentSnapshot | undefined,
): Partial<Record<K, number>> {
  const out: Partial<Record<K, number>> = {};
  for (const [k, v] of Object.entries(delta) as [K, number | undefined][]) {
    if (v === undefined || v === 0) continue;
    if (v > 0) {
      out[k] = v;
      continue;
    }
    if (!snap?.exists) continue;
    const current = counterValue(snap, k);
    out[k] = Math.max(v, -current);
  }
  return out;
}

function incrementAll(
  tx: Transaction,
  ref: DocumentReference,
  amounts: Partial<Record<string, number>>,
) {
  const update: Record<string, FieldValue> = {};
  for (const [k, v] of Object.entries(amounts)) if (v) update[k] = FieldValue.increment(v);
  if (Object.keys(update).length) tx.set(ref, update, { merge: true });
}
