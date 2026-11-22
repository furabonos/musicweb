import { watchLink, watchVideosLinks, YOUTUBE_VIDEO_ID } from '@musicweb/shared';
import type { OpenLinkMode, PlayableItem } from './api';
import { useI18n } from './i18n';

/**
 * "YouTube에서 열기" (SPEC 4.6, D-006, T16). 로그인 없이 쓴다.
 * - direct: watch_videos 링크(50곡마다 하나). YouTube에서 열린 목록은 직접 저장하라고 안내한다.
 * - fallback(매일 확인에서 링크가 깨짐): 곡별 YouTube 링크 목록.
 * 지금 재생할 수 없는 곡(영상 없음)과 형식이 틀린 영상 ID는 빠진다(링크 만들기가 거부하므로 화면이 멈추지 않게).
 */
export function OpenInYouTube({ items, mode }: { items: PlayableItem[]; mode: OpenLinkMode }) {
  const { t } = useI18n();
  const playable = items.filter(
    (i): i is PlayableItem & { videoId: string } => !!i.videoId && YOUTUBE_VIDEO_ID.test(i.videoId),
  );
  if (!playable.length) return null;

  if (mode === 'fallback') {
    return (
      <div className="open-yt">
        <p className="open-note">{t('open.fallbackTitle')}</p>
        <ol className="open-list">
          {playable.map((i, n) => (
            <li key={`${n}-${i.videoId}`}>
              <a href={watchLink(i.videoId)} target="_blank" rel="noopener">
                {i.title} — {i.artist}
              </a>
            </li>
          ))}
        </ol>
      </div>
    );
  }

  const links = watchVideosLinks(playable.map((i) => i.videoId));
  return (
    <div className="open-yt">
      <div className="open-buttons">
        {links.map((href, n) => (
          <a key={href} className="btn-light" href={href} target="_blank" rel="noopener">
            {links.length > 1
              ? t('open.part', { n: n + 1, total: links.length })
              : t('open.button')}
          </a>
        ))}
      </div>
      <p className="open-note">{t('open.note')}</p>
    </div>
  );
}
