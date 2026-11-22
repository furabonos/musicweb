import { useEffect, useRef, useState } from 'react';
import type { MusicService } from '@musicweb/shared';
import { ApiError, type MusicwebApi, type SharedPlaylist } from './api';
import { SongRow } from './SongRow';
import { useI18n } from './i18n';
import { OpenInYouTube } from './OpenInYouTube';
import { Player, type PlayerHandle } from './player/Player';

/**
 * 공유 재생목록 `/p/:id` (SPEC 4.6, 4.13, T16). 로그인 없이 보고 재생하고 YouTube에서 연다.
 * 검색 문장은 서버가 돌려주지 않는다. 빼기·바꾸기는 없다(보기 전용).
 */
export function SharedView({
  api,
  music,
  id,
}: {
  api: MusicwebApi;
  music: MusicService<HTMLElement>;
  id: string;
}) {
  const { t } = useI18n();
  const [state, setState] = useState<
    | { kind: 'loading' }
    | { kind: 'missing' }
    | { kind: 'error' }
    | { kind: 'ready'; p: SharedPlaylist }
  >({ kind: 'loading' });
  const [playing, setPlaying] = useState(-1);
  const player = useRef<PlayerHandle>(null);

  useEffect(() => {
    let live = true;
    api
      .getPlaylist(id)
      .then((p) => live && setState({ kind: 'ready', p }))
      .catch((err: unknown) => {
        if (!live) return;
        setState({
          kind: err instanceof ApiError && err.code === 'not-found' ? 'missing' : 'error',
        });
      });
    return () => {
      live = false;
    };
  }, [api, id]);

  if (state.kind === 'loading')
    return (
      <section className="wrap results">
        <div className="notice notice-info" role="status">
          <span className="spinner" aria-hidden="true" />
          {t('shared.loading')}
        </div>
      </section>
    );
  if (state.kind !== 'ready')
    return (
      <section className="wrap results">
        <div className="notice notice-error" role="alert">
          {t(state.kind === 'missing' ? 'shared.notFound' : 'errors.generic')}{' '}
          <a href="/">{t('shared.makeYourOwn')}</a>
        </div>
      </section>
    );

  const { p } = state;
  return (
    <section className="wrap results" aria-labelledby="shared-title">
      <div className="card">
        <div className="card-head">
          <h2 id="shared-title">{t('shared.title')}</h2>
          <span className="based-on">
            {t('results.basedOn', { title: p.seed.title, artist: p.seed.artist })}
          </span>
        </div>
        <div className="card-body">
          <Player
            key={p.id}
            ref={player}
            items={p.items}
            service={music}
            onIndex={setPlaying}
            onEmbedBlocked={(code) => void api.reportEmbedBlocked(code).catch(() => {})}
          />
          <ol className="songs">
            {p.items.map((item, i) => (
              <SongRow
                key={`${item.songId}-${i}`}
                item={item}
                n={i + 1}
                playing={i === playing}
                onPlay={() => player.current?.playAt(i)}
              />
            ))}
          </ol>
        </div>
        <div className="card-foot">
          <a className="btn-ghost" href="/">
            {t('shared.makeYourOwn')}
          </a>
          <span className="source-note">{t('results.sourceNote')}</span>
        </div>
        <OpenInYouTube items={p.items} mode={p.openLink} />
      </div>
    </section>
  );
}
