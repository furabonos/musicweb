import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  AlreadySettledError,
  BudgetExceededError,
  consume,
  BudgetStateError,
  reserve,
  settle,
  withBudget,
} from './budget.js';
import { nextPacificMidnight, pacificDay } from './day.js';
import { assertEnabled, KillSwitchError } from './runtimeConfig.js';

// firebase emulators:exec 가 FIRESTORE_EMULATOR_HOST 를 넣어 준다 (pnpm test:int).
const projectId = process.env.GCLOUD_PROJECT ?? 'demo-musicweb';
if (!getApps().length) initializeApp({ projectId });
const db = getFirestore();
const now = new Date('2026-11-21T20:00:00Z');
const day = pacificDay(now);

async function clearFirestore() {
  const host = process.env.FIRESTORE_EMULATOR_HOST;
  if (!host) throw new Error('FIRESTORE_EMULATOR_HOST가 없습니다. pnpm test:int로 실행하세요.');
  const res = await fetch(
    `http://${host}/emulator/v1/projects/${projectId}/databases/(default)/documents`,
    {
      method: 'DELETE',
    },
  );
  expect(res.ok).toBe(true);
}

async function setLimits(limits: Record<string, unknown>, killSwitches?: Record<string, boolean>) {
  await db.doc('config/runtime').set({ limits, ...(killSwitches ? { killSwitches } : {}) });
}

const used = async (path: string, field: string) => (await db.doc(path).get()).get(field) ?? 0;

beforeEach(clearFirestore);

describe('reserve: 사용자별 한도', () => {
  it('A가 하루 한도에 닿으면 A만 거부되고 B는 성공한다', async () => {
    await setLimits({ user: { playlists: 2 } });
    await reserve(db, { user: { uid: 'alice', counters: { playlists: 1 } }, now });
    await reserve(db, { user: { uid: 'alice', counters: { playlists: 1 } }, now });
    const err = await reserve(db, {
      user: { uid: 'alice', counters: { playlists: 1 } },
      now,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(BudgetExceededError);
    expect(err).toMatchObject({ scope: 'user', counter: 'playlists', limit: 2 });

    await expect(
      reserve(db, { user: { uid: 'bob', counters: { playlists: 1 } }, now }),
    ).resolves.toBeDefined();
    expect(await used(`users/alice/usage/${day}`, 'playlists')).toBe(2);
    expect(await used(`users/bob/usage/${day}`, 'playlists')).toBe(1);
  });

  it('거부된 요청은 카운터를 올리지 않는다 (서비스·사용자 모두)', async () => {
    await setLimits({ user: { searches: 1 } });
    await reserve(db, {
      service: { ytSearchUser: 1 },
      user: { uid: 'alice', counters: { searches: 1 } },
      now,
    });
    await expect(
      reserve(db, {
        service: { ytSearchUser: 1 },
        user: { uid: 'alice', counters: { searches: 1 } },
        now,
      }),
    ).rejects.toBeInstanceOf(BudgetExceededError);
    expect(await used(`usage/${day}`, 'ytSearchUser')).toBe(1);
    expect(await used(`users/alice/usage/${day}`, 'searches')).toBe(1);
  });

  it('날짜(태평양 자정)가 바뀌면 다시 쓸 수 있다', async () => {
    await setLimits({ user: { playlists: 1 } });
    await reserve(db, { user: { uid: 'alice', counters: { playlists: 1 } }, now });
    await expect(
      reserve(db, { user: { uid: 'alice', counters: { playlists: 1 } }, now }),
    ).rejects.toThrow();
    const tomorrow = new Date(now.getTime() + 24 * 3600 * 1000);
    await expect(
      reserve(db, { user: { uid: 'alice', counters: { playlists: 1 } }, now: tomorrow }),
    ).resolves.toBeDefined();
  });
});

describe('reserve: 서비스 전체 상한', () => {
  it('서비스 상한에 닿으면 모두 거부한다', async () => {
    await setLimits({ service: { aiCostMicroUsd: 3000 } });
    await reserve(db, {
      service: { aiCostMicroUsd: 2000 },
      user: { uid: 'alice', counters: {} },
      now,
    });
    await reserve(db, {
      service: { aiCostMicroUsd: 1000 },
      user: { uid: 'bob', counters: {} },
      now,
    });
    for (const uid of ['alice', 'bob', 'carol']) {
      const err = await reserve(db, {
        service: { aiCostMicroUsd: 1 },
        user: { uid, counters: {} },
        now,
      }).catch((e) => e);
      expect(err).toMatchObject({ scope: 'service', counter: 'aiCostMicroUsd' });
    }
    expect(await used(`usage/${day}`, 'aiCostMicroUsd')).toBe(3000);
  });

  it('한도를 넘기는 한 번의 큰 요청도 거부한다 (경계값)', async () => {
    await setLimits({ service: { ytUnits: 100 } });
    await reserve(db, { service: { ytUnits: 60 }, now });
    await expect(reserve(db, { service: { ytUnits: 41 }, now })).rejects.toBeInstanceOf(
      BudgetExceededError,
    );
    await expect(reserve(db, { service: { ytUnits: 40 }, now })).resolves.toBeDefined(); // 정확히 100은 허용
    await expect(reserve(db, { service: { ytUnits: 1 }, now })).rejects.toBeInstanceOf(
      BudgetExceededError,
    );
  });

  it('동시 요청 20개에서도 상한을 넘지 않는다', async () => {
    await setLimits({ service: { ytUnits: 10 } });
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) =>
        reserve(db, { service: { ytUnits: 1 }, user: { uid: `u${i}`, counters: {} }, now }),
      ),
    );
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(ok).toBe(10);
    for (const r of rejected)
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(BudgetExceededError);
    expect(await used(`usage/${day}`, 'ytUnits')).toBe(10);
  });

  it('검색 카운터는 단위 카운터와 따로 센다', async () => {
    await setLimits({ service: { ytUnits: 9000, ytSearchUser: 2, ytSearchJob: 1 } });
    await reserve(db, { service: { ytSearchUser: 1, ytUnits: 0 }, now });
    await reserve(db, { service: { ytSearchUser: 1 }, now });
    await expect(reserve(db, { service: { ytSearchUser: 1 }, now })).rejects.toMatchObject({
      counter: 'ytSearchUser',
    });
    // 사용자 검색이 다 떨어져도 야간 작업 검색과 일반 단위는 남아 있다
    await expect(reserve(db, { service: { ytSearchJob: 1 }, now })).resolves.toBeDefined();
    await expect(reserve(db, { service: { ytUnits: 50 }, now })).resolves.toBeDefined();
    expect(await used(`usage/${day}`, 'ytUnits')).toBe(50);
    expect(await used(`usage/${day}`, 'ytSearchUser')).toBe(2);
    expect(await used(`usage/${day}`, 'ytSearchJob')).toBe(1);
  });

  it('config 문서가 없으면 SPEC 기본 한도로 동작한다', async () => {
    await reserve(db, { service: { ytUnits: 9000 }, now });
    await expect(reserve(db, { service: { ytUnits: 1 }, now })).rejects.toMatchObject({
      limit: 9000,
    });
  });

  it('config 문서가 깨져 있으면 아무것도 쓰지 않고 거부한다', async () => {
    await db.doc('config/runtime').set({ limits: { service: { ytUnits: 'lots' } } });
    await expect(reserve(db, { service: { ytUnits: 1 }, now })).rejects.toThrow();
    expect((await db.doc(`usage/${day}`).get()).exists).toBe(false);
  });

  it('0 이하·소수·NaN 사용량은 거부한다', async () => {
    for (const amount of [0, -1, 1.5, Number.NaN]) {
      await expect(reserve(db, { service: { ytUnits: amount }, now })).rejects.toThrow('사용량');
    }
  });
});

