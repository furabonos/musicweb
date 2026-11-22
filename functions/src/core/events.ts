import { createHmac } from 'node:crypto';
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { z } from 'zod';
import { FEATURES, SERVICE_COUNTERS, USER_COUNTERS } from './runtimeConfig.js';

/**
 * 이벤트 로그 (SPEC 4.1, T07, D-023).
 *
 * - 이벤트 종류마다 attrs 스키마가 있고, 정의되지 않은 필드는 저장 전에 거부한다(strictObject).
 * - 글자 값은 짧은 식별자만 받는다(ID 패턴: 64자 이하, 공백·@ 없음). 검색 문장·재생목록 이름·이메일은
 *   스키마로 들어갈 수 없고, 저장 직전에 모든 값을 한 번 더 훑어 이메일·긴 글을 거부한다(두 겹).
 * - 사용자는 uid 원문 대신 ACTOR_HASH_KEY로 만든 HMAC 해시(actorHash)로만 남는다.
 * - events 컬렉션은 보안 규칙에 match가 없어 서버 전용이다(D-019).
 */

/** 짧은 식별자: 영문·숫자와 _ . : - 만, 64자 이하. 자유 텍스트·이메일·주소가 들어가지 않는다. */
const id = z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/);
const count = z.number().int().nonnegative().max(1_000_000_000);
/** 소요 시간 위쪽 제한: 15분 (Cloud Functions 최대 실행 시간보다 길게). */
const MAX_DURATION_MS = 15 * 60 * 1000;
const locale = z.enum(['en', 'ko']);

export const EXTERNAL_TARGETS = [
  'youtube_read',
  'youtube_write',
  'musicbrainz',
  'listenbrainz',
  'wikidata',
  'lastfm',
  'llm',
  'github',
] as const;

/** 외부 호출 종류. 어댑터를 추가하면 여기에 그 호출 이름을 더한다(자유 문자열을 받지 않기 위함). */
export const EXTERNAL_OPS = [
  'playlists.insert',
  'playlistItems.insert',
  'musicbrainz.recording.search',
  'musicbrainz.recording.get',
  'musicbrainz.artist.get',
  'listenbrainz.recording.search',
  'listenbrainz.similarRecordings',
  'listenbrainz.similarArtists',
  'wikidata.sparql',
  'lastfm.track.getSimilar',
  'channels.list',
  'playlistItems.list',
  'videos.list',
  'search.list',
  'llm.parseRequest',
  'llm.judgeLink',
  'llm.candidates',
  'llm.pick',
] as const;
export type ExternalOp = (typeof EXTERNAL_OPS)[number];

export const JOBS = [
  'ingest',
  'refresh',
  'purge',
  'linkHealth',
  'dailyEval',
  'metrics',
  'githubStats',
] as const;

/** 이벤트 종류 → attrs 스키마. 새 종류는 여기에 추가한다(스키마 없는 종류는 기록되지 않음). */
export const EVENT_SCHEMAS = {
  request_parsed: z.strictObject({ locale, requestedCount: count }),
  request_parse_failed: z.strictObject({ reason: id }),
  recommend_step: z.strictObject({
    step: z.enum(['seed', 'candidates', 'catalog_filter', 'lookup', 'ai_pick']),
    candidates: count,
    filtered: count,
    hallucinated: count,
  }),
  song_linked: z.strictObject({
    kind: z.enum(['official_audio', 'mv', 'live', 'cover', 'remix', 'other']),
    // 소수 둘째 자리까지만(숫자에 다른 정보를 싣지 못하게)
    score: z.number().min(0).max(1).multipleOf(0.01),
    byAi: z.boolean(),
  }),
  song_removed: z.strictObject({ position: count }),
  song_replaced: z.strictObject({ position: count }),
  external_call: z.strictObject({
    target: z.enum(EXTERNAL_TARGETS),
    op: z.enum(EXTERNAL_OPS),
    units: count.optional(),
    costMicroUsd: count.optional(),
    status: z.number().int().min(0).max(999).optional(),
  }),
  limit_reached: z.strictObject({
    scope: z.enum(['service', 'user']),
    counter: z.enum([...SERVICE_COUNTERS, ...USER_COUNTERS]),
  }),
  kill_switch_blocked: z.strictObject({ feature: z.enum(FEATURES) }),
  error: z.strictObject({ code: id, where: id }),
  job_started: z.strictObject({ job: z.enum(JOBS) }),
  job_finished: z.strictObject({ job: z.enum(JOBS), processed: count, failed: count }),
  admin_change: z.strictObject({ action: id }),
  // 수집 대상 아티스트가 연속으로 실패함 (3회면 failed). MBID는 공개 음악 데이터 ID라 개인정보가 아니다.
  artist_ingest_failed: z.strictObject({
    artistMbid: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
    failCount: count,
    status: z.enum(['active', 'failed']),
  }),
  // 재시도해도 응답이 없을 때(429·503·연결 실패). 추천은 다른 출처로 대신한다(스킬 music-data-terms).
  source_unavailable: z.strictObject({
    source: z.enum(['musicbrainz', 'listenbrainz', 'wikidata', 'lastfm']),
    status: z.number().int().min(0).max(999).optional(),
  }),
  embed_blocked: z.strictObject({ code: z.union([z.literal(101), z.literal(150)]) }),
} as const;

