import type { Firestore } from 'firebase-admin/firestore';
import { consume } from '../core/budget.js';
import { recordCall, type EventSink, type ExternalOp } from '../core/events.js';

/**
 * 음악 데이터 출처 공통 요청 (T08, D-024, 스킬 music-data-terms).
 *
 * - 출처마다 초당 1회 이하: 같은 출처의 요청은 줄을 서고, 앞 요청 시작에서 1초가 지나야 다음이 나간다.
 *   줄은 함수 인스턴스 안에서만 공유된다(여러 인스턴스가 동시에 돌면 합이 1초 1회를 넘을 수 있다 → 수집 작업은 인스턴스 1개).
 * - User-Agent에 연락처(MB_CONTACT)를 넣는다. 연락처가 없으면 클라이언트를 만들지 않는다.
 * - 요청마다(재시도 포함) budget의 musicDataCalls 1을 쓴다. 상한에 닿으면 BudgetExceededError.
 * - 429·503·연결 실패는 Retry-After(최대 30초) 또는 2초·4초 쉬고 다시 한다. 다 실패하면 source_unavailable 이벤트와
 *   SourceUnavailableError. 다른 오류 상태는 바로 SourceHttpError.
 * - 요청마다 external_call 이벤트를 남긴다. 주소(키가 들어갈 수 있음)는 기록·오류 메시지에 넣지 않는다.
 */

export type MusicSource = 'musicbrainz' | 'listenbrainz' | 'wikidata' | 'lastfm';

/** 요청 한 번에 쓸 양을 예약한다. 상한이면 BudgetExceededError를 던진다. */
export interface CallBudget {
  spendCall(source: MusicSource): Promise<void>;
}

/**
 * 운영용: Firestore 한도 카운터(usage/{day}.musicDataCalls)에 1씩 쓴다.
 * 요청 1번 = 1로 정산할 것이 없어서 예약 기록 없는 consume을 쓴다(쓰기 1번, D-024).
 */
export function firestoreCallBudget(db: Firestore): CallBudget {
  return { spendCall: () => consume(db, { service: { musicDataCalls: 1 } }) };
}

export interface MusicHttpDeps {
  events: EventSink;
  budget: CallBudget;
  /** MB_CONTACT. 연락 가능한 주소(메일 또는 웹 주소). */
  contact: string;
  fetch?: typeof fetch;
  /** 테스트용 시계. 줄(limiter)과 별개다: 시계만 바꿔도 초당 1회 줄은 공유된다. */
  now?: () => number;
  /** 테스트용 줄. 없으면 인스턴스 안에서 출처별로 공유하는 줄을 쓴다. */
  limiter?: RateLimiter;
}

export class SourceUnavailableError extends Error {
  override name = 'SourceUnavailableError';
  constructor(
    readonly source: MusicSource,
    readonly status: number | null,
  ) {
    super(`${source} 응답 없음 (status=${status ?? 'network'})`);
  }
}

export class SourceHttpError extends Error {
  override name = 'SourceHttpError';
  constructor(
    readonly source: MusicSource,
    readonly status: number,
  ) {
    super(`${source} 요청 실패 (status=${status})`);
  }
}

export class MusicConfigError extends Error {
  override name = 'MusicConfigError';
}

export const APP_USER_AGENT = 'musicweb/0.1';
const MIN_INTERVAL_MS = 1_000;
const MAX_RETRIES = 2;
const MAX_RETRY_WAIT_MS = 30_000;
/** 출처가 이보다 오래 쉬라고 하면 그 시간만큼 이 출처를 쉰다(재시도는 하지 않음). */
const MAX_PUSHBACK_MS = 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15_000;

/** 출처별 줄. 앞 요청 시작에서 interval이 지나야 다음 요청을 내보낸다. */
export class RateLimiter {
  private nextAt = 0;
  private tail: Promise<void> = Promise.resolve();
  constructor(
    private readonly intervalMs: number,
    private readonly sleep: (ms: number) => Promise<void>,
    private readonly now: () => number,
  ) {}

