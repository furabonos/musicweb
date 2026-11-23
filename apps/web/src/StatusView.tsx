import { useEffect, useState } from 'react';
import type { MusicwebApi, StatusData, StatusMetric } from './api';
import { useI18n, type MessageKey } from './i18n';
import en from './locales/en.json';

/**
 * 공개 현황판 `/status` (SPEC 4.10, T21, D-042). 로그인 없이 누구나 본다.
 * - 숫자마다 계산 방법(서버가 쓴 영어 문장)을 같이 보여 준다. 값이 없으면 "아직 없음"으로, 0으로 꾸미지 않는다.
 * - 실패·거절·되돌림도 숨기지 않는다. 링크는 서버가 이 저장소 주소만 넘긴다.
 */
const SECTIONS = [
  {
    key: 'service',
    title: 'status.section.service',
    metrics: [
      'parseSuccessRate',
      'madeUpSongsFiltered',
      'officialLinkAccuracy',
      'removedSongRate',
      'recommendTestScore',
    ],
  },
  {
    key: 'catalog',
    title: 'status.section.catalog',
    metrics: [
      'playableSongs',
      'songsAdded',
      'searchFreeRate',
      'ytUnitsLeft',
      'ytUserSearchesLeft',
      'ytJobSearchesLeft',
    ],
  },
] as const;
const GITHUB_METRICS = ['autoIssues', 'approvalRate', 'hoursToFix', 'revertRate', 'ciPassRate'];

/** 지표 이름 → 화면 문구 키 (없는 키는 이름 그대로) */
function label(name: string): MessageKey | null {
  const k = `status.metric.${name}`;
  return k in en ? (k as MessageKey) : null;
}

export function StatusView({ api }: { api: MusicwebApi }) {
  const { t, locale } = useI18n();
  const [state, setState] = useState<
    { kind: 'loading' } | { kind: 'error' } | { kind: 'ready'; s: StatusData }
  >({ kind: 'loading' });

  useEffect(() => {
    let live = true;
    api
      .status()
      .then((s) => live && setState({ kind: 'ready', s }))
      .catch(() => live && setState({ kind: 'error' }));
    return () => {
      live = false;
    };
  }, [api]);

  const num = new Intl.NumberFormat(locale);
  const pct = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 });
  const when = (iso: string | null) =>
    iso
      ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(
          new Date(iso),
        )
      : t('status.noData');
  const value = (m: StatusMetric) => {
    if (m.value === null) return t('status.noData');
    if (m.unit === 'rate' || m.unit === 'score') return pct.format(m.value);
    if (m.unit === 'hours') return t('status.hours', { n: num.format(m.value) });
    return num.format(m.value);
  };

  /** 서버의 코드 값(PR 상태·CI·일지 종류)을 화면 문구로. 모르는 값은 그대로 */
  const code = (prefix: string, v: string | null) => {
    const k = `${prefix}.${v ?? ''}`;
    return k in en ? t(k as MessageKey) : (v ?? '?');
  };

  const metricList = (metrics: Record<string, StatusMetric>, names: readonly string[]) => (
    <dl className="metrics">
      {names.map((name) => {
        const m = metrics[name];
        const l = label(name);
        return (
          <div className="metric" key={name} data-metric={name}>
            <dt>{l ? t(l) : name}</dt>
            <dd className="metric-value" data-empty={!m || m.value === null}>
              {m ? value(m) : t('status.noData')}
            </dd>
            {m && (
              <dd className="metric-method" lang="en">
                {m.method}
              </dd>
            )}
          </div>
        );
      })}
    </dl>
  );

  if (state.kind === 'loading')
    return (
      <section className="wrap results">
        <div className="notice notice-info" role="status">
          <span className="spinner" aria-hidden="true" />
          {t('status.loading')}
        </div>
      </section>
    );
  if (state.kind === 'error')
    return (
      <section className="wrap results">
        <div className="notice notice-error" role="alert">
          {t('status.error')}
        </div>
      </section>
    );

  const { s } = state;
  const gh = s.github;
  return (
    <section className="wrap results status">
      <div className="card-head">
        <h2>{t('status.title')}</h2>
        <span className="status-updated">{t('status.updated', { when: when(s.updatedAt) })}</span>
      </div>
      <p className="status-intro">{t('status.intro')}</p>

      {SECTIONS.map((sec) => (
        <div className="card status-card" key={sec.key}>
          <h3>{t(sec.title)}</h3>
          {metricList(s[sec.key], sec.metrics)}
        </div>
      ))}

      <div className="card status-card">
        <h3>{t('status.section.autofix')}</h3>
        {!gh || 'unavailable' in gh ? (
          <p className="status-empty">{t('status.github.unavailable')}</p>
        ) : (
          <>
            <p className="status-updated">{t('status.updated', { when: when(gh.updatedAt) })}</p>
            {metricList(gh.metrics, GITHUB_METRICS)}
            <h4>{t('status.rejectReasons')}</h4>
            {gh.rejectReasons.length ? (
              <ul className="status-list">
                {gh.rejectReasons.map((r) => (
                  <li key={r.reason}>
                    {r.reason}: {num.format(r.count)}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="status-empty">{t('status.none')}</p>
            )}
            <h4>{t('status.recent')}</h4>
            {gh.recent.length ? (
              <ul className="status-list">
                {gh.recent.map((r) => (
                  <li key={r.number}>
                    <a
                      href={r.url}
                      target="_blank"
                      rel="noreferrer"
                      aria-label={t('status.prLink', { n: r.number })}
                    >
                      PR #{r.number}
                    </a>{' '}
                    · {code('status.state', r.state)} · CI {code('status.ci', r.ci)}
                    {r.reverted ? ` · ${t('status.reverted')}` : ''}
                    {r.rejectReason ? ` · ${r.rejectReason}` : ''}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="status-empty">{t('status.none')}</p>
            )}
          </>
        )}
      </div>

      <div className="card status-card">
        <h3>{t('status.opsLog')}</h3>
        {s.opsLog.length ? (
          <ol className="ops-log">
            {s.opsLog.map((e, i) => (
              <li key={i} data-kind={e.kind ?? ''}>
                <time dateTime={e.at ?? undefined}>{when(e.at)}</time>
                <span className="ops-kind">{code('status.kind', e.kind)}</span>
                <span className="ops-message" lang="en">
                  {e.message}
                </span>
                {e.links.map((l) => {
                  const n = /\/(\d+)(?:\/|$)/.exec(l)?.[1] ?? '';
                  const what = l.includes('/pull/')
                    ? 'status.link.pr'
                    : l.includes('/issues/')
                      ? 'status.link.issue'
                      : 'status.link.run';
                  return (
                    <a
                      key={l}
                      href={l}
                      target="_blank"
                      rel="noreferrer"
                      aria-label={t(what, { n })}
                    >
                      #{n}
                    </a>
                  );
                })}
              </li>
            ))}
          </ol>
        ) : (
          <p className="status-empty">{t('status.none')}</p>
        )}
      </div>
    </section>
  );
}