export type EventType = keyof typeof EVENT_SCHEMAS;
export type EventAttrs<T extends EventType> = z.infer<(typeof EVENT_SCHEMAS)[T]>;
export type Outcome = 'ok' | 'error' | 'rejected';

export interface EventInput<T extends EventType = EventType> {
  type: T;
  attrs: EventAttrs<T>;
  outcome: Outcome;
  durationMs?: number;
  /** 누가 했는지. 저장할 때 해시로 바뀌고 원문은 남지 않는다. */
  actorUid?: string;
}

export interface EventRecord {
  type: EventType;
  attrs: Record<string, unknown>;
  outcome: Outcome;
  durationMs: number | null;
  actorHash: string | null;
}

export class EventSchemaError extends Error {
  override name = 'EventSchemaError';
}

const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const MAX_STRING = 64;
export const OPAQUE_TOKEN = /[A-Za-z0-9]{20,}/;

/** 스키마와 별개로 모든 글자 값을 훑는다: 이메일 형식, 64자 넘는 글, 공백이 든 글은 거부. */
export function assertNoFreeText(value: unknown, path: string): void {
  if (typeof value === 'string') {
    if (EMAIL.test(value))
      throw new EventSchemaError(`${path}: 이메일 형식 값은 저장하지 않습니다.`);
    if (value.length > MAX_STRING || /\s/.test(value)) {
      throw new EventSchemaError(`${path}: 자유 텍스트(긴 글·문장)는 저장하지 않습니다.`);
    }
    // uid·토큰·외부 ID처럼 보이는 긴 영숫자 덩어리(구분자 없이 20자 이상)는 식별자 필드에 넣지 않는다.
    if (OPAQUE_TOKEN.test(value)) {
      throw new EventSchemaError(`${path}: uid·토큰처럼 보이는 값은 저장하지 않습니다.`);
    }
    return;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) assertNoFreeText(v, `${path}.${k}`);
  }
}

const MIN_KEY_BYTES = 32;

/** 같은 uid는 같은 해시. 키가 없으면 해시를 만들 수 없으므로 막는 쪽으로 실패. */
export function actorHash(uid: string, hashKey: string): string {
  if (Buffer.byteLength(hashKey, 'utf8') < MIN_KEY_BYTES) {
    throw new EventSchemaError(`ACTOR_HASH_KEY는 ${MIN_KEY_BYTES}바이트 이상이어야 합니다.`);
  }
  if (!uid) throw new EventSchemaError('uid가 비었습니다.');
  return createHmac('sha256', hashKey).update(`actor:${uid}`).digest('base64url');
}

/** 검사하고 저장할 형태로 바꾼다. 문제가 있으면 EventSchemaError. */
export function buildEvent(input: EventInput, hashKey: string): EventRecord {
  const schema = EVENT_SCHEMAS[input.type] as z.ZodType | undefined;
  if (!schema) throw new EventSchemaError(`정의되지 않은 이벤트 종류: ${String(input.type)}`);
  const allowed = new Set(['type', 'attrs', 'outcome', 'durationMs', 'actorUid']);
  const extra = Object.keys(input).filter((k) => !allowed.has(k));
  if (extra.length) throw new EventSchemaError(`정의되지 않은 필드: ${extra.join(', ')}`);

  const parsed = schema.safeParse(input.attrs);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => i.path.join('.') || '(attrs)').join(', ');
    throw new EventSchemaError(`${input.type} attrs가 스키마와 맞지 않습니다: ${fields}`);
  }
  assertNoFreeText(parsed.data, 'attrs');
  if (input.actorUid !== undefined && containsValue(parsed.data, input.actorUid)) {
    throw new EventSchemaError(
      'attrs에 uid 원문을 넣지 않습니다(actorUid로 넘기면 해시로 저장됨).',
    );
  }
  if (!['ok', 'error', 'rejected'].includes(input.outcome)) {
    throw new EventSchemaError(`outcome 값이 잘못됐습니다.`);
  }
  const d = input.durationMs;
  if (d !== undefined && (!Number.isFinite(d) || d < 0 || d > MAX_DURATION_MS)) {
    throw new EventSchemaError(`durationMs는 0~${MAX_DURATION_MS}이어야 합니다.`);
  }
  return {
    type: input.type,
    attrs: parsed.data as Record<string, unknown>,
    outcome: input.outcome,
    durationMs: d === undefined ? null : Math.round(d),
    actorHash: input.actorUid === undefined ? null : actorHash(input.actorUid, hashKey),
  };
}

