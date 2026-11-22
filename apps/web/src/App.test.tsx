import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type CreateResult, type MusicwebApi, type PlayableItem } from './api';
import { App, countChars, MAX_REQUEST_CHARS } from './App';
import { I18nProvider } from './i18n';

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const item = (n: number, over: Partial<PlayableItem> = {}): PlayableItem => ({
  songId: `song-${n}`,
  artist: `Artist ${n}`,
  title: `Title ${n}`,
  reason: `Reason ${n}`,
  videoId: `vid${n}`,
  kind: 'official_audio',
  ...over,
});

const ok = (items: PlayableItem[], over: Partial<Extract<CreateResult, { ok: true }>> = {}) =>
  ({
    ok: true,
    id: 'pl1',
    seed: { artist: 'Central Cee', title: 'Doja' },
    items,
    shortfall: null,
    unsupported: [],
    locale: 'en',
    ...over,
  }) as CreateResult;

function fakeApi(over: Partial<MusicwebApi> = {}, signedIn = true) {
  const api: MusicwebApi = {
    onUser: (cb) => {
      cb(signedIn ? { uid: 'u1' } : null);
      return () => {};
    },
    signIn: vi.fn(async () => {}),
    signOut: vi.fn(async () => {}),
    create: vi.fn(async () => ok([1, 2, 3].map((n) => item(n)))),
    update: vi.fn(async () => ({ items: [item(1), item(3)] })),
    save: vi.fn(async () => ({ id: 'pl1', state: 'saved' as const })),
    ...over,
  };
  render(
    <I18nProvider>
      <App api={api} />
    </I18nProvider>,
  );
  return api;
}

async function ask(text = '10 songs like Doja by Central Cee') {
  fireEvent.change(screen.getByLabelText('Describe the music you want'), {
    target: { value: text },
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Go live' }));
  });
}

describe('첫 화면', () => {
  it('기본 영어, 언어 버튼으로 한국어', () => {
    fakeApi();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('Call in a song.');
    fireEvent.click(screen.getByRole('button', { name: '한국어' }));
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('곡 하나만');
    expect(screen.getByRole('button', { name: '한국어' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
  });

  it('글자 수는 코드 포인트로 센다(이모지 1자), 200자를 넘으면 보내지 않음', () => {
    expect(countChars('🎵🎵 ab')).toBe(5);
    const api = fakeApi();
    const input = screen.getByLabelText('Describe the music you want');
    fireEvent.change(input, { target: { value: '🎵'.repeat(MAX_REQUEST_CHARS) } });
    expect(screen.getByText(`${MAX_REQUEST_CHARS}/${MAX_REQUEST_CHARS}`)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Go live' })).toHaveProperty('disabled', false);
    fireEvent.change(input, { target: { value: '🎵'.repeat(MAX_REQUEST_CHARS + 1) } });
    expect(screen.getByRole('button', { name: 'Go live' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('alert').textContent).toContain('over 200 characters');
    expect(api.create).not.toHaveBeenCalled();
  });

  it('로그인 안 했으면 서버를 부르지 않고 로그인 안내', async () => {
    const api = fakeApi({}, false);
    await ask();
    expect(api.create).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toBe('Sign in to build a playlist.');
  });
});

describe('만들기 결과', () => {
  it('곡·이유를 보여 주고, 화면 언어로 요청한다', async () => {
    const api = fakeApi();
    fireEvent.click(screen.getByRole('button', { name: '한국어' }));
    fireEvent.change(screen.getByLabelText('듣고 싶은 음악을 말로 적어 주세요'), {
      target: { value: 'Doja 같은 곡' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '틀어 줘' }));
    });
    expect(api.create).toHaveBeenCalledWith('Doja 같은 곡', 'ko');
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
    expect(screen.getByText('Reason 2')).toBeTruthy();
  });

  it('AI가 쓴 이유는 글자로만 그린다(HTML로 해석하지 않음)', async () => {
    fakeApi({
      create: async () => ok([item(1, { reason: '<img src=x onerror=alert(1)><b>bold</b>' })]),
    });
    await ask();
    expect(screen.getByText('<img src=x onerror=alert(1)><b>bold</b>')).toBeTruthy();
    expect(document.querySelector('.song-reason img, .song-reason b')).toBeNull();
  });

  it('지원하지 않는 조건·곡 부족·재생 불가 곡을 알린다', async () => {
    fakeApi({
      create: async () =>
        ok([item(1), item(2, { videoId: null })], {
          unsupported: ['year', 'mood'],
          shortfall: { requested: 10, got: 2 },
        }),
    });
    await ask();
    const notes = screen.getAllByRole('note').map((n) => n.textContent);
    expect(notes).toContain('Not supported yet, so we ignored: years or decades, moods');
    expect(notes.some((n) => n?.includes('We found 2 playable songs out of 10'))).toBe(true);
    expect(screen.getByText('Not playable right now')).toBeTruthy();
  });

  it('기준 곡이 없으면 예시 문장과 함께 다시 묻는다', async () => {
    fakeApi({ create: async () => ({ ok: false, reason: 'no_seed' }) });
    await ask('something nice');
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('We need one song to start from');
    expect(alert.textContent).toContain('10 songs like Doja by Central Cee');
  });

  it.each([
    [new ApiError('permission-denied', { reason: 'notAdmin' }), 'only the site admin'],
    [new ApiError('unavailable', { reason: 'killSwitch' }), 'paused right now'],
    [
      new ApiError('resource-exhausted', {
        reason: 'limit',
        scope: 'user',
        resetAt: '2026-11-23T08:00:00.000Z',
      }),
      "You've reached today's limit. It resets at",
    ],
    [new ApiError('internal'), 'Something went wrong'],
  ])('서버 거부 %#은 언어별 문구로', async (err, text) => {
    fakeApi({
      create: async () => {
        throw err;
      },
    });
    await ask();
    expect(screen.getByRole('alert').textContent).toContain(text);
  });

  it('빼기 → 서버가 준 목록으로, 저장 → 공유 주소, 저장 뒤에는 고치기 버튼 잠김', async () => {
    const api = fakeApi();
    await ask();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Remove Title 2' }));
    });
    expect(api.update).toHaveBeenCalledWith('pl1', 'remove', 1);
    expect(screen.getAllByRole('listitem')).toHaveLength(2);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save & get share link' }));
    });
    expect(api.save).toHaveBeenCalledWith('pl1');
    await waitFor(() => expect(screen.getByRole('link', { name: /\/p\/pl1$/ })).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Remove Title 1' })).toHaveProperty('disabled', true);
  });

  it('바꿀 곡이 없으면 안내', async () => {
    fakeApi({
      update: async () => {
        throw new ApiError('failed-precondition', { reason: 'noSpare' });
      },
    });
    await ask();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Swap Title 1 for another song' }));
    });
    expect(screen.getByRole('alert').textContent).toBe('No more songs to swap in.');
  });
});
