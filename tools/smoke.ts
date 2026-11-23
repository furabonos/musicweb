/**
 * 배포 뒤 점검 (T23). 배포된 callable을 App Check 토큰 없이 불러 모두 거부되는지 본다.
 *
 *   node --experimental-strip-types tools/smoke.ts <프로젝트 ID> [지역(기본 us-central1)]
 *
 * 로그인 없이 부를 수 있는 함수(누구나 여는 화면이 부름)를 중심으로 본다. 요청 본문은 비어 있어 데이터를 바꾸지 않는다.
 * 관리자 아닌 계정의 만들기 거부(D-015)는 로그인한 브라우저가 필요해 docs/OPERATIONS.md의 손 확인으로 한다.
 */
import { pathToFileURL } from 'node:url';

export const SMOKE_CALLABLES = [
  'health',
  'site-config',
  'status-get',
  'playlists-get',
  'songs-suggest',
  'playback-reportEmbedBlocked',
  'playlists-create',
  'playlists-explain',
  'account-syncClaims',
  'admin-overview',
] as const;

export function callableUrl(projectId: string, region: string, name: string): string {
  return `https://${region}-${projectId}.cloudfunctions.net/${name}`;
}

export interface SmokeResult {
  name: string;
  ok: boolean;
  detail: string;
}

/**
 * App Check 강제의 거부는 401이고 message가 정확히 "Unauthenticated"다.
 * 로그인이 필요한 함수는 App Check가 빠져도 본문이 401(`sign in required`)을 돌려주므로 message로 구분한다.
 * 그 밖(200, 404, 다른 401)은 실패.
 */
export function isAppCheckRejection(status: number, text: string): boolean {
  if (status !== 401) return false;
  try {
    const e = (JSON.parse(text) as { error?: { message?: unknown; status?: unknown } }).error;
    return e?.status === 'UNAUTHENTICATED' && e.message === 'Unauthenticated';
  } catch {
    return false;
  }
}

export async function smokeOne(
  fetchFn: typeof fetch,
  url: string,
  name: string,
): Promise<SmokeResult> {
  try {
    const res = await fetchFn(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: {} }),
    });
    const text = await res.text();
    const ok = isAppCheckRejection(res.status, text);
    return { name, ok, detail: `HTTP ${res.status}` };
  } catch (err) {
    return { name, ok: false, detail: `연결 실패: ${(err as Error).message}` };
  }
}

export async function smoke(
  fetchFn: typeof fetch,
  projectId: string,
  region = 'us-central1',
): Promise<SmokeResult[]> {
  const out: SmokeResult[] = [];
  for (const name of SMOKE_CALLABLES) {
    out.push(await smokeOne(fetchFn, callableUrl(projectId, region, name), name));
  }
  return out;
}

async function main(): Promise<void> {
  const [projectId, region] = process.argv.slice(2);
  if (!projectId) {
    console.error('사용법: node --experimental-strip-types tools/smoke.ts <프로젝트 ID> [지역]');
    process.exit(2);
  }
  const results = await smoke(fetch, projectId, region);
  for (const r of results) console.log(`${r.ok ? '거부됨(정상)' : '실패'}  ${r.name}  ${r.detail}`);
  const bad = results.filter((r) => !r.ok);
  if (bad.length) {
    console.error(`App Check 없이 거부되지 않은 함수 ${bad.length}개`);
    process.exit(1);
  }
  console.log('모든 callable이 App Check 토큰 없는 호출을 거부했습니다');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
