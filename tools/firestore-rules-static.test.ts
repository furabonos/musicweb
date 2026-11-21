import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// 보안 규칙 파일 자체를 읽어 "클라이언트 쓰기 없음" 원칙을 고정한다 (SPEC 5, 6.2).
// 줄이 아니라 "allow <종류>: if <조건>;" 문장 단위로 본다 (한 줄에 여러 문장, 줄바꿈된 문장도 잡기 위해).
const stripComments = (text: string) => text.replace(/\/\/.*$/gm, '');

export function allowStatements(rules: string): { kinds: string[]; condition: string }[] {
  const out: { kinds: string[]; condition: string }[] = [];
  for (const m of stripComments(rules).matchAll(/allow\s+([^:]+?)\s*:\s*if\s+([^;]+);/g)) {
    out.push({
      kinds: (m[1] ?? '').split(',').map((k) => k.trim()),
      condition: (m[2] ?? '').replace(/\s+/g, ' ').trim(),
    });
  }
  return out;
}

const WRITE_KINDS = ['write', 'create', 'update', 'delete'];

describe('allowStatements (검사기 자체)', () => {
  it('한 줄에 두 문장, 줄바꿈된 문장도 각각 뽑는다', () => {
    const text =
      'allow read, write: if false; allow update: if true;\nallow\n  delete\n  : if request.auth != null;';
    expect(allowStatements(text)).toEqual([
      { kinds: ['read', 'write'], condition: 'false' },
      { kinds: ['update'], condition: 'true' },
      { kinds: ['delete'], condition: 'request.auth != null' },
    ]);
  });

  it('주석 안의 allow는 무시한다', () => {
    expect(allowStatements('// allow write: if true;\nallow read: if true;')).toEqual([
      { kinds: ['read'], condition: 'true' },
    ]);
  });
});

describe.each(['firestore.rules', 'storage.rules'])('%s', (file) => {
  const statements = allowStatements(readFileSync(file, 'utf8'));

  it('allow 문장을 하나 이상 찾았다 (검사기가 빈손으로 통과하지 않게)', () => {
    expect(statements.length).toBeGreaterThan(0);
  });

  it('쓰기 종류(write/create/update/delete)는 조건이 정확히 false일 때만 있다', () => {
    const openWrites = statements.filter(
      (s) => s.kinds.some((k) => WRITE_KINDS.includes(k)) && s.condition !== 'false',
    );
    expect(
      openWrites,
      '클라이언트 쓰기는 Functions(callable)로만 합니다. 규칙에서 쓰기를 열지 말고 서버 함수를 만드세요.',
    ).toEqual([]);
  });

  it('"if true"로 여는 것은 읽기 종류(read/get/list)뿐이다', () => {
    for (const s of statements.filter((x) => x.condition === 'true')) {
      expect(
        s.kinds.every((k) => ['read', 'get', 'list'].includes(k)),
        JSON.stringify(s),
      ).toBe(true);
    }
  });
});
