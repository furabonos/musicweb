import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ApiError, type AdminAction, type AdminOverview, type MusicwebApi } from './api';
import { useI18n, type MessageKey } from './i18n';
import en from './locales/en.json';

/**
 * 관리자 화면 `/admin` (SPEC 4.11, T22, D-043).
 * - 권한은 서버가 확인한다(화면 숨김은 보조). 관리자가 아니면 서버가 거부하고 여기서는 거부 화면만 보인다.
 * - 검색 문장·재생목록 내용은 보여 주지 않는다(서버가 애초에 주지 않음).
 */
const FEATURES = ['create', 'ingest', 'autoIssue'] as const;
const JOBS_TO_RUN = ['metrics', 'githubStats', 'linkHealth'] as const;

type State =
  | { kind: 'loading' }
  | { kind: 'signedOut' }
  | { kind: 'denied' }
  | { kind: 'error' }
  | { kind: 'ready'; o: AdminOverview };

export function AdminView({ api, signedIn }: { api: MusicwebApi; signedIn: boolean }) {
  const { t, locale } = useI18n();
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  /** 서버에서 다시 읽는다. 결과는 promise로만 받아 상태를 바꾼다(effect 안에서 동기로 바꾸지 않음) */
  const fetchState = useCallback(
    (): Promise<State> =>
      api.adminOverview().then(
        (o): State => ({ kind: 'ready', o }),
        (err: unknown): State => ({
          kind:
            err instanceof ApiError &&
            (err.code === 'permission-denied' || err.code === 'unauthenticated')
              ? 'denied'
              : 'error',
        }),
      ),
    [api],
  );
  const load = useCallback(async () => setState(await fetchState()), [fetchState]);

  useEffect(() => {
    if (!signedIn) return;
    let live = true;
    void fetchState().then((s) => live && setState(s));
    return () => {
      live = false;
    };
  }, [signedIn, fetchState]);

  /** 서버 거부 이유 → 문구 (모르는 이유는 일반 문구) */
  const reasonText = (err: unknown) => {
    const reason = err instanceof ApiError ? err.details.reason : undefined;
    const key = `admin.error.${reason ?? ''}`;
    return key in en ? t(key as MessageKey) : t('admin.error.generic');
  };

  async function act(action: AdminAction, data: Record<string, unknown>, done?: () => void) {
    setBusy(true);
    setNotice(null);
    try {
      const r = (await api.admin(action, data)) as {
        evalCase?: { url?: string; skipped?: string };
      };
      let text = t('admin.saved');
      if (r?.evalCase?.url) text += ` ${t('admin.evalCaseOpened')}`;
      else if (r?.evalCase?.skipped) text += ` ${t('admin.evalCaseSkipped')}`;
      setNotice({ ok: true, text });
      done?.();
      await load();
    } catch (err) {
      setNotice({ ok: false, text: reasonText(err) });
    } finally {
      setBusy(false);
    }
  }

  // 로그인 전에는 서버를 부르지 않는다
  const shown: State = signedIn ? state : { kind: 'signedOut' };
  if (shown.kind !== 'ready') {
    const msg: Record<Exclude<State['kind'], 'ready'>, MessageKey> = {
      loading: 'admin.loading',
      signedOut: 'admin.signIn',
      denied: 'admin.denied',
      error: 'admin.loadError',
    };
    return (
      <section className="wrap results">
        <div
          className={`notice ${shown.kind === 'loading' ? 'notice-info' : 'notice-error'}`}
          role={shown.kind === 'loading' ? 'status' : 'alert'}
        >
          {t(msg[shown.kind])}
        </div>
      </section>
    );
  }

  const { o } = shown;
  const num = new Intl.NumberFormat(locale);
  const when = (iso: string | null) =>
    iso
      ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(
          new Date(iso),
        )
      : '—';
  const label = (prefix: string, v: string) => {
    const k = `${prefix}.${v}`;
    return k in en ? t(k as MessageKey) : v;
  };

  return (
    <section className="wrap results admin" aria-busy={busy}>
      <div className="card-head">
        <h2>{t('admin.title')}</h2>
      </div>
      {notice && (
        <div
          className={`notice ${notice.ok ? 'notice-info' : 'notice-error'}`}
          role={notice.ok ? 'status' : 'alert'}
        >
          {notice.text}
        </div>
      )}

      <div className="card status-card">
        <h3>{t('admin.killSwitches')}</h3>
        <p className="status-intro">{t('admin.killSwitchesHelp')}</p>
        <ul className="admin-switches">
          {FEATURES.map((f) => (
            <li key={f}>
              <label>
                <input
                  type="checkbox"
                  checked={o.killSwitches[f]}
                  disabled={busy}
                  onChange={(e) =>
                    void act('setKillSwitch', { feature: f, enabled: e.target.checked })
                  }
                />
                {label('admin.feature', f)}
              </label>
              <span className="admin-state" data-on={o.killSwitches[f]}>
                {o.killSwitches[f] ? t('admin.on') : t('admin.off')}
              </span>
            </li>
          ))}
        </ul>
      </div>

      <div className="card status-card">
        <h3>{t('admin.usage', { day: o.usage.day })}</h3>
        <table className="admin-table">
          <thead>
            <tr>
              <th>{t('admin.counter')}</th>
              <th>{t('admin.used')}</th>
              <th>{t('admin.limit')}</th>
              <th>{t('admin.left')}</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(o.limits.service).map(([k, limit]) => {
              const used = o.usage.used[k] ?? 0;
              return (
                <tr key={k}>
                  <td>{label('admin.counterName', k)}</td>
                  <td>{num.format(used)}</td>
                  <td>{num.format(limit)}</td>
                  <td>{num.format(Math.max(0, limit - used))}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <LimitsForm
        o={o}
        busy={busy}
        onSave={(patch) => void act('setLimits', patch)}
        label={label}
      />

      <div className="card status-card">
        <h3>{t('admin.artists')}</h3>
        <ArtistForm busy={busy} onAdd={(d, done) => void act('addArtist', d, done)} />
        <table className="admin-table">
          <thead>
            <tr>
              <th>{t('admin.artistName')}</th>
              <th>{t('admin.status')}</th>
              <th>{t('admin.failCount')}</th>
              <th>{t('admin.lastScanned')}</th>
              <th>
                <span className="visually-hidden">{t('admin.actions')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {o.artists.length === 0 && (
              <tr>
                <td colSpan={5} className="status-empty">
                  {t('status.none')}
                </td>
              </tr>
            )}
            {o.artists.map((a) => (
              <tr key={a.id}>
                <td>{a.name}</td>
                <td>{label('admin.artistStatus', a.status)}</td>
                <td>{num.format(a.failCount)}</td>
                <td>{when(a.lastScannedAt)}</td>
                <td>
                  {a.status === 'active' ? (
                    <button
                      type="button"
                      className="btn-ghost"
                      disabled={busy}
                      onClick={() => void act('setArtistStatus', { id: a.id, status: 'paused' })}
                    >
                      {t('admin.pause')}
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="btn-ghost"
                      disabled={busy}
                      onClick={() => void act('setArtistStatus', { id: a.id, status: 'active' })}
                    >
                      {t('admin.reenable')}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card status-card">
        <h3>{t('admin.jobs')}</h3>
        <table className="admin-table">
          <thead>
            <tr>
              <th>{t('admin.job')}</th>
              <th>{t('admin.lastRun')}</th>
              <th>{t('admin.result')}</th>
              <th>{t('admin.processed')}</th>
            </tr>
          </thead>
          <tbody>
            {o.jobs.length === 0 && (
              <tr>
                <td colSpan={4} className="status-empty">
                  {t('status.none')}
                </td>
              </tr>
            )}
            {o.jobs.map((j) => (
              <tr key={j.job}>
                <td>{j.job}</td>
                <td>{when(j.at)}</td>
                <td data-outcome={j.outcome}>{label('admin.outcome', j.outcome)}</td>
                <td>
                  {num.format(j.processed)} / {t('admin.failedN', { n: num.format(j.failed) })}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="admin-row">
          {JOBS_TO_RUN.map((j) => (
            <button
              key={j}
              type="button"
              className="btn-ghost"
              disabled={busy}
              onClick={() => void act('runJob', { job: j })}
            >
              {t('admin.runJob', { job: j })}
            </button>
          ))}
        </div>
      </div>

      <LinkForm busy={busy} onSubmit={(d, done) => void act('setLinkStatus', d, done)} />

      <div className="card status-card">
        <h3>{t('admin.accounts')}</h3>
        <EmailForm
          busy={busy}
          id="block"
          label={t('admin.blockEmail')}
          onSubmit={(email, value, done) => void act('setUserBlocked', { email, value }, done)}
          onLabel={t('admin.block')}
          offLabel={t('admin.unblock')}
        />
        <p className="status-empty">{t('admin.blockedCount', { n: o.blocked.length })}</p>
        <ul className="status-list">
          {o.blocked.map((u) => (
            <li key={u.uid}>{u.email ?? u.uid}</li>
          ))}
        </ul>
        <h4>{t('admin.testers', { n: o.testers.length, max: 100 })}</h4>
        <EmailForm
          busy={busy}
          id="tester"
          label={t('admin.testerEmail')}
          onSubmit={(email, value, done) => void act('setExportTester', { email, value }, done)}
          onLabel={t('admin.addTester')}
          offLabel={t('admin.removeTester')}
        />
        <ul className="status-list">
          {o.testers.map((u) => (
            <li key={u.uid}>{u.email ?? u.uid}</li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function LimitsForm({
  o,
  busy,
  onSave,
  label,
}: {
  o: AdminOverview;
  busy: boolean;
  onSave: (patch: Record<string, unknown>, done: () => void) => void;
  label: (prefix: string, v: string) => string;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<Record<string, string>>({});
  const scopes = ['service', 'user'] as const;
  function submit(e: FormEvent) {
    e.preventDefault();
    const patch: Record<string, Record<string, number>> = {};
    for (const [key, v] of Object.entries(draft)) {
      const [scope, name] = key.split('.') as [(typeof scopes)[number], string];
      const n = Number(v);
      if (v === '' || !Number.isInteger(n) || n < 0 || n === o.limits[scope][name]) continue;
      (patch[scope] ??= {})[name] = n;
    }
    // 저장에 성공했을 때만 입력을 비운다(실패하면 고칠 수 있게 남김)
    if (Object.keys(patch).length) onSave(patch, () => setDraft({}));
  }
  return (
    <form className="card status-card" onSubmit={submit}>
      <h3>{t('admin.limits')}</h3>
      {scopes.map((scope) => (
        <fieldset key={scope} className="admin-limits">
          <legend>{t(scope === 'service' ? 'admin.limitsService' : 'admin.limitsUser')}</legend>
          {Object.entries(o.limits[scope]).map(([name, value]) => {
            const key = `${scope}.${name}`;
            return (
              <label key={key}>
                <span>
                  {label(scope === 'service' ? 'admin.counterName' : 'admin.userCounter', name)}
                </span>
                <input
                  type="number"
                  min={0}
                  step={1}
                  value={draft[key] ?? String(value)}
                  onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
                />
              </label>
            );
          })}
        </fieldset>
      ))}
      <button type="submit" className="btn-accent" disabled={busy}>
        {t('admin.saveLimits')}
      </button>
    </form>
  );
}

function ArtistForm({
  busy,
  onAdd,
}: {
  busy: boolean;
  onAdd: (d: Record<string, unknown>, done: () => void) => void;
}) {
  const { t } = useI18n();
  const [mbid, setMbid] = useState('');
  const [name, setName] = useState('');
  const [channelId, setChannelId] = useState('');
  return (
    <form
      className="admin-row"
      onSubmit={(e) => {
        e.preventDefault();
        onAdd(
          {
            mbid: mbid.trim(),
            name: name.trim(),
            ...(channelId.trim() ? { channelId: channelId.trim() } : {}),
          },
          () => {
            setMbid('');
            setName('');
            setChannelId('');
          },
        );
      }}
    >
      <label>
        <span>{t('admin.artistMbid')}</span>
        <input value={mbid} onChange={(e) => setMbid(e.target.value)} required />
      </label>
      <label>
        <span>{t('admin.artistName')}</span>
        <input value={name} onChange={(e) => setName(e.target.value)} required />
      </label>
      <label>
        <span>{t('admin.channelId')}</span>
        <input value={channelId} onChange={(e) => setChannelId(e.target.value)} />
      </label>
      <button type="submit" className="btn-accent" disabled={busy}>
        {t('admin.addArtist')}
      </button>
    </form>
  );
}

function LinkForm({
  busy,
  onSubmit,
}: {
  busy: boolean;
  onSubmit: (d: Record<string, unknown>, done: () => void) => void;
}) {
  const { t } = useI18n();
  const [songId, setSongId] = useState('');
  const [videoId, setVideoId] = useState('');
  const [status, setStatus] = useState<'blocked' | 'active'>('blocked');
  const [suggest, setSuggest] = useState(true);
  return (
    <form
      className="card status-card"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(
          { songId: songId.trim(), videoId: videoId.trim(), status, suggestEvalCase: suggest },
          () => {
            setSongId('');
            setVideoId('');
          },
        );
      }}
    >
      <h3>{t('admin.fixLink')}</h3>
      <p className="status-intro">{t('admin.fixLinkHelp')}</p>
      <div className="admin-row">
        <label>
          <span>{t('admin.songId')}</span>
          <input value={songId} onChange={(e) => setSongId(e.target.value)} required />
        </label>
        <label>
          <span>{t('admin.videoId')}</span>
          <input value={videoId} onChange={(e) => setVideoId(e.target.value)} required />
        </label>
        <label>
          <span>{t('admin.linkAction')}</span>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as 'blocked' | 'active')}
          >
            <option value="blocked">{t('admin.linkBlock')}</option>
            <option value="active">{t('admin.linkUse')}</option>
          </select>
        </label>
        <label className="admin-check">
          <input type="checkbox" checked={suggest} onChange={(e) => setSuggest(e.target.checked)} />
          {t('admin.suggestEvalCase')}
        </label>
        <button type="submit" className="btn-accent" disabled={busy}>
          {t('admin.apply')}
        </button>
      </div>
    </form>
  );
}

function EmailForm({
  busy,
  id,
  label,
  onSubmit,
  onLabel,
  offLabel,
}: {
  busy: boolean;
  id: string;
  label: string;
  onSubmit: (email: string, value: boolean, done: () => void) => void;
  onLabel: string;
  offLabel: string;
}) {
  const [email, setEmail] = useState('');
  const send = (value: boolean) => {
    if (email.trim()) onSubmit(email.trim(), value, () => setEmail(''));
  };
  return (
    <form
      className="admin-row"
      onSubmit={(e) => {
        e.preventDefault();
        send(true);
      }}
    >
      <label htmlFor={`admin-${id}`}>
        <span>{label}</span>
        <input
          id={`admin-${id}`}
          type="email"
          autoComplete="off"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </label>
      <button type="submit" className="btn-accent" disabled={busy}>
        {onLabel}
      </button>
      <button type="button" className="btn-ghost" disabled={busy} onClick={() => send(false)}>
        {offLabel}
      </button>
    </form>
  );
}
