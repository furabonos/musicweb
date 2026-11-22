import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

/** 통합 테스트 도우미 (배포 빌드에서 빠짐): 에뮬레이터 Firestore와 전체 지우기. */
export const projectId = process.env.GCLOUD_PROJECT ?? 'demo-musicweb';

export function emulatorDb() {
  if (!getApps().length) initializeApp({ projectId });
  return getFirestore();
}

export async function clearFirestore() {
  const host = process.env.FIRESTORE_EMULATOR_HOST;
  if (!host) throw new Error('pnpm test:int로 실행하세요.');
  const res = await fetch(
    `http://${host}/emulator/v1/projects/${projectId}/databases/(default)/documents`,
    { method: 'DELETE' },
  );
  if (!res.ok) throw new Error(`에뮬레이터 지우기 실패: ${res.status}`);
}

export const DAY_MS = 24 * 60 * 60 * 1000;
