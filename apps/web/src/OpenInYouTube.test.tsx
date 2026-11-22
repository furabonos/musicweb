import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { PlayableItem } from './api';
import { I18nProvider } from './i18n';
import { OpenInYouTube } from './OpenInYouTube';

afterEach(cleanup);

const item = (
  n: number,
  videoId: string | null = `vid${String(n).padStart(8, '0')}`,
): PlayableItem => ({
  songId: `s${n}`,
  artist: `Artist ${n}`,
  title: `Title ${n}`,
  reason: null,
  videoId,
  kind: 'official_audio',
});

const show = (items: PlayableItem[], mode: 'direct' | 'fallback') =>
  render(
    <I18nProvider>
      <OpenInYouTube items={items} mode={mode} />
    </I18nProvider>,
  );

describe('YouTube에서 열기', () => {
  it('direct: 재생할 수 있는 곡만 담은 watch_videos 링크 하나 + 직접 저장 안내', () => {
    show([item(1), item(2, null), item(3)], 'direct');
    const link = screen.getByRole('link', { name: 'Open in YouTube' });
    expect(link.getAttribute('href')).toBe(
      'https://www.youtube.com/watch_videos?video_ids=vid00000001,vid00000003',
    );
    expect(link.getAttribute('rel')).not.toContain('noreferrer');
    expect(screen.getByText(/save it there yourself/)).toBeTruthy();
  });

  it('50곡을 넘으면 링크를 나눠 번호를 붙임', () => {
    show(
      Array.from({ length: 60 }, (_, i) => item(i + 1)),
      'direct',
    );
    expect(screen.getAllByRole('link').map((a) => a.textContent)).toEqual([
      'Open in YouTube (1/2)',
      'Open in YouTube (2/2)',
    ]);
  });

  it('fallback: 곡별 YouTube 링크 목록', () => {
    show([item(1), item(2)], 'fallback');
    expect(screen.queryByRole('link', { name: 'Open in YouTube' })).toBeNull();
    expect(screen.getAllByRole('link').map((a) => [a.textContent, a.getAttribute('href')])).toEqual(
      [
        ['Title 1 — Artist 1', 'https://www.youtube.com/watch?v=vid00000001'],
        ['Title 2 — Artist 2', 'https://www.youtube.com/watch?v=vid00000002'],
      ],
    );
  });

  it('형식이 틀린 영상 ID는 빼고 그림(화면이 멈추지 않음)', () => {
    show([item(1), item(2, 'bad'), item(3, 'x&list=PL1')], 'direct');
    expect(screen.getByRole('link', { name: 'Open in YouTube' }).getAttribute('href')).toBe(
      'https://www.youtube.com/watch_videos?video_ids=vid00000001',
    );
  });

  it('재생할 수 있는 곡이 없으면 아무것도 안 그림', () => {
    const { container } = show([item(1, null)], 'direct');
    expect(container.textContent).toBe('');
  });
});