describe('settle: 실제 사용량으로 맞추기', () => {
  it('예약보다 덜 쓰면 돌려주고, 더 쓰면 더 기록한다 (예약한 날짜 기준)', async () => {
    const r = await reserve(db, {
      service: { aiCostMicroUsd: 2000 },
      user: { uid: 'alice', counters: { playlists: 1 } },
      now,
    });
    await settle(db, r, { service: { aiCostMicroUsd: 1500 } });
    expect(await used(`usage/${day}`, 'aiCostMicroUsd')).toBe(1500);

    const r2 = await reserve(db, { service: { aiCostMicroUsd: 1000 }, now });
    await settle(db, r2, { service: { aiCostMicroUsd: 1300 } }); // 실제 비용은 상한과 관계없이 기록
    expect(await used(`usage/${day}`, 'aiCostMicroUsd')).toBe(2800);
    expect(await used(`users/alice/usage/${day}`, 'playlists')).toBe(1);
  });

  it('호출이 실패해 전혀 안 썼으면 0으로 맞춰 전부 돌려준다', async () => {
    const r = await reserve(db, {
      service: { ytUnits: 50 },
      user: { uid: 'alice', counters: { playlists: 1 } },
      now,
    });
    await settle(db, r, { service: { ytUnits: 0 }, user: { playlists: 0 } });
    expect(await used(`usage/${day}`, 'ytUnits')).toBe(0);
    expect(await used(`users/alice/usage/${day}`, 'playlists')).toBe(0);
  });

  it('같은 예약을 두 번 맞추면 거부한다 (이중 반환 방지)', async () => {
    const r = await reserve(db, { service: { ytUnits: 50 }, now });
    await settle(db, r, { service: { ytUnits: 0 } });
    await expect(settle(db, r, { service: { ytUnits: 0 } })).rejects.toBeInstanceOf(
      AlreadySettledError,
    );
    expect(await used(`usage/${day}`, 'ytUnits')).toBe(0);
  });
});

