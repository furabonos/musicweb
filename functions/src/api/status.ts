import { getFirestore, Timestamp, type Firestore } from 'firebase-admin/firestore';
import { onCall } from 'firebase-functions/v2/https';
import { GITHUB_REPO } from '../adapters/github.js';
import { handle } from './errors.js';

/**
 * 공개 현황판 데이터 (`status-get`, SPEC 4.10, T21, D-042). 로그인 없이 누구나.
 * - metrics/current의 지표와 운영 일지 최근 50줄만 돌려준다. 저장된 모양을 그대로 넘기지 않고 정해진 필드만 골라낸다:
 *   숫자(또는 null)·단위·계산 방법, GitHub 링크·상태. 검색 문장·재생목록 이름·계정 정보는 이 문서들에 애초에 없다.
 */
const UNITS = new Set(['rate', 'count', 'score', 'hours']);
const OPS_LIMIT = 50;

export interface PublicMetric {
  value: number | null;
  unit: 'rate' | 'count' | 'score' | 'hours';
  method: string;
}

const iso = (v: unknown) => (v instanceof Timestamp ? v.toDate().toISOString() : null);
const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : null);

function metric(v: unknown): PublicMetric | null {
  if (!v || typeof v !== 'object') return null;
  const m = v as Record<string, unknown>;
  const value = typeof m.value === 'number' && Number.isFinite(m.value) ? m.value : null;
  const unit = typeof m.unit === 'string' && UNITS.has(m.unit) ? m.unit : null;
  const method = str(m.method, 300);
  if (!unit || !method) return null;
  return { value, unit: unit as PublicMetric['unit'], method };
}

function metrics(v: unknown, keys: readonly string[]): Record<string, PublicMetric> {
  const out: Record<string, PublicMetric> = {};
  if (!v || typeof v !== 'object') return out;
  for (const k of keys) {
    const m = metric((v as Record<string, unknown>)[k]);
    if (m) out[k] = m;
  }
  return out;
}

const SERVICE = [
  'parseSuccessRate',
  'madeUpSongsFiltered',
  'officialLinkAccuracy',
  'removedSongRate',
  'recommendTestScore',
] as const;
const CATALOG = [
  'playableSongs',
  'songsAdded',
  'searchFreeRate',
  'ytUnitsLeft',
  'ytUserSearchesLeft',
  'ytJobSearchesLeft',
] as const;
const GITHUB = ['autoIssues', 'approvalRate', 'hoursToFix', 'revertRate', 'ciPassRate'] as const;
const REPO = `https://github\\.com/${GITHUB_REPO.replace('/', '\\/')}`;
const PR_URL = new RegExp(`^${REPO}/pull/\\d+$`);
const OPS_LINK = new RegExp(`^${REPO}/(issues|pull|actions/runs)/\\d+`);

function github(v: unknown) {
  if (!v || typeof v !== 'object') return null;
  const g = v as Record<string, unknown>;
  if (typeof g.unavailable === 'string') return { unavailable: g.unavailable.slice(0, 60) };
  const reasons = Array.isArray(g.rejectReasons) ? g.rejectReasons : [];
  const recent = Array.isArray(g.recent) ? g.recent : [];
  return {
    updatedAt: iso(g.updatedAt),
    metrics: metrics(g, GITHUB),
    rejectReasons: reasons
      .filter((r): r is { reason: string; count: number } => typeof r?.reason === 'string')
      .map((r) => ({ reason: r.reason.slice(0, 40), count: Number(r.count) || 0 })),
    recent: recent
      .filter((r): r is Record<string, unknown> => typeof r?.url === 'string' && PR_URL.test(r.url))
      .slice(0, 10)
      .map((r) => ({
        number: Number(r.number),
        url: r.url as string,
        state: str(r.state, 10),
        ci: str(r.ci, 10),
        openedAt: str(r.openedAt, 30),
        reverted: r.reverted === true,
        rejectReason: str(r.rejectReason, 40),
      })),
  };
}

export async function readStatus(db: Firestore) {
  const [cur, ops] = await Promise.all([
    db.doc('metrics/current').get(),
    db.collection('opsLog').orderBy('at', 'desc').limit(OPS_LIMIT).get(),
  ]);
  return {
    updatedAt: iso(cur.get('updatedAt')),
    service: metrics(cur.get('service'), SERVICE),
    catalog: metrics(cur.get('catalog'), CATALOG),
    github: github(cur.get('github')),
    opsLog: ops.docs.map((d) => ({
      at: iso(d.get('at')),
      kind: str(d.get('kind'), 20),
      message: str(d.get('message'), 200),
      links: ((d.get('links') as unknown[]) ?? []).filter(
        (l): l is string => typeof l === 'string' && OPS_LINK.test(l),
      ),
    })),
  };
}
export type StatusResult = Awaited<ReturnType<typeof readStatus>>;

/**
 * 로그인 없이 부르므로 한 번에 읽기 51회가 몰리지 않게 인스턴스 안에서 60초 캐시하고 인스턴스 수를 묶는다.
 * 수치는 하루 한 번 바뀌므로 60초 늦어도 문제없다. App Check는 T23에서 켠다.
 */
const CACHE_MS = 60_000;
let cache: { at: number; value: Promise<StatusResult> } | null = null;
export function cachedStatus(db: Firestore, now = Date.now()): Promise<StatusResult> {
  if (!cache || now - cache.at > CACHE_MS) {
    const value = readStatus(db);
    cache = { at: now, value };
    // 실패한 결과는 캐시에 남기지 않는다
    value.catch(() => {
      if (cache?.value === value) cache = null;
    });
  }
  return cache.value;
}

export const status = {
  get: onCall({ maxInstances: 3 }, () => handle(async () => cachedStatus(getFirestore()))),
};
