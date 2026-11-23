import { useEffect, useRef, useState, type FormEvent } from 'react';
import { SUPPORTED_LOCALES, type Locale, type MusicService } from '@musicweb/shared';
import {
  ApiError,
  type CreateFailReason,
  type CreateResult,
  type MusicwebApi,
  type SignedInUser,
  type OpenLinkMode,
  type UnsupportedCode,
} from './api';
import { useI18n, type MessageKey } from './i18n';
import { OpenInYouTube } from './OpenInYouTube';
import { Player, type PlayerHandle } from './player/Player';
import { SharedView } from './SharedView';
import { StatusView } from './StatusView';
import { Picker } from './Picker';
import { AdminView } from './AdminView';
import { SongRow } from './SongRow';

/** 검색창 글자 수 상한. 서버(parseRequest)와 같게 코드 포인트로 센다. */
export const MAX_REQUEST_CHARS = 200;
export const countChars = (s: string) => [...s.trim()].length;

const LOCALE_NAMES: Record<Locale, string> = { en: 'EN', ko: '한국어' };

type Success = Extract<CreateResult, { ok: true }>;
type Message = { key: MessageKey; vars?: Record<string, string> };

const UNSUPPORTED_MESSAGE: Record<UnsupportedCode, MessageKey> = {
  year: 'unsupported.year',
  mood: 'unsupported.mood',
  exclude_artist: 'unsupported.exclude_artist',
  genre: 'unsupported.genre',
  other: 'unsupported.other',
};

const FAIL_MESSAGE: Record<CreateFailReason, MessageKey> = {
  no_seed: 'errors.no_seed',
  seed_not_found: 'errors.seed_not_found',
  empty: 'errors.parse',
  too_long: 'errors.parse',
  no_output: 'errors.parse',
  schema_invalid: 'errors.parse',
  not_understood: 'errors.not_understood',
};

function errorMessage(err: unknown, locale: Locale): Message {
  if (!(err instanceof ApiError)) return { key: 'errors.generic' };
  const reason = err.details.reason;
  if (err.code === 'unauthenticated') return { key: 'errors.signIn' };
  if (reason === 'notAdmin') return { key: 'errors.notAdmin' };
  if (reason === 'killSwitch') return { key: 'errors.killSwitch' };
  if (reason === 'limit') {
    const at = err.details.resetAt ? new Date(err.details.resetAt) : null;
    const time = at
      ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(at)
      : '';
    return {
      key: err.details.scope === 'user' ? 'errors.userLimit' : 'errors.serviceLimit',
      vars: { time },
    };
  }
  if (reason === 'noSpare') return { key: 'errors.noSpare' };
  if (reason === 'blocked') return { key: 'errors.blocked' };
  if (reason === 'seedSongNotFound') return { key: 'errors.seedSongNotFound' };
  if (reason === 'lastSong') return { key: 'errors.lastSong' };
  if (reason === 'alreadySaved') return { key: 'errors.alreadySaved' };
  return { key: 'errors.generic' };
}

/** `/p/{id}` 공유 주소면 그 id */
export function sharedId(path: string): string | null {
  return /^\/p\/([A-Za-z0-9]{1,64})\/?$/.exec(path)?.[1] ?? null;
}

