import type { MusicPlayer } from '@musicweb/shared';

/**
 * 재생 순서 (SPEC 4.5, T15, D-032). 플레이어 종류와 무관한 규칙만 둔다(가짜 플레이어로 단위 테스트).
 * - 처음에는 첫 곡을 올려만 둔다. 첫 재생은 사용자가 누를 때(곡 선택·플레이어의 재생 버튼).
 * - 곡이 끝나면 다음 곡. 플레이어가 절반 넘게 보이고 탭이 보일 때만 자동 재생하고, 아니면 올려만 둔다
 *   (스킬 youtube-policy: 보일 때만 자동 재생, 백그라운드 재생 금지).
 * - 오류 101·150(퍼가기 불가)은 기록하고 다음 곡으로. 다른 오류(삭제된 영상 등)도 건너뛴다.
 * - 영상이 없는 곡(지금 재생할 수 없음)은 건너뛴다. 마지막 곡 뒤에는 멈춘다.
 */
export const EMBED_BLOCKED_CODES = [101, 150] as const;
export type EmbedBlockedCode = (typeof EMBED_BLOCKED_CODES)[number];

export interface PlaybackItem {
  videoId: string | null;
}

export interface PlaybackController {
  current(): number;
  select(index: number): void;
  next(): void;
  previous(): void;
  ended(): void;
  error(code: number): void;
  setItems(items: PlaybackItem[]): void;
}

export function createPlaybackController(opts: {
  player: MusicPlayer;
  items: PlaybackItem[];
  /** 지금 자동 재생해도 되는가(플레이어가 절반 넘게 보이고 탭이 보임) */
  canAutoplay(): boolean;
  onEmbedBlocked(code: EmbedBlockedCode): void;
  onIndex?(index: number): void;
}): PlaybackController {
  const { player } = opts;
  let items = opts.items;
  let index = -1;
  // 사용자가 재생을 시작했는가(곡 선택·이전·다음, 또는 곡이 끝까지 재생됨). 시작 전에는 절대 재생하지 않는다.
  let started = false;

  const playableFrom = (start: number, step: 1 | -1) => {
    for (let i = start; i >= 0 && i < items.length; i += step) if (items[i]?.videoId) return i;
    return -1;
  };
  const go = (i: number, mode: 'play' | 'cue') => {
    const id = items[i]?.videoId;
    if (!id) return;
    index = i;
    if (mode === 'play') player.play(id);
    else player.cue(id);
    opts.onIndex?.(i);
  };
  const advance = () => {
    const n = playableFrom(index + 1, 1);
    if (n < 0) return; // 마지막 곡 뒤: 멈춤
    go(n, started && opts.canAutoplay() ? 'play' : 'cue');
  };

  const first = playableFrom(0, 1);
  if (first >= 0) go(first, 'cue');

  return {
    current: () => index,
    select(i) {
      if (!items[i]?.videoId) return;
      started = true;
      go(i, 'play');
    },
    next() {
      const n = playableFrom(index + 1, 1);
      if (n < 0) return;
      started = true;
      go(n, 'play');
    },
    previous() {
      const p = playableFrom(index - 1, -1);
      if (p < 0) return;
      started = true;
      go(p, 'play');
    },
    ended() {
      // 끝까지 재생됐다면 사용자가 플레이어에서 직접 재생을 시작한 것이다
      started = true;
      advance();
    },
    error(code) {
      if ((EMBED_BLOCKED_CODES as readonly number[]).includes(code))
        opts.onEmbedBlocked(code as EmbedBlockedCode);
      advance();
    },
    setItems(next) {
      const currentId = items[index]?.videoId ?? null;
      items = next;
      const same = currentId ? next.findIndex((x) => x.videoId === currentId) : -1;
      if (same >= 0) {
        index = same;
        opts.onIndex?.(same);
        return;
      }
      const at = playableFrom(Math.max(0, Math.min(index, next.length - 1)), 1);
      const fallback = at >= 0 ? at : playableFrom(0, 1);
      if (fallback >= 0) go(fallback, 'cue');
      else {
        index = -1;
        opts.onIndex?.(-1);
      }
    },
  };
}