function containsValue(value: unknown, needle: string): boolean {
  if (typeof value === 'string')
    return value === needle || (needle.length >= 6 && value.includes(needle));
  if (value && typeof value === 'object')
    return Object.values(value).some((v) => containsValue(v, needle));
  return false;
}

/** 어댑터·함수가 받는 기록기. 테스트는 메모리 구현을 넣는다. */
export interface EventSink {
  record(input: EventInput): Promise<void>;
}

/**
 * Firestore events 컬렉션에 쓰는 기록기.
 * - 잘못된 이벤트(스키마 위반)는 코드 버그이므로 던진다: 테스트에서 바로 드러나게.
 * - 저장 실패(일시 오류)는 사용자 동작을 막지 않게 삼키고 서버 로그에 이름만 남긴다.
 */
export function firestoreEventSink(db: Firestore, hashKey: string): EventSink {
  // 키가 없거나 짧으면 여기서 바로 실패한다: 외부 호출을 하기 전, 함수가 시작할 때 드러나게.
  actorHash('key-check', hashKey);
  return {
    async record(input) {
      const event = buildEvent(input, hashKey);
      try {
        await db.collection('events').add({ ...event, at: FieldValue.serverTimestamp() });
      } catch (err) {
        console.error('이벤트 저장 실패', {
          type: event.type,
          error: err instanceof Error ? err.name : 'unknown',
        });
      }
    },
  };
}

export interface CallOutcome<T> {
  result: T;
  units?: number;
  costMicroUsd?: number;
  status?: number;
}

/**
 * 외부 호출 공통 기록: 대상, 단위·비용, 소요 시간, 결과를 external_call 이벤트로 남긴다.
 * 어댑터가 실제 호출을 이 함수로 감싼다. 호출이 실패하면 error로 기록하고 원래 오류를 다시 던진다.
 * 실패한 호출에도 비용이 났으면 onError로 단위·상태를 알려 준다.
 *
 * 기록 자체가 실패해도(스키마 위반 포함) 호출 결과와 원래 오류는 바꾸지 않는다: 외부 요청은 이미 끝났고,
 * 여기서 던지면 호출자(예: youtube-write)가 성공한 쓰기를 실패로 보고 기록·정산이 틀어진다.
 * 대신 서버 로그에 이름만 남긴다. 스키마 위반은 테스트(같은 buildEvent를 쓰는 메모리 sink)에서 잡는다.
 */
export async function recordCall<T>(
  sink: EventSink,
  call: { target: (typeof EXTERNAL_TARGETS)[number]; op: ExternalOp; actorUid?: string },
  fn: () => Promise<CallOutcome<T>>,
  onError?: (err: unknown) => { units?: number; costMicroUsd?: number; status?: number },
  clock: () => number = Date.now,
): Promise<T> {
  const started = clock();
  const write = async (
    outcome: Outcome,
    extra: {
      units?: number | undefined;
      costMicroUsd?: number | undefined;
      status?: number | undefined;
    },
  ) => {
    try {
      await sink.record({
        type: 'external_call',
        attrs: { target: call.target, op: call.op, ...defined(extra) },
        outcome,
        durationMs: clock() - started,
        ...(call.actorUid === undefined ? {} : { actorUid: call.actorUid }),
      });
    } catch (err) {
      console.error('외부 호출 기록 실패 (호출 결과는 그대로)', {
        target: call.target,
        op: call.op,
        error: err instanceof Error ? err.name : 'unknown',
      });
    }
  };
  let outcome: CallOutcome<T>;
  try {
    outcome = await fn();
  } catch (err) {
    let extra = {};
    try {
      extra = onError?.(err) ?? {};
    } catch {
      // onError가 실패해도 원래 오류를 지킨다
    }
    await write('error', extra);
    throw err;
  }
  await write('ok', {
    units: outcome.units,
    costMicroUsd: outcome.costMicroUsd,
    status: outcome.status,
  });
  return outcome.result;
}

function defined<T extends Record<string, unknown>>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
