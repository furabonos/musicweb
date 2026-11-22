import type { MusicPlayer, MusicService, PlayerEvents } from '@musicweb/shared';

/**
 * YouTube 공식 IFrame 플레이어 (SPEC 4.5, T15, D-032, 스킬 youtube-policy).
 * - 공식 API 스크립트(https://www.youtube.com/iframe_api)를 한 번만 불러온다.
 * - 모든 영상을 youtube-nocookie.com(추적 쿠키 없는 모드)으로 튼다. 아동용 영상은 추적 없이 틀어야 하는데,
 *   곡마다 갈아 끼우지 않고 전부 같은 방식으로 틀어 그 규칙을 항상 지킨다.
 * - 크기는 640×360(최소 480×270 이상). 플레이어 위에는 아무것도 겹치지 않는다(Player.tsx).
 */
export const IFRAME_API_URL = 'https://www.youtube.com/iframe_api';
export const PLAYER_HOST = 'https://www.youtube-nocookie.com';
export const PLAYER_SIZE = { width: 640, height: 360 };

/** 이 앱이 쓰는 YT IFrame API 부분 */
export interface YtPlayer {
  cueVideoById(id: string): void;
  loadVideoById(id: string): void;
  destroy(): void;
}
interface YtNamespace {
  Player: new (
    el: HTMLElement,
    opts: {
      width: number;
      height: number;
      host: string;
      playerVars: Record<string, number | string>;
      events: {
        onReady(): void;
        onStateChange(e: { data: number }): void;
        onError(e: { data: number }): void;
      };
    },
  ) => YtPlayer;
  PlayerState: { ENDED: number };
}
type YtWindow = Window & { YT?: YtNamespace; onYouTubeIframeAPIReady?: () => void };

let loading: Promise<YtNamespace> | null = null;

/** 공식 API를 불러온다(한 번만). */
export function loadIframeApi(win: YtWindow = window): Promise<YtNamespace> {
  if (win.YT?.Player) return Promise.resolve(win.YT);
  loading ??= new Promise<YtNamespace>((resolve, reject) => {
    const prev = win.onYouTubeIframeAPIReady;
    win.onYouTubeIframeAPIReady = () => {
      prev?.();
      if (win.YT) resolve(win.YT);
    };
    const s = win.document.createElement('script');
    s.src = IFRAME_API_URL;
    s.async = true;
    s.onerror = () => {
      loading = null;
      reject(new Error('YouTube 플레이어를 불러오지 못했습니다.'));
    };
    win.document.head.appendChild(s);
  });
  return loading;
}

/** 테스트용: 불러오기 상태 초기화 */
export function resetIframeApiForTests() {
  loading = null;
}

export function createYouTubeService(win: YtWindow = window): MusicService<HTMLElement> {
  return {
    name: 'youtube',
    async mount(container: HTMLElement, events: PlayerEvents): Promise<MusicPlayer> {
      const YT = await loadIframeApi(win);
      return new Promise<MusicPlayer>((resolve) => {
        const yt: YtPlayer = new YT.Player(container, {
          ...PLAYER_SIZE,
          host: PLAYER_HOST,
          // playsinline: 페이지 안에서 재생. 자동 재생(autoplay)은 켜지 않는다(첫 재생은 사용자 클릭).
          playerVars: { playsinline: 1, origin: win.location.origin },
          events: {
            onReady: () =>
              resolve({
                cue: (id) => yt.cueVideoById(id),
                play: (id) => yt.loadVideoById(id),
                destroy: () => yt.destroy(),
              }),
            onStateChange: (e) => {
              if (e.data === YT.PlayerState.ENDED) events.onEnded();
            },
            onError: (e) => events.onError(e.data),
          },
        });
      });
    },
  };
}
