import { afterEach, describe, expect, it, vi } from 'vitest';
import { SMOKE_CALLABLES } from '../../../tools/smoke.js';

type Endpoint = { __endpoint?: { callableTrigger?: unknown } };
type Fn = { __endpoint?: unknown };

async function exported(): Promise<Record<string, unknown>> {
  vi.resetModules();
  return (await import('../index.js')) as Record<string, unknown>;
}

/** export 묶음(playlists.create 등)을 펼쳐 callable만 모은다 */
function callables(mod: Record<string, unknown>): [string, Fn][] {
  const out: [string, Fn][] = [];
  const visit = (name: string, v: unknown) => {
    if (typeof v === 'function' && (v as Endpoint).__endpoint?.callableTrigger) {
      out.push([name, v as Fn]);
    } else if (v && typeof v === 'object') {
      for (const [k, c] of Object.entries(v)) visit(`${name}-${k}`, c);
    }
  };
  for (const [k, v] of Object.entries(mod)) visit(k, v);
  return out;
}

/** App Check 토큰 없는 호출(로그인도 없음)을 HTTP 처리기에 직접 넣어 응답 상태를 본다 */
async function callWithoutAppCheck(fn: Fn): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const req = {
    method: 'POST',
    headers,
    body: { data: {} },
    header: (n: string) => headers[n.toLowerCase()],
    get: (n: string) => headers[n.toLowerCase()],
  };
  return new Promise((resolve) => {
    let status = 200;
    const res = {
      status(s: number) {
        status = s;
        return res;
      },
      send(body: unknown) {
        resolve({ status, body });
        return res;
      },
      json(body: unknown) {
        resolve({ status, body });
        return res;
      },
      setHeader: () => res,
      set: () => res,
      getHeader: () => undefined,
      on: () => res,
      end: () => resolve({ status, body: undefined }),
    };
    void (fn as unknown as (q: unknown, r: unknown) => unknown)(req, res);
  });
}

describe('모든 callable은 실제 배포에서 App Check를 강제한다 (T23, SPEC 6.1)', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('에뮬레이터 밖: App Check 토큰 없는 호출은 모든 callable이 거부(401)', async () => {
    vi.stubEnv('FUNCTIONS_EMULATOR', '');
    const list = callables(await exported());
    expect(list.map(([n]) => n)).toEqual(
      expect.arrayContaining([
        'health',
        'site-config',
        'status-get',
        'songs-suggest',
        'playlists-create',
        'playlists-get',
        'playback-reportEmbedBlocked',
        'admin-overview',
        'account-syncClaims',
      ]),
    );
    // 배포 뒤 점검(tools/smoke.ts)이 부르는 이름이 실제로 있는지
    for (const n of SMOKE_CALLABLES)
      expect(
        list.map(([x]) => x),
        n,
      ).toContain(n);
    for (const [name, fn] of list) {
      const r = await callWithoutAppCheck(fn);
      // App Check 거부는 함수 본문 전에 일어난다: message가 "Unauthenticated"(본문의 로그인 확인 "sign in required"와 구분)
      expect(r.status, name).toBe(401);
      expect(r.body, name).toEqual({
        error: { message: 'Unauthenticated', status: 'UNAUTHENTICATED' },
      });
    }
  });

  it('에뮬레이터 안: App Check 없이도 처리된다(health가 200)', async () => {
    vi.stubEnv('FUNCTIONS_EMULATOR', 'true');
    const health = callables(await exported()).find(([n]) => n === 'health')?.[1];
    expect(health).toBeDefined();
    const r = await callWithoutAppCheck(health as Fn);
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).toContain('musicweb');
  });
});
