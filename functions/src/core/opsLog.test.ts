import { describe, expect, it } from 'vitest';
import { OpsLogError, opsLogEntry } from './opsLog.js';

describe('opsLogEntry', () => {
  it('정상 항목은 종류·문장·링크·시각을 갖는다', () => {
    const e = opsLogEntry({
      kind: 'issue',
      message: ' Broken link detected for 3 songs. ',
      links: ['https://github.com/furabonos/musicweb/issues/12'],
    });
    expect(e).toMatchObject({
      kind: 'issue',
      message: 'Broken link detected for 3 songs.',
      links: ['https://github.com/furabonos/musicweb/issues/12'],
    });
    expect(e.at).toBeDefined();
    expect(opsLogEntry({ kind: 'job', message: 'ok' }).links).toEqual([]);
  });

  it.each([
    ['이메일', { kind: 'admin_change', message: 'Changed by admin@example.com' }],
    ['너무 긴 문장', { kind: 'job', message: 'x'.repeat(201) }],
    ['빈 문장', { kind: 'job', message: '   ' }],
    ['줄바꿈', { kind: 'job', message: 'a\nb' }],
    [
      'uid처럼 보이는 값',
      { kind: 'admin_change', message: 'Admin synced Xk3pQ9aLm2Rt7Vb1Nc8Zd4Ey6Wf.' },
    ],
    ['모르는 종류', { kind: 'search', message: 'x' }],
    ['다른 사이트 링크', { kind: 'pr', message: 'x', links: ['https://evil.example/pull/1'] }],
    [
      '다른 저장소 링크',
      { kind: 'pr', message: 'x', links: ['https://github.com/other/repo/pull/1'] },
    ],
    [
      '링크 6개',
      {
        kind: 'pr',
        message: 'x',
        links: Array(6).fill('https://github.com/furabonos/musicweb/pull/1'),
      },
    ],
  ])('거부: %s', (_n, input) => {
    expect(() => opsLogEntry(input as Parameters<typeof opsLogEntry>[0])).toThrow(OpsLogError);
  });

  it('Actions 실행 링크와 PR 링크는 받는다', () => {
    expect(() =>
      opsLogEntry({
        kind: 'pr',
        message: 'CI passed.',
        links: [
          'https://github.com/furabonos/musicweb/pull/3',
          'https://github.com/furabonos/musicweb/actions/runs/44899246840/job/136831466635',
        ],
      }),
    ).not.toThrow();
  });
});
