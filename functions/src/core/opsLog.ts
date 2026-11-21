import { FieldValue, type Firestore, type Transaction } from 'firebase-admin/firestore';

/**
 * 운영 일지 (SPEC 4.10, T07, D-023). opsLog는 누구나 읽는다(현황판).
 * - message는 코드가 만든 영어 고정 문장만 넣는다(D-013 기본 영어). 사용자 입력을 끼워 넣지 않는다.
 * - 저장 전에 이메일 형식, 200자 초과, 줄바꿈을 거부한다. 링크는 이 저장소 GitHub 주소만 받는다.
 */

export const OPS_LOG_KINDS = [
  'job', // 예약 작업 시작·끝·처리량
  'job_failed',
  'issue', // 발견한 문제·자동 이슈
  'pr', // 에이전트 PR·CI·승인/거절·점수 변화
  'limit', // 한도 도달
  'admin_change', // 관리자가 켜고 끈 설정
] as const;
export type OpsLogKind = (typeof OPS_LOG_KINDS)[number];

export interface OpsLogInput {
  kind: OpsLogKind;
  message: string;
  links?: string[];
}

export class OpsLogError extends Error {
  override name = 'OpsLogError';
}

const MAX_MESSAGE = 200;
const MAX_LINKS = 5;
const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const REPO_LINK =
  /^https:\/\/github\.com\/furabonos\/musicweb\/(issues|pull|actions\/runs)\/\d+(\/[\w/-]*)?$/;

/** 검사한 뒤 저장할 문서를 만든다. */
export function opsLogEntry(input: OpsLogInput) {
  if (!(OPS_LOG_KINDS as readonly string[]).includes(input.kind)) {
    throw new OpsLogError(`정의되지 않은 운영 일지 종류: ${String(input.kind)}`);
  }
  const message = typeof input.message === 'string' ? input.message.trim() : '';
  if (!message || message.length > MAX_MESSAGE) {
    throw new OpsLogError(`message는 1~${MAX_MESSAGE}자여야 합니다.`);
  }
  if (/[\r\n]/.test(message)) throw new OpsLogError('message에 줄바꿈을 넣지 않습니다.');
  if (EMAIL.test(message)) throw new OpsLogError('운영 일지에 이메일을 넣지 않습니다.');
  // uid·토큰처럼 보이는 긴 영숫자 덩어리(구분자 없이 20자 이상)는 넣지 않는다. 숫자는 링크로 단다.
  if (/[A-Za-z0-9]{20,}/.test(message)) {
    throw new OpsLogError('운영 일지 문장에 uid·토큰처럼 보이는 값을 넣지 않습니다.');
  }
  const links = input.links ?? [];
  if (links.length > MAX_LINKS) throw new OpsLogError(`링크는 ${MAX_LINKS}개까지입니다.`);
  for (const link of links) {
    if (!REPO_LINK.test(link)) {
      throw new OpsLogError('링크는 이 저장소의 이슈·PR·Actions 실행 주소만 넣습니다.');
    }
  }
  return { at: FieldValue.serverTimestamp(), kind: input.kind, message, links };
}

/** 트랜잭션 안에서 다른 쓰기와 함께 남긴다(예: 관리자 변경). */
export function addOpsLogInTx(db: Firestore, tx: Transaction, input: OpsLogInput): void {
  tx.create(db.collection('opsLog').doc(), opsLogEntry(input));
}

export async function addOpsLog(db: Firestore, input: OpsLogInput): Promise<void> {
  await db.collection('opsLog').add(opsLogEntry(input));
}
