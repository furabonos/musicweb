import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { pacificDay } from './day.js';
import type { EventSink } from './events.js';
import { addOpsLogInTx } from './opsLog.js';
import { parseRuntimeConfig, RUNTIME_DOC, type SavingModeDoc } from './runtimeConfig.js';

/**
 * 절약 모드 (SPEC 3.4, T22b, D-039·D-040). 서버가 자동으로 켜고 끈다. 관리자 긴급 정지와는 별개다.
 * - 켜짐: AI 비용 예약이 서비스 하루 상한에 닿았을 때(enterSavingMode). 같은 날 이미 켜져 있으면 아무것도 쓰지 않는다.
 * - 꺼짐: 태평양 날이 바뀌었거나(카운터 초기화), 관리자가 AI 비용 상한을 켜질 때보다 올렸을 때(readSavingMode가 확인).
 * - 바뀔 때마다 운영 일지 한 줄(같은 트랜잭션)과 saving_mode 이벤트.
 * - 절약 모드에서 꺼지는 것: AI 요청 해석, AI 후보·고르기, AI 설명(T34), 곡 연결 AI 판정. 만들기·재생·공유는 그대로.
 */

/**
 * 저장된 값으로 지금 절약 모드인지(쓰지 않음). 날이 바뀌었거나 상한을 올렸으면 꺼진 것으로 본다.
 * 사이트 안내·관리자 화면·요청 처리가 같은 판정을 쓴다.
 */
export function savingModeState(
  stored: Record<string, unknown> | undefined,
  now: Date,
): { active: boolean; ended: 'new_day' | 'limit_raised' | null } {
  const cur = stored?.savingMode as SavingModeDoc | undefined;
  if (!cur?.active) return { active: false, ended: null };
  if (cur.day !== pacificDay(now)) return { active: false, ended: 'new_day' };
  let limit: number;
  try {
    limit = parseRuntimeConfig(stored).limits.service.aiCostMicroUsd;
  } catch {
    return { active: true, ended: null };
  }
  return limit > cur.limitAtStart
    ? { active: false, ended: 'limit_raised' }
    : { active: true, ended: null };
}

/** AI 상한에 닿았다: 오늘 처음이면 켠다. 켰으면 true */
export async function enterSavingMode(
  db: Firestore,
  events: EventSink,
  now: Date = new Date(),
): Promise<boolean> {
  const day = pacificDay(now);
  const ref = db.doc(RUNTIME_DOC);
  let prevOff = false;
  const turnedOn = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const stored = snap.exists ? snap.data() : undefined;
    const cfg = parseRuntimeConfig(stored);
    const cur = stored?.savingMode as SavingModeDoc | undefined;
    if (cur?.active && cur.day === day) return false;
    // 전날 켜진 것이 아직 꺼짐 기록 없이 남아 있으면 꺼짐도 같이 남긴다(바뀔 때마다 한 줄, SPEC 3.4)
    const prevEnded = cur?.active === true;
    prevOff = prevEnded;
    if (prevEnded) {
      addOpsLogInTx(db, tx, {
        kind: 'limit',
        message: 'Saving mode off: a new day started (Pacific time).',
      });
    }
    const next: SavingModeDoc = {
      active: true,
      day,
      since: FieldValue.serverTimestamp(),
      reason: 'ai_limit',
      limitAtStart: cfg.limits.service.aiCostMicroUsd,
    };
    tx.set(ref, { savingMode: next }, { merge: true });
    addOpsLogInTx(db, tx, {
      kind: 'limit',
      message:
        'Saving mode on: the daily AI cost limit was reached. Sets are made without AI until midnight Pacific.',
    });
    return true;
  });
  if (turnedOn && prevOff) {
    await events.record({
      type: 'saving_mode',
      attrs: { state: 'off', reason: 'new_day' },
      outcome: 'ok',
    });
  }
  if (turnedOn) {
    await events.record({
      type: 'saving_mode',
      attrs: { state: 'on', reason: 'ai_limit' },
      outcome: 'ok',
    });
  }
  return turnedOn;
}

/** 지금 절약 모드인가. 끝날 때가 됐으면(날 바뀜·상한 상향) 끄고 기록한 뒤 false */
export async function readSavingMode(
  db: Firestore,
  events: EventSink,
  now: Date = new Date(),
): Promise<boolean> {
  const ref = db.doc(RUNTIME_DOC);
  // 켜져 있는 동안은 읽기만 한다. 끝낼 때만 트랜잭션을 연다(관리자 쓰기와 덜 부딪히게)
  const first = savingModeState((await ref.get()).data(), now);
  if (!first.ended) return first.active;

  const result = await db.runTransaction<{
    active: boolean;
    ended: 'new_day' | 'limit_raised' | null;
  }>(async (tx) => {
    const snap = await tx.get(ref);
    const stored = snap.exists ? snap.data() : undefined;
    const state = savingModeState(stored, now);
    if (!state.ended) return state;
    tx.set(
      ref,
      { savingMode: { ...(stored?.savingMode as SavingModeDoc), active: false } },
      { merge: true },
    );
    addOpsLogInTx(db, tx, {
      kind: 'limit',
      message:
        state.ended === 'new_day'
          ? 'Saving mode off: a new day started (Pacific time).'
          : 'Saving mode off: the admin raised the daily AI cost limit.',
    });
    return state;
  });
  const ended: 'new_day' | 'limit_raised' | null = result.ended;
  if (ended) {
    await events.record({
      type: 'saving_mode',
      attrs: { state: 'off', reason: ended },
      outcome: 'ok',
    });
  }
  return result.active;
}