export function App({
  api,
  music,
  path = window.location.pathname,
}: {
  api: MusicwebApi;
  music: MusicService<HTMLElement>;
  path?: string;
}) {
  const shareId = sharedId(path);
  const isStatus = /^\/status\/?$/.test(path);
  const isAdmin = /^\/admin\/?$/.test(path);
  const { locale, setLocale, t } = useI18n();
  const [user, setUser] = useState<SignedInUser | null>(null);
  const [text, setText] = useState('');
  const [creating, setCreating] = useState(false);
  const [result, setResult] = useState<Success | null>(null);
  const [fail, setFail] = useState<CreateFailReason | null>(null);
  const [error, setError] = useState<Message | null>(null);
  const [busyRow, setBusyRow] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedId, setSavedId] = useState<string | null>(null);
  const [playing, setPlaying] = useState(-1);
  const player = useRef<PlayerHandle>(null);
  const resultsRef = useRef<HTMLElement>(null);
  // 새 재생목록이 나오면 결과로 화면을 내린다(곡 고르기·검색창 아래에 있어 안 보일 수 있다).
  // 플레이어는 절반 이상 보일 때만 다음 곡을 자동 재생하므로(youtube-policy) 보이게 두는 것이 중요하다.
  const resultId = result?.id;
  useEffect(() => {
    if (!resultId) return;
    resultsRef.current?.scrollIntoView?.({ block: 'start' });
    // 키보드·화면 읽기 사용자도 결과로 옮긴다
    resultsRef.current
      ?.querySelector<HTMLElement>('#results-title')
      ?.focus({ preventScroll: true });
  }, [resultId]);

  const [openLink, setOpenLink] = useState<OpenLinkMode>('direct');
  /** AI 없이 동작 중: 절약 모드(오늘) 또는 AI 키 없음 */
  const [aiOff, setAiOff] = useState<'saving' | 'noAi' | null>(null);

  useEffect(() => api.onUser(setUser), [api]);
  useEffect(() => {
    // 공유 화면은 playlists-get 응답에 방식이 같이 온다
    if (shareId || isStatus || isAdmin) return;
    let live = true;
    // 설정을 못 읽으면 기본(direct)으로 둔다. 링크가 깨졌을 때만 fallback이 저장된다.
    api
      .siteConfig()
      .then((c) => {
        if (!live) return;
        setOpenLink(c.openLink);
        setAiOff(c.savingMode ? 'saving' : c.noAi ? 'noAi' : null);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [api, shareId, isStatus, isAdmin]);

  const used = countChars(text);
  const over = used > MAX_REQUEST_CHARS;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (creating || over || used === 0) return;
    await run(() => api.create(text, locale));
  }

  /** 곡 고르기와 검색창이 같이 쓰는 만들기 흐름 */
  async function run(make: () => Promise<CreateResult>) {
    if (creating) return;
    setError(null);
    setFail(null);
    if (!user) {
      setError({ key: 'errors.signIn' });
      return;
    }
    setCreating(true);
    try {
      const r = await make();
      if (r.ok) {
        setResult(r);
        setPlaying(-1);
        setSavedId(null);
      } else {
        setFail(r.reason);
      }
    } catch (err) {
      setError(errorMessage(err, locale));
    } finally {
      setCreating(false);
    }
  }

  async function edit(action: 'remove' | 'replace', position: number) {
    if (!result) return;
    setError(null);
    setBusyRow(position);
    try {
      const { items } = await api.update(result.id, action, position);
      setResult({ ...result, items });
    } catch (err) {
      setError(errorMessage(err, locale));
    } finally {
      setBusyRow(null);
    }
  }

  async function save() {
    if (!result) return;
    setError(null);
    setSaving(true);
    try {
      const r = await api.save(result.id);
      setSavedId(r.id);
    } catch (err) {
      setError(errorMessage(err, locale));
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <header className="wrap topbar">
        <div className="brand">
          <span className="brand-dot" aria-hidden="true" />
          <span className="brand-name">musicweb</span>
          <span className="brand-onair">{t('brand.onAir')}</span>
        </div>
        <nav className="nav">
          <a href="/status">{t('nav.status')}</a>
          <a href="/me">{t('nav.myPlaylists')}</a>
        </nav>
        <div className="lang" role="group" aria-label={t('lang.label')}>
          {SUPPORTED_LOCALES.map((l) => (
            <button
              key={l}
              type="button"
              lang={l}
              aria-pressed={locale === l}
              onClick={() => setLocale(l)}
            >
              {LOCALE_NAMES[l]}
            </button>
          ))}
        </div>
        {user ? (
          <button type="button" className="btn-ghost" onClick={() => void api.signOut()}>
            {t('auth.signOut')}
          </button>
        ) : (
          <button type="button" className="btn-ghost" onClick={() => void api.signIn()}>
            {t('auth.signIn')}
          </button>
        )}
      </header>

      <main>
        {shareId ? (
          <SharedView api={api} music={music} id={shareId} />
        ) : isStatus ? (
          <StatusView api={api} />
        ) : isAdmin ? (
          // 계정이 바뀌면 화면 상태를 새로 시작한다(이전 관리자의 조회 결과가 남지 않게)
          <AdminView key={user?.uid ?? 'signed-out'} api={api} signedIn={user !== null} />
        ) : (
          <>
            <section className="wrap hero">
              <div className="kicker">{t('hero.kicker')}</div>
              <h1>{t('hero.title')}</h1>
              <p>{t('hero.subtitle')}</p>
              <Picker
                api={api}
                busy={creating}
                onPick={(input) => void run(() => api.createFromSong(input, locale))}
              />
              <p className="picker-or">{t('picker.orType')}</p>
              <form className="search" onSubmit={(e) => void submit(e)}>
                <label htmlFor="request" className="visually-hidden">
                  {t('search.label')}
                </label>
                <input
                  id="request"
                  type="text"
                  autoComplete="off"
                  placeholder={t('search.placeholder')}
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  aria-describedby="request-hints"
                  aria-invalid={over}
                />
                <button
                  type="submit"
                  className="btn-accent"
                  disabled={creating || over || used === 0}
                >
                  {t('search.submit')}
                </button>
              </form>
              <div className="hints" id="request-hints">
                <span>{t('search.hints', { max: MAX_REQUEST_CHARS })}</span>
                <span className="counter" data-over={over}>
                  {t('search.counter', { used, max: MAX_REQUEST_CHARS })}
                </span>
              </div>
              {aiOff && (
                <div className="notice notice-warn" role="status" data-testid="saving-mode">
                  {t(aiOff === 'saving' ? 'savingMode.notice' : 'savingMode.noAi')}
                </div>
              )}
              {over && (
                <div className="notice notice-error" role="alert">
                  {t('search.tooLong', { max: MAX_REQUEST_CHARS })}
                </div>
              )}
              {creating && (
                <div className="notice notice-info" role="status">
                  <span className="spinner" aria-hidden="true" />
                  {t('progress.working')}
                </div>
              )}
              {error && (
                <div className="notice notice-error" role="alert">
                  {t(error.key, error.vars)}
                </div>
              )}
              {fail && (
                <div className="notice notice-error" role="alert">
                  {t(FAIL_MESSAGE[fail])}
                  <ul>
                    <li>{t('errors.example1')}</li>
                    <li>{t('errors.example2')}</li>
                    <li>{t('errors.example3')}</li>
                  </ul>
                </div>
              )}
            </section>

            {result && (
              <section className="wrap results" aria-labelledby="results-title" ref={resultsRef}>
                <div className="card">
                  <div className="card-head">
                    <h2 id="results-title" tabIndex={-1}>
                      {t('results.title')}
                    </h2>
                    <span className="based-on">
                      {t('results.basedOn', {
                        title: result.seed.title,
                        artist: result.seed.artist,
                      })}
                    </span>
                  </div>
                  {result.unsupported.length > 0 && (
                    <div className="notice notice-warn" role="note">
                      {t('unsupported.title')}{' '}
                      {result.unsupported.map((c) => t(UNSUPPORTED_MESSAGE[c])).join(', ')}
                    </div>
                  )}
                  {result.shortfall && (
                    <div className="notice notice-warn" role="note">
                      {t('results.shortfall', {
                        got: String(result.shortfall.got),
                        requested: String(result.shortfall.requested),
                      })}
                    </div>
                  )}
                  <div className="card-body">
                    <Player
                      key={result.id}
                      ref={player}
                      items={result.items}
                      service={music}
                      onIndex={setPlaying}
                      onEmbedBlocked={(code) => void api.reportEmbedBlocked(code).catch(() => {})}
                    />
                    <ol className="songs">
                      {result.items.map((item, i) => (
                        <SongRow
                          key={`${item.songId}-${i}`}
                          item={item}
                          n={i + 1}
                          playing={i === playing}
                          disabled={busyRow !== null || savedId !== null}
                          onPlay={() => player.current?.playAt(i)}
                          onRemove={() => void edit('remove', i)}
                          onReplace={() => void edit('replace', i)}
                        />
                      ))}
                    </ol>
                  </div>
                  <div className="card-foot">
                    {savedId ? (
                      <p className="share" role="status">
                        {t('results.saved')}{' '}
                        <a href={`/p/${savedId}`}>{`${window.location.origin}/p/${savedId}`}</a>
                      </p>
                    ) : (
                      <button
                        type="button"
                        className="btn-light"
                        disabled={saving || busyRow !== null}
                        onClick={() => void save()}
                      >
                        {saving ? t('results.saving') : t('results.save')}
                      </button>
                    )}
                    <span className="source-note">{t('results.sourceNote')}</span>
                  </div>
                  <OpenInYouTube items={result.items} mode={openLink} />
                </div>
              </section>
            )}
          </>
        )}
      </main>

      <footer className="footer">
        <div className="wrap">
          <span>{t('results.sourceNote')}</span>
          <a href="/privacy">{t('footer.privacy')}</a>
          <a href="/terms">{t('footer.terms')}</a>
          <a href="/status">{t('footer.status')}</a>
        </div>
      </footer>
    </>
  );
}
