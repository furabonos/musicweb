import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createSealer, parseKeyring } from './crypto.js';

const k1 = randomBytes(32);
const k2 = randomBytes(32);
const keyringText = (entries: [string, Buffer][]) =>
  entries.map(([v, k]) => `${v}:${k.toString('base64')}`).join(',');

describe('parseKeyring', () => {
  it('첫 항목이 현재 키, 나머지는 복호화 전용', () => {
    const ring = parseKeyring(
      keyringText([
        ['v2', k2],
        ['v1', k1],
      ]),
    );
    expect(ring.current).toBe('v2');
    expect([...ring.keys.keys()].sort()).toEqual(['v1', 'v2']);
  });

  it.each([
    ['', '비어'],
    ['v1', '형식'],
    [`v1:${randomBytes(16).toString('base64')}`, '32바이트'],
    [`v1:${k1.toString('base64')},v1:${k2.toString('base64')}`, '중복'],
    [`v 1:${k1.toString('base64')}`, '형식'],
  ])('잘못된 키 문자열은 거부한다: %j', (text, message) => {
    expect(() => parseKeyring(text)).toThrow(message);
  });
});

describe('parseKeyring 오류 메시지', () => {
  it('잘못된 키 문자열의 오류에 키 값이 들어 있지 않다', () => {
    const short = randomBytes(16).toString('base64');
    const messages: string[] = [];
    for (const text of [
      `v1:${short}`,
      `v1:${k1.toString('base64')},v1:${k1.toString('base64')}`,
      `bad ${short}`,
    ]) {
      try {
        parseKeyring(text);
      } catch (e) {
        messages.push((e as Error).message);
      }
    }
    expect(messages).toHaveLength(3);
    for (const m of messages) {
      expect(m).not.toContain(short);
      expect(m).not.toContain(k1.toString('base64'));
    }
  });

  it('constructor 같은 이름도 평범한 버전 이름으로 다룬다', () => {
    const ring = parseKeyring(`constructor:${k1.toString('base64')}`);
    expect(ring.current).toBe('constructor');
    expect(createSealer(ring).open(createSealer(ring).seal('x', 'ctx'), 'ctx')).toBe('x');
  });
});

describe('createSealer (AES-256-GCM)', () => {
  const sealer = createSealer(parseKeyring(keyringText([['v1', k1]])));

  it('암호화한 값을 같은 문맥으로 복호화하면 원문', () => {
    const sealed = sealer.seal('refresh-token-abc', 'uid:alice');
    expect(sealed.startsWith('v1.')).toBe(true);
    expect(sealed).not.toContain('refresh-token-abc');
    expect(sealer.open(sealed, 'uid:alice')).toBe('refresh-token-abc');
  });

  it('같은 평문도 매번 다른 암호문', () => {
    const a = sealer.seal('same', 'uid:alice');
    const b = sealer.seal('same', 'uid:alice');
    expect(a).not.toBe(b);
  });

  it('다른 문맥(다른 사용자)으로는 열 수 없다', () => {
    const sealed = sealer.seal('token', 'uid:alice');
    expect(() => sealer.open(sealed, 'uid:bob')).toThrow();
  });

  it('잘못된 키로는 열 수 없다', () => {
    const other = createSealer(parseKeyring(keyringText([['v1', k2]])));
    expect(() => other.open(sealer.seal('token', 'ctx'), 'ctx')).toThrow();
  });

  it('암호문·인증 태그·IV를 한 글자라도 바꾸면 열 수 없다', () => {
    const sealed = sealer.seal('token', 'ctx');
    const parts = sealed.split('.');
    expect(parts).toHaveLength(4);
    parts.forEach((part, i) => {
      if (i === 0) return; // 버전 표시는 따로 검사
      const buf = Buffer.from(part, 'base64url');
      buf.writeUInt8(buf.readUInt8(0) ^ 0x01, 0);
      const tampered = parts.map((p, j) => (j === i ? buf.toString('base64url') : p));
      expect(() => sealer.open(tampered.join('.'), 'ctx')).toThrow();
    });
  });

  it('형식이 깨졌거나 모르는 키 버전이면 열 수 없다', () => {
    expect(() => sealer.open('garbage', 'ctx')).toThrow('형식');
    const sealed = sealer.seal('token', 'ctx').replace(/^v1\./, 'v9.');
    expect(() => sealer.open(sealed, 'ctx')).toThrow('키 버전');
    for (const proto of ['constructor', 'toString', '__proto__']) {
      const odd = sealer.seal('token', 'ctx').replace(/^v1\./, `${proto}.`);
      expect(() => sealer.open(odd, 'ctx')).toThrow('키 버전');
    }
  });

  it('키를 교체해도 예전 버전 암호문은 열리고, 새 암호문은 새 버전', () => {
    const rotated = createSealer(
      parseKeyring(
        keyringText([
          ['v2', k2],
          ['v1', k1],
        ]),
      ),
    );
    const old = sealer.seal('token', 'ctx');
    expect(rotated.open(old, 'ctx')).toBe('token');
    expect(rotated.seal('token', 'ctx').startsWith('v2.')).toBe(true);
  });

  it('빈 문맥은 거부한다 (사용자별로 묶지 않은 암호화 방지)', () => {
    expect(() => sealer.seal('token', '')).toThrow('문맥');
  });
});