  /** 차례가 오면 끝난다. */
  wait(): Promise<void> {
    const turn = this.tail.then(async () => {
      const delay = this.nextAt - this.now();
      if (delay > 0) await this.sleep(delay);
      this.nextAt = this.now() + this.intervalMs;
    });
    this.tail = turn.catch(() => undefined);
    return turn;
  }

  /** 출처가 "잠시 멈춤"을 알렸을 때 다음 요청을 그만큼 미룬다(최대 1시간). */
  pushBack(ms: number): void {
    this.nextAt = Math.max(this.nextAt, this.now() + Math.min(ms, MAX_PUSHBACK_MS));
  }
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
// 인스턴스 안에서 출처별로 하나. 테스트는 deps.limiter로 따로 넣는다.
const sharedLimiters = new Map<MusicSource, RateLimiter>();

export function newRateLimiter(sleep: (ms: number) => Promise<void>, now: () => number) {
  return new RateLimiter(MIN_INTERVAL_MS, sleep, now);
}

function limiterFor(source: MusicSource, deps: MusicHttpDeps): RateLimiter {
  if (deps.limiter) return deps.limiter;
  let l = sharedLimiters.get(source);
  if (!l) {
    l = new RateLimiter(MIN_INTERVAL_MS, realSleep, Date.now);
    sharedLimiters.set(source, l);
  }
  return l;
}

export function userAgent(contact: string): string {
  const c = contact.trim();
  // 연락처가 없거나 헤더를 깨는 글자가 있으면 시작하지 않는다.
  if (!c || /[\r\n()]/.test(c) || c.length > 200) {
    throw new MusicConfigError(
      'MB_CONTACT(연락처)가 없거나 형식이 잘못돼 음악 데이터 요청을 시작하지 않습니다.',
    );
  }
  return `${APP_USER_AGENT} ( ${c} )`;
}

export interface GetOptions {
  accept?: string;
  /** 응답 본문으로 "잠시 멈춤"을 판단해야 하는 출처(Last.fm error 29)용. */
  isThrottled?: (status: number, body: unknown) => boolean;
}

export interface GetResult {
  body: unknown;
  status: number;
  headers: Headers;
}

/** 한 출처의 요청 도구. 어댑터가 하나씩 만든다. */
export function createSourceClient(source: MusicSource, deps: MusicHttpDeps) {
  const ua = userAgent(deps.contact);
  const doFetch = deps.fetch ?? fetch;
  const limiter = limiterFor(source, deps);
  const now = deps.now ?? Date.now;

  async function attempt(url: string, op: ExternalOp, opts: GetOptions): Promise<GetResult> {
    await deps.budget.spendCall(source);
    await limiter.wait();
    return recordCall(
      deps.events,
      { target: source, op },
      async () => {
        let res: Response;
        try {
          res = await doFetch(url, {
            method: 'GET',
            headers: { 'User-Agent': ua, Accept: opts.accept ?? 'application/json' },
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          });
        } catch {
          throw new RetryableError(null, null);
        }
        let raw: string;
        try {
          raw = await res.text();
        } catch {
          // 본문 받는 중 끊김·시간 초과도 연결 실패와 같게 다룬다.
          throw new RetryableError(null, null);
        }
        const body = parseJson(raw);
        // ListenBrainz: 남은 횟수가 0이면 초기화까지 다음 요청을 미룬다.
        if (res.headers.get('X-RateLimit-Remaining') === '0') {
          const resetIn = Number(res.headers.get('X-RateLimit-Reset-In'));
          if (Number.isFinite(resetIn) && resetIn > 0) limiter.pushBack(resetIn * 1000);
        }
        const throttled =
          res.status === 429 ||
          res.status === 503 ||
          (opts.isThrottled?.(res.status, body) ?? false);
        if (throttled) throw new RetryableError(res.status, retryAfterMs(res.headers, now()));
        if (!res.ok) throw new SourceHttpError(source, res.status);
        if (body === null) throw new SourceHttpError(source, res.status);
        return { result: { body, status: res.status, headers: res.headers }, status: res.status };
      },
      (err) =>
        err instanceof RetryableError && err.status !== null
          ? { status: err.status }
          : err instanceof SourceHttpError
            ? { status: err.status }
            : {},
    );
  }

  return {
    source,
    async get(url: string, op: ExternalOp, opts: GetOptions = {}): Promise<GetResult> {
      let last: RetryableError | undefined;
      for (let i = 0; i <= MAX_RETRIES; i++) {
        try {
          return await attempt(url, op, opts);
        } catch (err) {
          if (!(err instanceof RetryableError)) throw err;
          last = err;
          const wait = err.retryAfterMs ?? 2_000 * 2 ** i;
          // 실제 기다림은 다음 차례에서 줄(limiter)이 한다. 실패로 끝나도 다른 호출이 바로 다시 두드리지 않게 미뤄 둔다.
          limiter.pushBack(wait);
          // 서버가 30초 넘게 쉬라고 하면 기다리며 붙잡지 않고 바로 포기한다(그 시간 동안 이 출처는 쉰다).
          if (i === MAX_RETRIES || wait > MAX_RETRY_WAIT_MS) break;
        }
      }
      const status = last?.status ?? null;
      await deps.events.record({
        type: 'source_unavailable',
        attrs: { source, ...(status === null ? {} : { status }) },
        outcome: 'error',
      });
      throw new SourceUnavailableError(source, status);
    },
  };
}

export type SourceClient = ReturnType<typeof createSourceClient>;

function parseJson(raw: string): unknown {
  try {
    return raw ? (JSON.parse(raw) as unknown) : null;
  } catch {
    return null;
  }
}

class RetryableError extends Error {
  override name = 'RetryableError';
  constructor(
    readonly status: number | null,
    readonly retryAfterMs: number | null,
  ) {
    super(`retryable status=${status ?? 'network'}`);
  }
}

function retryAfterMs(headers: Headers, now: number): number | null {
  const v = headers.get('Retry-After');
  if (!v) return null;
  const sec = Number(v);
  if (Number.isFinite(sec) && sec >= 0) return sec * 1000;
  const at = Date.parse(v);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

/** MBID(UUID) 형식 확인. 주소·검색어·SPARQL에 넣기 전에 반드시 거친다. */
export const MBID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function assertMbid(id: string): string {
  if (typeof id !== 'string' || !MBID.test(id))
    throw new MusicConfigError('MBID 형식이 잘못됐습니다.');
  return id;
}

/** 외부 글자 값: 문자열이면 다듬어 돌려주고, 아니면 null. 길이를 제한한다. */
export function text(v: unknown, max = 300): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
}

/** "1997-05-21" → 1997 */
export function yearOf(v: unknown): number | null {
  const m = typeof v === 'string' ? /^(\d{4})/.exec(v) : null;
  if (!m) return null;
  const y = Number(m[1]);
  return y >= 1800 && y <= 2200 ? y : null;
}

const YT_VIDEO = /^[A-Za-z0-9_-]{11}$/;
/** YouTube 영상 주소 → 영상 ID. 아니면 null. */
export function youtubeVideoId(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^www\.|^m\./, '');
  let id: string | null = null;
  if ((host === 'youtube.com' || host === 'music.youtube.com') && u.pathname === '/watch') {
    id = u.searchParams.get('v');
  } else if (host === 'youtu.be') {
    id = u.pathname.slice(1);
  }
  return id && YT_VIDEO.test(id) ? id : null;
}

const YT_CHANNEL = /^UC[A-Za-z0-9_-]{22}$/;
/** YouTube 채널 주소 → 채널 ID(UC…). @이름 주소는 ID를 알 수 없어 null. */
export function youtubeChannelId(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^www\.|^m\./, '');
  if (host !== 'youtube.com' && host !== 'music.youtube.com') return null;
  const m = /^\/channel\/([^/]+)\/?$/.exec(u.pathname);
  return m && m[1] && YT_CHANNEL.test(m[1]) ? m[1] : null;
}

export const isYoutubeVideoId = (v: unknown): v is string =>
  typeof v === 'string' && YT_VIDEO.test(v);
export const isYoutubeChannelId = (v: unknown): v is string =>
  typeof v === 'string' && YT_CHANNEL.test(v);
