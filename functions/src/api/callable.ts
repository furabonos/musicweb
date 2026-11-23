import {
  onCall as firebaseOnCall,
  type CallableFunction,
  type CallableOptions,
  type CallableRequest,
} from 'firebase-functions/v2/https';
import { appCheckEnforced } from '../config/runtimeEnv.js';

/**
 * 모든 callable은 이 함수로 만든다 (T23, SPEC 6.1). 실제 배포에서는 App Check 토큰이 없는 호출을 거부한다.
 * firebase-functions의 onCall을 직접 쓰면 ESLint가 막는다(빠뜨리는 것을 막기 위해).
 * 옵션에서 enforceAppCheck를 끌 수 없다.
 */
type Handler<T, R> = (request: CallableRequest<T>) => R;
type Ret<R> = R extends Promise<unknown> ? R : Promise<R>;

export function onCall<T = unknown, R = unknown>(
  handler: Handler<T, R>,
): CallableFunction<T, Ret<R>>;
export function onCall<T = unknown, R = unknown>(
  opts: Omit<CallableOptions<T>, 'enforceAppCheck'>,
  handler: Handler<T, R>,
): CallableFunction<T, Ret<R>>;
export function onCall<T, R>(
  a: Omit<CallableOptions<T>, 'enforceAppCheck'> | Handler<T, R>,
  b?: Handler<T, R>,
): CallableFunction<T, Ret<R>> {
  const opts = typeof a === 'function' ? {} : a;
  const handler = typeof a === 'function' ? a : (b as Handler<T, R>);
  return firebaseOnCall<T, R>({ ...opts, enforceAppCheck: appCheckEnforced() }, handler);
}
