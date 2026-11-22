import type { Firestore } from 'firebase-admin/firestore';
import { z } from 'zod';

/**
 * config/runtime 문서: 긴급 정지 스위치와 한도 (SPEC 4.11, 6.3).
 * - 매 요청마다 새로 읽는다(캐시 없음) → 관리자가 바꾸면 다음 요청부터 바로 적용.
 * - killSwitches 값은 "켜짐(동작)"이면 true, 정지면 false.
 * - 문서가 없으면 기본값, 문서가 깨졌거나 모르는 필드가 있으면 예외 → 호출 쪽은 거부한다(막는 쪽으로 실패).
 */
export const SERVICE_COUNTERS = [
  'ytUnits',
  'ytSearchUser',
  'ytSearchJob',
  'aiCostMicroUsd',
  'exports',
  'autoIssues',
  'autoFixes',
  'musicDataCalls',
  'linkChecks',
] as const;
export const USER_COUNTERS = ['playlists', 'searches', 'exports'] as const;
export const FEATURES = ['create', 'ingest', 'autoIssue'] as const;

export type ServiceCounter = (typeof SERVICE_COUNTERS)[number];
export type UserCounter = (typeof USER_COUNTERS)[number];
export type Feature = (typeof FEATURES)[number];

/** "YouTube에서 열기" 방식(D-006, T16). 링크가 깨지면 linkHealth 작업이 fallback(곡별 링크)으로 바꾼다. */
export const OPEN_LINK_MODES = ['direct', 'fallback'] as const;
export type OpenLinkMode = (typeof OPEN_LINK_MODES)[number];

export interface RuntimeConfig {
  killSwitches: Record<Feature, boolean>;
  youtubeOpenLink: OpenLinkMode;
  limits: { service: Record<ServiceCounter, number>; user: Record<UserCounter, number> };
}

/** YouTube Data API 기본 할당 (RESEARCH 1). 앱 상한은 이 값을 넘을 수 없다. */
export const YOUTUBE_DAILY_UNITS = 10_000;
export const YOUTUBE_DAILY_SEARCHES = 100;

export const DEFAULT_RUNTIME: RuntimeConfig = {
  killSwitches: { create: true, ingest: true, autoIssue: true },
  youtubeOpenLink: 'direct',
  limits: {
    service: {
      ytUnits: 9_000,
      ytSearchUser: 80,
      ytSearchJob: 20,
      aiCostMicroUsd: 1_000_000, // $1
      exports: 5,
      autoIssues: 5,
      autoFixes: 3, // 자동 수정(Claude Code Action) 실행. 실제 차감은 T20에서 연결
      musicDataCalls: 20_000, // 음악 데이터 요청(무료). 도는 코드가 폭주하지 않게 막는 상한 (D-024)
      linkChecks: 5, // "YouTube에서 열기" 링크 동작 확인(헤더만, D-006). 하루 1회 + 수동 재실행 여유 (T16)
    },
    user: { playlists: 10, searches: 3, exports: 1 },
  },
};

const count = z.number().int().nonnegative();
const partialRecord = <K extends string>(keys: readonly K[], value: z.ZodType) =>
  z.strictObject(
    Object.fromEntries(keys.map((k) => [k, value.optional()])) as Record<
      K,
      z.ZodOptional<z.ZodType>
    >,
  );

/** 한도 일부 (문서의 limits, 관리자 setLimits 입력). 모르는 카운터는 거부. */
export const limitsPatchSchema = z.strictObject({
  service: partialRecord(SERVICE_COUNTERS, count).optional(),
  user: partialRecord(USER_COUNTERS, count).optional(),
});
export type LimitsPatch = {
  service?: Partial<Record<ServiceCounter, number>>;
  user?: Partial<Record<UserCounter, number>>;
};

const docSchema = z.strictObject({
  killSwitches: partialRecord(FEATURES, z.boolean()).optional(),
  youtubeOpenLink: z.enum(OPEN_LINK_MODES).optional(),
  limits: limitsPatchSchema.optional(),
});

export class RuntimeConfigError extends Error {
  override name = 'RuntimeConfigError';
}

export function parseRuntimeConfig(doc: unknown): RuntimeConfig {
  if (doc === undefined) return structuredClone(DEFAULT_RUNTIME);
  const parsed = docSchema.safeParse(doc);
  if (!parsed.success) {
    throw new RuntimeConfigError(
      `config/runtime 형식이 잘못됐습니다: ${parsed.error.issues.map((i) => i.path.join('.') || '(문서)').join(', ')}`,
    );
  }
  const d = parsed.data as {
    killSwitches?: Partial<Record<Feature, boolean>>;
    youtubeOpenLink?: OpenLinkMode;
    limits?: {
      service?: Partial<Record<ServiceCounter, number>>;
      user?: Partial<Record<UserCounter, number>>;
    };
  };
  const cfg: RuntimeConfig = {
    killSwitches: { ...DEFAULT_RUNTIME.killSwitches, ...d.killSwitches },
    youtubeOpenLink: d.youtubeOpenLink ?? DEFAULT_RUNTIME.youtubeOpenLink,
    limits: {
      service: { ...DEFAULT_RUNTIME.limits.service, ...d.limits?.service },
      user: { ...DEFAULT_RUNTIME.limits.user, ...d.limits?.user },
    },
  };
  const s = cfg.limits.service;
  if (s.ytUnits > YOUTUBE_DAILY_UNITS) {
    throw new RuntimeConfigError(
      `limits.service.ytUnits는 YouTube 기본 할당 ${YOUTUBE_DAILY_UNITS}을 넘을 수 없습니다.`,
    );
  }
  if (s.ytSearchUser + s.ytSearchJob > YOUTUBE_DAILY_SEARCHES) {
    throw new RuntimeConfigError(
      `ytSearchUser + ytSearchJob은 YouTube 검색 한도 ${YOUTUBE_DAILY_SEARCHES}을 넘을 수 없습니다.`,
    );
  }
  return cfg;
}

export const RUNTIME_DOC = 'config/runtime';

export async function readRuntimeConfig(db: Firestore): Promise<RuntimeConfig> {
  const snap = await db.doc(RUNTIME_DOC).get();
  return parseRuntimeConfig(snap.exists ? snap.data() : undefined);
}

export class KillSwitchError extends Error {
  override name = 'KillSwitchError';
  constructor(readonly feature: Feature) {
    super(`관리자가 '${feature}' 기능을 정지했습니다.`);
  }
}

/** 기능이 정지 상태면 KillSwitchError. 설정이 깨져 있으면 RuntimeConfigError(= 정지로 취급). */
export async function assertEnabled(db: Firestore, feature: Feature): Promise<void> {
  const cfg = await readRuntimeConfig(db);
  if (!cfg.killSwitches[feature]) throw new KillSwitchError(feature);
}
