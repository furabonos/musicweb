import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * 사용자 연결 정보(YouTube 토큰 등) 암호화. AES-256-GCM, 키 버전으로 교체 가능.
 * - 키 문자열(TOKEN_ENC_KEY): "v2:<base64 32바이트>,v1:<base64 32바이트>" — 첫 항목이 현재(암호화) 키.
 * - 문맥(context): 암호문을 특정 대상(예: "secrets_oauth:<uid>")에 묶는다. 다른 사용자 문서로 옮기면 열리지 않는다.
 * - 결과 형식: "<버전>.<iv>.<tag>.<암호문>" (각 base64url).
 */
export interface Keyring {
  current: string;
  keys: ReadonlyMap<string, Buffer>;
}

const IV_BYTES = 12;
const TAG_BYTES = 16;

export function parseKeyring(text: string): Keyring {
  const entries = text
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (entries.length === 0) throw new Error('암호화 키 문자열이 비어 있습니다.');
  const keys = new Map<string, Buffer>();
  let current: string | undefined;
  for (const entry of entries) {
    const match = /^([A-Za-z0-9_-]+):([A-Za-z0-9+/=_-]+)$/.exec(entry);
    const version = match?.[1];
    const b64 = match?.[2];
    if (!version || !b64)
      throw new Error('암호화 키 형식이 잘못됐습니다. "v1:<base64>"처럼 쓰세요.');
    const key = Buffer.from(b64, 'base64');
    if (key.length !== 32) throw new Error(`암호화 키 ${version}는 32바이트여야 합니다.`);
    if (keys.has(version)) throw new Error(`암호화 키 버전 ${version}이(가) 중복됐습니다.`);
    keys.set(version, key);
    current ??= version;
  }
  if (!current) throw new Error('암호화 키 문자열이 비어 있습니다.');
  return { current, keys };
}

export interface Sealer {
  seal(plaintext: string, context: string): string;
  open(sealed: string, context: string): string;
}

export function createSealer(ring: Keyring): Sealer {
  const requireContext = (context: string) => {
    if (!context) throw new Error('암호화 문맥(context)이 필요합니다. 예: "secrets_oauth:<uid>".');
    return Buffer.from(context, 'utf8');
  };
  return {
    seal(plaintext, context) {
      const aad = requireContext(context);
      const key = ring.keys.get(ring.current);
      if (!key) throw new Error(`현재 키 버전 ${ring.current}의 키가 없습니다.`);
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(aad);
      const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      return [ring.current, iv, tag, body]
        .map((p) => (typeof p === 'string' ? p : p.toString('base64url')))
        .join('.');
    },
    open(sealed, context) {
      const aad = requireContext(context);
      const parts = sealed.split('.');
      if (parts.length !== 4) throw new Error('암호문 형식이 잘못됐습니다.');
      const [version, ivText, tagText, bodyText] = parts as [string, string, string, string];
      const key = ring.keys.get(version);
      if (!key) throw new Error(`모르는 키 버전입니다: ${version}`);
      const iv = Buffer.from(ivText, 'base64url');
      const tag = Buffer.from(tagText, 'base64url');
      if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES)
        throw new Error('암호문 형식이 잘못됐습니다.');
      const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
      decipher.setAAD(aad);
      decipher.setAuthTag(tag);
      return Buffer.concat([
        decipher.update(Buffer.from(bodyText, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
    },
  };
}
