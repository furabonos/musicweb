import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import type { MusicPlayer, MusicService } from '@musicweb/shared';
import type { PlayableItem } from '../api';
import { useI18n } from '../i18n';
import {
  createPlaybackController,
  type EmbedBlockedCode,
  type PlaybackController,
} from './controller';
import { PLAYER_SIZE } from './youtube';

export interface PlayerHandle {
  /** 곡 목록에서 누른 곡 재생(사용자 클릭) */
  playAt(index: number): void;
}

/**
 * 사이트 재생 (SPEC 4.5, T15). 플레이어 영역(640×360) 위에는 아무것도 겹치지 않는다.
 * 곡 정보·버튼은 플레이어 아래에 둔다. 플레이어 iframe은 YouTube API가 만들고 지우므로
 * React가 그리지 않는 자식 div에 붙인다.
 */
export function Player({
  items,
  service,
  onEmbedBlocked,
  onIndex,
  ref,
}: {
  items: PlayableItem[];
  service: MusicService<HTMLElement>;
  onEmbedBlocked(code: EmbedBlockedCode): void;
  onIndex?(index: number): void;
  ref?: Ref<PlayerHandle>;
}) {
  const { t } = useI18n();
  const frame = useRef<HTMLDivElement>(null);
  const ctrl = useRef<PlaybackController | null>(null);
  const latestItems = useRef(items);
  const visible = useRef(0);
  // 최신 콜백(화면이 다시 그려져도 플레이어를 새로 만들지 않기 위해 ref로 들고 있음)
  const callbacks = useRef({ onEmbedBlocked, onIndex });
  useEffect(() => {
    callbacks.current = { onEmbedBlocked, onIndex };
  }, [onEmbedBlocked, onIndex]);
  const [index, setIndex] = useState(-1);
  const [failed, setFailed] = useState(false);

  useImperativeHandle(ref, () => ({ playAt: (i) => ctrl.current?.select(i) }), []);

  // 플레이어가 절반 넘게 보일 때만 자동으로 다음 곡을 튼다
  useEffect(() => {
    const el = frame.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) visible.current = e.intersectionRatio;
      },
      { threshold: [0, 0.5, 1] },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    const el = frame.current;
    if (!el) return;
    const slot = document.createElement('div');
    el.appendChild(slot);
    let player: MusicPlayer | null = null;
    let cancelled = false;
    service
      .mount(slot, {
        onEnded: () => ctrl.current?.ended(),
        onError: (code) => ctrl.current?.error(code),
      })
      .then((p) => {
        if (cancelled) return p.destroy();
        player = p;
        ctrl.current = createPlaybackController({
          player: p,
          items: latestItems.current,
          canAutoplay: () => visible.current >= 0.5 && document.visibilityState === 'visible',
          onEmbedBlocked: (code) => callbacks.current.onEmbedBlocked(code),
          onIndex: (i) => {
            setIndex(i);
            callbacks.current.onIndex?.(i);
          },
        });
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
      ctrl.current = null;
      player?.destroy();
      el.replaceChildren();
    };
  }, [service]);

  useEffect(() => {
    latestItems.current = items;
    ctrl.current?.setItems(items);
  }, [items]);

  const item = items[index];
  const total = items.length;
  return (
    <div className="player-col">
      <div
        className="player-frame"
        ref={frame}
        style={{ width: PLAYER_SIZE.width, height: PLAYER_SIZE.height }}
        aria-label={t('player.label')}
        role="region"
      />
      {failed && (
        <p className="player-failed" role="alert">
          {t('player.loadFailed')}
        </p>
      )}
      <div className="player-meta">
        <button
          type="button"
          className="round-btn"
          aria-label={t('player.previous')}
          onClick={() => ctrl.current?.previous()}
        >
          <svg
            aria-hidden="true"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path d="M19 5L9 12l10 7V5zM5 5v14" />
          </svg>
        </button>
        <button
          type="button"
          className="round-btn"
          aria-label={t('player.next')}
          onClick={() => ctrl.current?.next()}
        >
          <svg
            aria-hidden="true"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path d="M5 5l10 7-10 7V5zM19 5v14" />
          </svg>
        </button>
        <div className="now-playing" aria-live="polite">
          <div className="now-label">
            {t('player.nowPlaying', {
              n: index < 0 ? '--' : String(index + 1).padStart(2, '0'),
              total: String(total).padStart(2, '0'),
            })}
          </div>
          <div className="now-title">{item?.title ?? ''}</div>
          <div className="now-artist">{item?.artist ?? ''}</div>
        </div>
      </div>
      <p className="player-source">{t('player.source')}</p>
    </div>
  );
}
