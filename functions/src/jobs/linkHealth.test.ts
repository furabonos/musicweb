import { describe, expect, it } from 'vitest';
import type { OpenLinkMode } from '../core/runtimeConfig.js';
import { memoryEvents } from '../testing/music.js';
import { runLinkHealth, type LinkHealthPorts } from './linkHealth.js';

function setup(opts: {
  ids?: string[];
  reply?: { status: number; listOk: boolean } | Error;
  mode?: OpenLinkMode;
}) {
  let mode: OpenLinkMode = opts.mode ?? 'direct';
  const logs: { kind: string; message: string }[] = [];
  const checked: string[][] = [];
  const ev = memoryEvents();
  const ports: LinkHealthPorts = {
    sampleVideoIds: async () => opts.ids ?? ['aaaaaaaaaaa', 'bbbbbbbbbbb'],
    check: async (ids) => {
      checked.push(ids);
      if (opts.reply instanceof Error) throw opts.reply;
      return opts.reply ?? { status: 303, listOk: true };
    },
    setMode: async (m) => {
      const before = mode;
      mode = m;
      return before;
    },
    opsLog: async (i) => void logs.push(i),
    events: ev.sink,
  };
  return { ports, logs, checked, events: ev.events, mode: () => mode };
}

describe('runLinkHealth', () => {
  it('303 + list=TL이면 정상: direct 유지, 이벤트 없음', async () => {
    const s = setup({});
    expect(await runLinkHealth(s.ports)).toBe('ok');
    expect(s.mode()).toBe('direct');
    expect(s.events.filter((e) => e.type === 'error')).toEqual([]);
    expect(s.events.at(-1)).toMatchObject({
      type: 'job_finished',
      attrs: { processed: 1, failed: 0 },
    });
  });

  it.each([
    ['303이지만 list=TL 없음', { status: 303, listOk: false }],
    ['200(재생목록 없이 열림)', { status: 200, listOk: false }],
    ['404', { status: 404, listOk: false }],
  ])('%s → fallback으로 바꾸고 open_link_broken 이벤트·운영 일지', async (_l, reply) => {
    const s = setup({ reply });
    expect(await runLinkHealth(s.ports)).toBe('broken');
    expect(s.mode()).toBe('fallback');
    expect(s.events.find((e) => e.type === 'error')?.attrs).toEqual({
      code: 'open_link_broken',
      where: 'linkHealth',
    });
    expect(s.logs.at(-1)).toMatchObject({ kind: 'issue' });
  });

  it('fallback이던 링크가 다시 되면 direct로 돌림', async () => {
    const s = setup({ mode: 'fallback' });
    expect(await runLinkHealth(s.ports)).toBe('ok');
    expect(s.mode()).toBe('direct');
    expect(s.logs.at(-1)?.message).toContain('works again');
  });

  it('확인 자체가 실패하면(연결 끊김·한도) 방식을 바꾸지 않음', async () => {
    const s = setup({ reply: new Error('budget exceeded'), mode: 'direct' });
    expect(await runLinkHealth(s.ports)).toBe('check_failed');
    expect(s.mode()).toBe('direct');
    expect(s.logs.at(-1)).toMatchObject({ kind: 'job_failed' });
  });

  it('결과를 저장하지 못하면(설정 문서가 깨짐 등) job_failed와 job_finished(failed 1)를 남김', async () => {
    const s = setup({ reply: { status: 200, listOk: false } });
    s.ports.setMode = async () => {
      throw new Error('config broken');
    };
    expect(await runLinkHealth(s.ports)).toBe('check_failed');
    expect(s.logs.at(-1)).toMatchObject({ kind: 'job_failed' });
    expect(s.events.at(-1)).toMatchObject({ type: 'job_finished', attrs: { failed: 1 } });
  });

  it('곡 목록에 영상이 없으면 확인하지 않음', async () => {
    const s = setup({ ids: [] });
    expect(await runLinkHealth(s.ports)).toBe('skipped');
    expect(s.checked).toEqual([]);
    expect(s.mode()).toBe('direct');
  });
});
