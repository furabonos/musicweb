import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createYouTubeService,
  IFRAME_API_URL,
  loadIframeApi,
  PLAYER_HOST,
  resetIframeApiForTests,
} from './youtube';

afterEach(() => {
  resetIframeApiForTests();
  document.head.querySelectorAll('script').forEach((s) => s.remove());
  delete (window as { YT?: unknown }).YT;
  delete (window as { onYouTubeIframeAPIReady?: unknown }).onYouTubeIframeAPIReady;
});

/** 가짜 YT 네임스페이스: 만든 플레이어의 설정과 호출을 기록 */
function installFakeYT() {
  const made: {
    opts: Record<string, unknown>;
    calls: string[];
    fire: Record<string, (e?: { data: number }) => void>;
  }[] = [];
  class Player {
    calls: string[] = [];
    constructor(
      _el: HTMLElement,
      opts: { events: Record<string, (e?: { data: number }) => void> } & Record<string, unknown>,
    ) {
      made.push({ opts, calls: this.calls, fire: opts.events });
      queueMicrotask(() => opts.events.onReady?.());
    }
    cueVideoById(id: string) {
      this.calls.push(`cue:${id}`);
    }
    loadVideoById(id: string) {
      this.calls.push(`load:${id}`);
    }
    destroy() {
      this.calls.push('destroy');
    }
  }
  (window as { YT?: unknown }).YT = { Player, PlayerState: { ENDED: 0 } };
  return made;
}

describe('loadIframeApi', () => {
  it('공식 API 스크립트를 한 번만 넣고, 준비 신호가 오면 끝남', async () => {
    const a = loadIframeApi();
    const b = loadIframeApi();
    const scripts = [...document.head.querySelectorAll('script')];
    expect(scripts.map((s) => s.src)).toEqual([IFRAME_API_URL]);
    installFakeYT();
    (window as { onYouTubeIframeAPIReady?: () => void }).onYouTubeIframeAPIReady?.();
    await expect(a).resolves.toBeDefined();
    await expect(b).resolves.toBeDefined();
  });
});

describe('createYouTubeService', () => {
  it('nocookie 주소·640×360·자동 재생 없이 만들고, cue/play를 공식 함수로 넘김', async () => {
    const made = installFakeYT();
    const onEnded = vi.fn();
    const onError = vi.fn();
    const p = await createYouTubeService().mount(document.createElement('div'), {
      onEnded,
      onError,
    });
    const m = made[0];
    expect(m?.opts).toMatchObject({ width: 640, height: 360, host: PLAYER_HOST });
    expect(m?.opts.playerVars).not.toHaveProperty('autoplay');
    p.cue('vid1');
    p.play('vid2');
    expect(m?.calls).toEqual(['cue:vid1', 'load:vid2']);

    m?.fire.onStateChange?.({ data: 1 });
    expect(onEnded).not.toHaveBeenCalled();
    m?.fire.onStateChange?.({ data: 0 });
    expect(onEnded).toHaveBeenCalledOnce();
    m?.fire.onError?.({ data: 150 });
    expect(onError).toHaveBeenCalledWith(150);
  });
});
