import type { PlayableItem } from './api';
import { useI18n } from './i18n';

/** 곡 한 줄. 빼기·바꾸기를 넘기지 않으면(공유 화면) 그 버튼이 없다. */
export function SongRow(props: {
  item: PlayableItem;
  n: number;
  playing: boolean;
  disabled?: boolean;
  onPlay(): void;
  onRemove?(): void;
  onReplace?(): void;
}) {
  const { t } = useI18n();
  const { item } = props;
  return (
    <li className="song" aria-current={props.playing ? 'true' : undefined}>
      <button
        type="button"
        className="song-n"
        aria-label={t('results.play', { title: item.title })}
        disabled={!item.videoId}
        onClick={props.onPlay}
      >
        {String(props.n).padStart(2, '0')}
      </button>
      <div className="song-main">
        <div className="song-title">
          {item.title}
          <span className="song-artist">{item.artist}</span>
        </div>
        {/* AI가 쓴 이유는 글자로만 그린다(React가 HTML로 해석하지 않음, D-030) */}
        <div className="song-reason">{item.reason ?? t('results.noReason')}</div>
        {!item.videoId && <div className="song-unavailable">{t('results.unavailable')}</div>}
      </div>
      {props.onReplace && props.onRemove && (
        <>
          <button
            type="button"
            className="icon-btn"
            aria-label={t('results.replace', { title: item.title })}
            disabled={props.disabled}
            onClick={props.onReplace}
          >
            <svg
              aria-hidden="true"
              width="17"
              height="17"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M4 7h13l-3-3M20 17H7l3 3" />
            </svg>
          </button>
          <button
            type="button"
            className="icon-btn"
            aria-label={t('results.remove', { title: item.title })}
            disabled={props.disabled}
            onClick={props.onRemove}
          >
            <svg
              aria-hidden="true"
              width="17"
              height="17"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </>
      )}
    </li>
  );
}