describe('긴급 정지 스위치', () => {
  it('killSwitches.create=false면 다음 호출부터 즉시 거부한다 (캐시 없음)', async () => {
    await expect(assertEnabled(db, 'create')).resolves.toBeUndefined();
    await setLimits({}, { create: false });
    const err = await assertEnabled(db, 'create').catch((e) => e);
    expect(err).toBeInstanceOf(KillSwitchError);
    expect(err).toMatchObject({ feature: 'create' });
    await expect(assertEnabled(db, 'ingest')).resolves.toBeUndefined(); // 다른 기능은 영향 없음
    await setLimits({}, { create: true });
    await expect(assertEnabled(db, 'create')).resolves.toBeUndefined();
  });

  it('config 문서가 깨져 있으면 정지된 것으로 본다', async () => {
    await db.doc('config/runtime').set({ killSwitches: { create: 'yes' } });
    await expect(assertEnabled(db, 'create')).rejects.toThrow();
  });
});

describe('막는 쪽으로 실패 (리뷰 반영)', () => {
  it('카운터 값이 숫자가 아니면 허용하지 않고 거부한다', async () => {
    await db.doc(`usage/${day}`).set({ ytUnits: 'broken' });
    await expect(reserve(db, { service: { ytUnits: 1 }, now })).rejects.toBeInstanceOf(
      BudgetStateError,
    );
    await db.doc(`users/alice/usage/${day}`).set({ playlists: Number.NaN });
    await expect(
      reserve(db, { user: { uid: 'alice', counters: { playlists: 1 } }, now }),
    ).rejects.toBeInstanceOf(BudgetStateError);
  });

  it('설정 문서에 모르는 필드가 있으면 reserve도 거부한다', async () => {
    await db.doc('config/runtime').set({ limitz: {} });
    await expect(reserve(db, { service: { ytUnits: 1 }, now })).rejects.toThrow('config/runtime');
    expect((await db.doc(`usage/${day}`).get()).exists).toBe(false);
  });

  it.each(['', 'a/b', 'x'.repeat(129)])('잘못된 uid(%j)는 거부한다', async (uid) => {
    await expect(reserve(db, { user: { uid, counters: { playlists: 1 } }, now })).rejects.toThrow(
      'uid',
    );
  });
});

