import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RUNTIME,
  effectiveRecommendMode,
  parseRuntimeConfig,
  RuntimeConfigError,
} from './runtimeConfig.js';

describe('parseRuntimeConfig', () => {
  it('문서가 없으면 SPEC 6.3 기본값', () => {
    const cfg = parseRuntimeConfig(undefined);
    expect(cfg).toEqual(DEFAULT_RUNTIME);
    expect(cfg.limits.service.ytUnits).toBe(9000);
    expect(cfg.limits.service.ytSearchUser + cfg.limits.service.ytSearchJob).toBe(100);
    expect(cfg.limits.service.aiCostMicroUsd).toBe(3_000_000); // $3 (D-039)
    expect(cfg.limits.user.playlists).toBe(10);
    expect(cfg.limits.user.searches).toBe(3);
    expect(cfg.limits.user.exports).toBe(1);
    expect(cfg.limits.service.exports).toBe(5);
    expect(cfg.limits.service.autoIssues).toBe(5);
    expect(cfg.limits.service.autoFixes).toBe(3);
    expect(cfg.killSwitches).toEqual({ create: true, ingest: true, autoIssue: true });
  });

  it('일부만 적힌 문서는 나머지를 기본값으로 채운다', () => {
    const cfg = parseRuntimeConfig({
      killSwitches: { create: false },
      limits: { user: { playlists: 3 } },
    });
    expect(cfg.killSwitches).toEqual({ create: false, ingest: true, autoIssue: true });
    expect(cfg.limits.user.playlists).toBe(3);
    expect(cfg.limits.user.searches).toBe(3);
    expect(cfg.limits.service.ytUnits).toBe(9000);
  });

  it.each([
    [{ killSwitches: { create: 'false' } }],
    [{ limits: { user: { playlists: -1 } } }],
    [{ limits: { service: { ytUnits: 1.5 } } }],
    [{ limits: { service: { ytSearchUser: 90, ytSearchJob: 20 } } }], // YouTube 검색 한도 100 초과
    [{ limits: { service: { ytUnits: 10_001 } } }], // YouTube 기본 할당 10,000 초과
    ['not an object'],
  ])('잘못된 문서는 막는 쪽으로 실패한다(예외): %j', (doc) => {
    expect(() => parseRuntimeConfig(doc)).toThrow(RuntimeConfigError);
  });

  it('모르는 필드는 거부한다 (오타로 스위치가 안 꺼지는 일 방지)', () => {
    expect(() => parseRuntimeConfig({ killSwitch: { create: false } })).toThrow(RuntimeConfigError);
    expect(() => parseRuntimeConfig({ killSwitches: { crate: false } })).toThrow(
      RuntimeConfigError,
    );
  });
});

describe('youtubeOpenLink (T16, D-006)', () => {
  it('기본은 direct, fallback 저장 값을 읽고, 다른 값은 거부', () => {
    expect(parseRuntimeConfig(undefined).youtubeOpenLink).toBe('direct');
    expect(parseRuntimeConfig({ youtubeOpenLink: 'fallback' }).youtubeOpenLink).toBe('fallback');
    expect(() => parseRuntimeConfig({ youtubeOpenLink: 'off' })).toThrow(RuntimeConfigError);
  });
});

describe('recommendMode (T30)', () => {
  it('기본은 ai(T31 측정, D-052), 저장된 값은 그대로, 모르는 값은 거부', () => {
    expect(parseRuntimeConfig(undefined).recommendMode).toBe('ai');
    expect(parseRuntimeConfig({ recommendMode: 'precomputed' }).recommendMode).toBe('precomputed');
    expect(parseRuntimeConfig({ recommendMode: 'ai' }).recommendMode).toBe('ai');
    expect(() => parseRuntimeConfig({ recommendMode: 'magic' })).toThrow(RuntimeConfigError);
  });
});

describe('effectiveRecommendMode (D-052)', () => {
  it('설정 ai + AI 사용 가능일 때만 ai', () => {
    expect(effectiveRecommendMode('ai', 'on')).toBe('ai');
  });
  it('키 없음·절약 모드·설정 precomputed면 미리 계산', () => {
    expect(effectiveRecommendMode('ai', 'no_key')).toBe('precomputed');
    expect(effectiveRecommendMode('ai', 'saving')).toBe('precomputed');
    expect(effectiveRecommendMode('precomputed', 'on')).toBe('precomputed');
  });
});
