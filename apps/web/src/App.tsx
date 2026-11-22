import { useEffect, useState, type FormEvent } from 'react';
import { SUPPORTED_LOCALES, type Locale } from '@musicweb/shared';
import {
  ApiError,
  type CreateFailReason,
  type CreateResult,
  type MusicwebApi,
  type PlayableItem,
  type SignedInUser,
  type UnsupportedCode,
} from './api';
import { useI18n, type MessageKey } from './i18n';

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
  if (reason === 'lastSong') return { key: 'errors.lastSong' };
  if (reason === 'alreadySaved') return { key: 'errors.alreadySaved' };
  return { key: 'errors.generic' };
}

export function App({ api }: { api: MusicwebApi }) {
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

  useEffect(() => api.onUser(setUser), [api]);

  const used = countChars(text);
  const over = used > MAX_REQUEST_CHARS;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (creating || over || used === 0) return;
    setError(null);
    setFail(null);
    if (!user) {
      setError({ key: 'errors.signIn' });
      return;
    }
    setCreating(true);
    try {
      const r = await api.create(text, locale);
      if (r.ok) {
        setResult(r);
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
        <section className="wrap hero">
          <div className="kicker">{t('hero.kicker')}</div>
          <h1>{t('hero.title')}</h1>
          <p>{t('hero.subtitle')}</p>
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
            <button type="submit" className="btn-accent" disabled={creating || over || used === 0}>
              {t('search.submit')}
            </button>
          </form>
          <div className="hints" id="request-hints">
            <span>{t('search.hints', { max: MAX_REQUEST_CHARS })}</span>
            <span className="counter" data-over={over}>
              {t('search.counter', { used, max: MAX_REQUEST_CHARS })}
            </span>
          </div>
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
          <section className="wrap results" aria-labelledby="results-title">
            <div className="card">
              <div className="card-head">
                <h2 id="results-title">{t('results.title')}</h2>
                <span className="based-on">
                  {t('results.basedOn', { title: result.seed.title, artist: result.seed.artist })}
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
              <ol className="songs">
                {result.items.map((item, i) => (
                  <SongRow
                    key={`${item.songId}-${i}`}
                    item={item}
                    n={i + 1}
                    disabled={busyRow !== null || savedId !== null}
                    onRemove={() => void edit('remove', i)}
                    onReplace={() => void edit('replace', i)}
                  />
                ))}
              </ol>
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
            </div>
          </section>
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

function SongRow(props: {
  item: PlayableItem;
  n: number;
  disabled: boolean;
  onRemove(): void;
  onReplace(): void;
}) {
  const { t } = useI18n();
  const { item } = props;
  return (
    <li className="song">
      <span className="song-n">{String(props.n).padStart(2, '0')}</span>
      <div className="song-main">
        <div className="song-title">
          {item.title}
          <span className="song-artist">{item.artist}</span>
        </div>
        {/* AI가 쓴 이유는 글자로만 그린다(React가 HTML로 해석하지 않음, D-030) */}
        <div className="song-reason">{item.reason ?? t('results.noReason')}</div>
        {!item.videoId && <div className="song-unavailable">{t('results.unavailable')}</div>}
      </div>
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
    </li>
  );
}