describe('reserve: 긴급 정지를 같은 트랜잭션에서 확인', () => {
  it('feature를 주면 스위치가 꺼졌을 때 카운터를 올리지 않고 거부한다', async () => {
    await setLimits({}, { create: false });
    const err = await reserve(db, {
      feature: 'create',
      user: { uid: 'alice', counters: { playlists: 1 } },
      now,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(KillSwitchError);
    expect((await db.doc(`users/alice/usage/${day}`).get()).exists).toBe(false);
    // 다른 기능은 그대로
    await expect(
      reserve(db, { feature: 'ingest', service: { ytUnits: 1 }, now }),
    ).resolves.toBeDefined();
  });

  it('한도 초과 오류에는 초기화 시각(다음 태평양 자정)이 들어 있다', async () => {
    await setLimits({ user: { playlists: 0 } });
    const err = await reserve(db, {
      user: { uid: 'alice', counters: { playlists: 1 } },
      now,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(BudgetExceededError);
    expect(err.resetAt.toISOString()).toBe(nextPacificMidnight(now).toISOString());
  });
});

describe('동시성 보강', () => {
  it('같은 사용자가 동시에 20번 요청해도 사용자 한도를 넘지 않는다', async () => {
    await setLimits({ user: { playlists: 10 } });
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () =>
        reserve(db, { user: { uid: 'alice', counters: { playlists: 1 } }, now }),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(10);
    for (const r of results.filter((x) => x.status === 'rejected')) {
      expect((r as PromiseRejectedResult).reason).toMatchObject({
        scope: 'user',
        counter: 'playlists',
      });
    }
    expect(await used(`users/alice/usage/${day}`, 'playlists')).toBe(10);
  });

  it('같은 예약을 동시에 두 번 맞춰도 한 번만 반영된다', async () => {
    const r = await reserve(db, { service: { ytUnits: 50 }, now });
    const results = await Promise.allSettled([
      settle(db, r, { service: { ytUnits: 0 } }),
      settle(db, r, { service: { ytUnits: 0 } }),
    ]);
    expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((x) => x.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(AlreadySettledError);
    expect(await used(`usage/${day}`, 'ytUnits')).toBe(0);
  });
});

describe('settle 보강', () => {
  it('없는 예약은 거부한다', async () => {
    await expect(
      settle(db, { id: 'nope', day, service: {}, user: {} }, { service: { ytUnits: 0 } }),
    ).rejects.toBeInstanceOf(BudgetStateError);
  });

  it('예약 문서의 사용자와 다른 uid로 맞추려 하면 거부하고 아무것도 바꾸지 않는다', async () => {
    const r = await reserve(db, { user: { uid: 'alice', counters: { playlists: 1 } }, now });
    await reserve(db, { user: { uid: 'bob', counters: { playlists: 1 } }, now });
    await expect(
      settle(db, { ...r, uid: 'bob' }, { user: { playlists: 0 } }),
    ).rejects.toBeInstanceOf(BudgetStateError);
    expect(await used(`users/bob/usage/${day}`, 'playlists')).toBe(1);
    expect(await used(`users/alice/usage/${day}`, 'playlists')).toBe(1);
  });

  it('돌려줄 때 카운터가 0 아래로 내려가지 않고, 문서가 지워졌으면 다시 만들지 않는다', async () => {
    const r1 = await reserve(db, { user: { uid: 'alice', counters: { playlists: 3 } }, now });
    await db.doc(`users/alice/usage/${day}`).delete(); // 계정 삭제·관리자 초기화 상황
    await settle(db, r1, { user: { playlists: 0 } });
    expect((await db.doc(`users/alice/usage/${day}`).get()).exists).toBe(false);

    const r2 = await reserve(db, { service: { ytUnits: 50 }, now });
    await db.doc(`usage/${day}`).set({ ytUnits: 10 }); // 누군가 줄여 놓음
    await settle(db, r2, { service: { ytUnits: 0 } });
    expect(await used(`usage/${day}`, 'ytUnits')).toBe(0);
  });

  it('정산하면 예약 문서에서 uid 원문을 지운다', async () => {
    const r = await reserve(db, { user: { uid: 'alice', counters: { playlists: 1 } }, now });
    const resPath = `usage/${day}/reservations/${r.id}`;
    expect((await db.doc(resPath).get()).get('uid')).toBe('alice');
    await settle(db, r, { user: { playlists: 1 } });
    const after = await db.doc(resPath).get();
    expect(after.get('uid')).toBeNull();
    expect(after.get('settled')).toBe(true);
  });
});

describe('withBudget', () => {
  it('성공하면 결과를 돌려주고 실제 사용량으로 정산한다', async () => {
    const result = await withBudget(
      db,
      {
        service: { aiCostMicroUsd: 2000 },
        user: { uid: 'alice', counters: { playlists: 1 } },
        now,
      },
      async () => ({ result: 'ok', actual: { service: { aiCostMicroUsd: 1200 } } }),
    );
    expect(result).toBe('ok');
    expect(await used(`usage/${day}`, 'aiCostMicroUsd')).toBe(1200);
    expect(await used(`users/alice/usage/${day}`, 'playlists')).toBe(1);
  });

  it('실패하면 0으로 정산해 전부 돌려주고 원래 오류를 다시 던진다', async () => {
    const boom = new Error('youtube down');
    await expect(
      withBudget(
        db,
        { service: { ytUnits: 50 }, user: { uid: 'alice', counters: { searches: 1 } }, now },
        async () => {
          throw boom;
        },
      ),
    ).rejects.toBe(boom);
    expect(await used(`usage/${day}`, 'ytUnits')).toBe(0);
    expect(await used(`users/alice/usage/${day}`, 'searches')).toBe(0);
  });

  it('한도에 걸리면 fn을 아예 부르지 않는다', async () => {
    await setLimits({ service: { ytUnits: 0 } });
    let called = false;
    await expect(
      withBudget(db, { service: { ytUnits: 1 }, now }, async () => {
        called = true;
        return { result: 1, actual: {} };
      }),
    ).rejects.toBeInstanceOf(BudgetExceededError);
    expect(called).toBe(false);
  });
});

describe('consume: 예약 기록 없이 카운터만 (D-024)', () => {
  it('한도 안에서 올리고, 넘으면 거부하며, 예약 기록을 남기지 않는다', async () => {
    await setLimits({ service: { musicDataCalls: 2 } });
    await consume(db, { service: { musicDataCalls: 1 }, now });
    await consume(db, { service: { musicDataCalls: 1 }, now });
    await expect(consume(db, { service: { musicDataCalls: 1 }, now })).rejects.toBeInstanceOf(
      BudgetExceededError,
    );
    expect(await used(`usage/${day}`, 'musicDataCalls')).toBe(2);
    expect((await db.collection(`usage/${day}/reservations`).get()).size).toBe(0);
  });

  it('긴급 정지 확인도 같이 한다', async () => {
    await setLimits({}, { ingest: false });
    await expect(
      consume(db, { service: { musicDataCalls: 1 }, feature: 'ingest', now }),
    ).rejects.toBeInstanceOf(KillSwitchError);
  });
});
