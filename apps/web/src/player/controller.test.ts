import type { MusicPlayer } from '@musicweb/shared';
import { describe, expect, it, vi } from 'vitest';
import { createPlaybackController, EMBED_BLOCKED_CODES } from './controller';

function fakePlayer() {
  const calls: string[] = [];
  const player: MusicPlayer = {
    cue: (id) => calls.push(`cue:${id}`),
    play: (id) => calls.push(`play:${id}`),
    destroy: () => calls.push('destroy'),
  };
  return { player, calls };
}

const items = (...ids: (string | null)[]) => ids.map((videoId) => ({ videoId }));

function setup(list = items('a', 'b', 'c'), visible = true) {
  const { player, calls } = fakePlayer();
  const onEmbedBlocked = vi.fn();
  const onIndex = vi.fn();
  const c = createPlaybackController({
    player,
    items: list,
    canAutoplay: () => visible,
    onEmbedBlocked,
    onIndex,
  });
  return { c, calls, onEmbedBlocked, onIndex };
}

describe('재생 순서 (가짜 플레이어)', () => {
  it('처음에는 첫 곡을 올려만 두고 재생하지 않음(첫 재생은 사용자 클릭)', () => {
    const { calls, c } = setup();
    expect(calls).toEqual(['cue:a']);
    expect(c.current()).toBe(0);
  });

  it('곡을 누르면 그 곡을 재생', () => {
    const { c, calls, onIndex } = setup();
    c.select(1);
    expect(calls).toEqual(['cue:a', 'play:b']);
    expect(onIndex).toHaveBeenLastCalledWith(1);
  });

  it('ENDED에서 다음 곡을 재생', () => {
    const { c, calls } = setup();
    c.select(0);
    c.ended();
    expect(calls).toEqual(['cue:a', 'play:a', 'play:b']);
    expect(c.current()).toBe(1);
  });

  it('플레이어가 절반 넘게 보이지 않거나 탭이 가려지면 다음 곡을 올려만 둠(자동 재생 안 함)', () => {
    const { c, calls } = setup(items('a', 'b'), false);
    c.select(0);
    c.ended();
    expect(calls).toEqual(['cue:a', 'play:a', 'cue:b']);
  });

  it('마지막 곡 뒤에는 멈춤(더 부르지 않음)', () => {
    const { c, calls, onIndex } = setup(items('a', 'b'));
    c.select(1);
    c.ended();
    expect(calls).toEqual(['cue:a', 'play:b']);
    expect(c.current()).toBe(1);
    expect(onIndex).toHaveBeenLastCalledWith(1);
  });

  it.each([101, 150])('오류 %i(퍼가기 불가)면 기록하고 다음 곡으로 건너뜀', (code) => {
    const { c, calls, onEmbedBlocked } = setup();
    c.select(0);
    c.error(code);
    expect(onEmbedBlocked).toHaveBeenCalledWith(code);
    expect(calls).toEqual(['cue:a', 'play:a', 'play:b']);
    expect(EMBED_BLOCKED_CODES).toContain(code);
  });

  it('다른 오류(삭제된 영상 등)도 건너뛰지만 퍼가기 불가로 기록하지 않음', () => {
    const { c, calls, onEmbedBlocked } = setup();
    c.select(0);
    c.error(100);
    expect(onEmbedBlocked).not.toHaveBeenCalled();
    expect(calls.at(-1)).toBe('play:b');
  });

  it('영상이 없는 곡(지금 재생 불가)은 건너뜀, 처음 곡이 없으면 다음 곡을 올려 둠', () => {
    const { c, calls } = setup(items(null, 'b', null, 'd'));
    expect(calls).toEqual(['cue:b']);
    c.ended();
    expect(calls).toEqual(['cue:b', 'play:d']);
  });

  it('이전·다음 버튼은 재생할 수 있는 곡 사이를 오간다', () => {
    const { c, calls } = setup(items('a', null, 'c'));
    c.next();
    c.previous();
    expect(calls).toEqual(['cue:a', 'play:c', 'play:a']);
  });

  it('목록이 바뀌어도(빼기·바꾸기) 지금 곡이 남아 있으면 플레이어를 건드리지 않고 위치만 맞춤', () => {
    const { c, calls } = setup(items('a', 'b', 'c'));
    c.select(1);
    c.setItems(items('x', 'a', 'b', 'c'));
    expect(c.current()).toBe(2);
    expect(calls).toEqual(['cue:a', 'play:b']);
  });

  it('지금 곡이 빠지면 그 자리의 곡을 올려 둠(재생 중이던 소리를 다른 곡으로 바로 바꾸지 않음)', () => {
    const { c, calls } = setup(items('a', 'b', 'c'));
    c.select(1);
    c.setItems(items('a', 'c'));
    expect(c.current()).toBe(1);
    expect(calls.at(-1)).toBe('cue:c');
  });
});

describe('사용자가 재생을 시작하기 전', () => {
  it('첫 곡을 올려 둔 상태에서 오류가 나도 다음 곡을 재생하지 않고 올려만 둠(기록은 보냄)', () => {
    const { c, calls, onEmbedBlocked } = setup();
    c.error(150);
    expect(onEmbedBlocked).toHaveBeenCalledWith(150);
    expect(calls).toEqual(['cue:a', 'cue:b']);
  });

  it('곡이 끝까지 재생됐다면(플레이어에서 직접 재생) 그다음부터는 자동 진행', () => {
    const { c, calls } = setup();
    c.ended();
    expect(calls).toEqual(['cue:a', 'play:b']);
  });

  it('목록이 바뀌어 재생할 곡이 없으면 위치를 -1로 알림', () => {
    const { c, onIndex } = setup(items('a'));
    c.setItems(items(null));
    expect(c.current()).toBe(-1);
    expect(onIndex).toHaveBeenLastCalledWith(-1);
  });
});
