import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MusicService, PlayerEvents } from '@musicweb/shared';
import {
  ApiError,
  type CreateResult,
  type MusicwebApi,
  type PlayableItem,
  type StatusData,
  type AdminOverview,
} from './api';
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

/** 가짜 재생 서비스: 플레이어 호출을 기록하고, 테스트가 곡 끝·오류를 일으킬 수 있게 한다. */
function fakeMusic() {
  const calls: string[] = [];
  let events: PlayerEvents | null = null;
  const service: MusicService<HTMLElement> = {
    name: 'youtube',
    mount: async (_el, ev) => {
      events = ev;
      return {
        cue: (id) => calls.push(`cue:${id}`),
        play: (id) => calls.push(`play:${id}`),
        destroy: () => calls.push('destroy'),
      };
    },
  };
  return { service, calls, events: () => events };
}

let music = fakeMusic();

function fakeApi(over: Partial<MusicwebApi> = {}, signedIn = true) {
  music = fakeMusic();
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
    reportEmbedBlocked: vi.fn(async () => {}),
    getPlaylist: vi.fn(async () => {
      throw new ApiError('not-found');
    }),
    siteConfig: vi.fn(async () => ({ openLink: 'direct' as const })),
    status: vi.fn(async () => {
      throw new Error('not used');
    }),
    adminOverview: vi.fn(async () => {
      throw new Error('not used');
    }),
    admin: vi.fn(async () => ({})),
    ...over,
  };
  render(
    <I18nProvider>
      <App api={api} music={music.service} />
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

describe('재생 (가짜 플레이어)', () => {
  it('결과가 나오면 첫 곡을 올려만 두고, 곡 번호를 누르면 그 곡을 재생', async () => {
    fakeApi();
    await ask();
    await waitFor(() => expect(music.calls).toEqual(['cue:vid1']));
    fireEvent.click(screen.getByRole('button', { name: 'Play Title 2' }));
    expect(music.calls).toEqual(['cue:vid1', 'play:vid2']);
    expect(screen.getAllByRole('listitem')[1]?.getAttribute('aria-current')).toBe('true');
    expect(screen.getByRole('region', { name: 'YouTube player' })).toBeTruthy();
  });

  it('오류 150이면 기록을 보내고 다음 곡으로', async () => {
    const api = fakeApi();
    await ask();
    await waitFor(() => expect(music.calls).toEqual(['cue:vid1']));
    fireEvent.click(screen.getByRole('button', { name: 'Play Title 1' }));
    act(() => music.events()?.onError(150));
    expect(api.reportEmbedBlocked).toHaveBeenCalledWith(150);
    expect(music.calls.at(-1)).toMatch(/^(play|cue):vid2$/);
  });

  it('재생할 수 없는 곡은 재생 버튼이 잠김', async () => {
    fakeApi({ create: async () => ok([item(1), item(2, { videoId: null })]) });
    await ask();
    expect(screen.getByRole('button', { name: 'Play Title 2' })).toHaveProperty('disabled', true);
  });
});

describe('플레이어 정리', () => {
  it('새 결과가 오면 이전 플레이어를 지우고 새로 만든다, 강조도 초기화', async () => {
    let n = 0;
    fakeApi({
      create: async () => ok([item(1), item(2)], { id: `pl${++n}` }),
    });
    await ask();
    await waitFor(() => expect(music.calls).toEqual(['cue:vid1']));
    fireEvent.click(screen.getByRole('button', { name: 'Play Title 2' }));
    await ask();
    await waitFor(() =>
      expect(music.calls).toEqual(['cue:vid1', 'play:vid2', 'destroy', 'cue:vid1']),
    );
    expect(screen.getAllByRole('listitem')[1]?.getAttribute('aria-current')).toBeNull();
  });

  it('플레이어가 준비되기 전에 화면에서 빠지면, 늦게 준비돼도 바로 지운다', async () => {
    const calls: string[] = [];
    let ready: (() => void) | null = null;
    const slow: MusicService<HTMLElement> = {
      name: 'youtube',
      mount: () =>
        new Promise((resolve) => {
          ready = () =>
            resolve({
              cue: (id) => calls.push(`cue:${id}`),
              play: (id) => calls.push(`play:${id}`),
              destroy: () => calls.push('destroy'),
            });
        }),
    };
    const api = {
      onUser: (cb: (u: { uid: string }) => void) => {
        cb({ uid: 'u1' });
        return () => {};
      },
      signIn: async () => {},
      signOut: async () => {},
      create: async () => ok([item(1)]),
      update: async () => ({ items: [] }),
      save: async () => ({ id: 'pl1', state: 'saved' as const }),
      reportEmbedBlocked: async () => {},
      getPlaylist: async () => {
        throw new ApiError('not-found');
      },
      siteConfig: async () => ({ openLink: 'direct' as const }),
      status: async () => {
        throw new Error('not used');
      },
      adminOverview: async () => {
        throw new Error('not used');
      },
      admin: async () => ({}),
    } as MusicwebApi;
    const { unmount } = render(
      <I18nProvider>
        <App api={api} music={slow} />
      </I18nProvider>,
    );
    await ask();
    unmount();
    await act(async () => {
      (ready as (() => void) | null)?.();
    });
    expect(calls).toEqual(['destroy']);
  });
});

describe('공유 주소 /p/:id (보기 전용)', () => {
  const shared = {
    id: 'abc123',
    title: 'Doja — Central Cee',
    seed: { artist: 'Central Cee', title: 'Doja' },
    items: [item(1, { videoId: 'vid00000001' }), item(2, { videoId: 'vid00000002' })],
    locale: 'en' as const,
    state: 'saved' as const,
    openLink: 'direct' as const,
  };

  function showShared(over: Partial<MusicwebApi>) {
    music = fakeMusic();
    const api = {
      onUser: (cb: (u: null) => void) => {
        cb(null);
        return () => {};
      },
      siteConfig: async () => ({ openLink: 'direct' as const }),
      reportEmbedBlocked: vi.fn(async () => {}),
      ...over,
    } as unknown as MusicwebApi;
    render(
      <I18nProvider>
        <App api={api} music={music.service} path="/p/abc123" />
      </I18nProvider>,
    );
    return api;
  }

  it('로그인 없이 곡·플레이어·YouTube 링크, 빼기·바꾸기·검색창은 없음', async () => {
    const getPlaylist = vi.fn(async () => shared);
    showShared({ getPlaylist });
    expect(await screen.findByRole('heading', { name: 'Shared set' })).toBeTruthy();
    expect(getPlaylist).toHaveBeenCalledWith('abc123');
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: /^Remove/ })).toBeNull();
    expect(screen.queryByLabelText('Describe the music you want')).toBeNull();
    expect(screen.getByRole('link', { name: 'Open in YouTube' })).toBeTruthy();
    await waitFor(() => expect(music.calls).toEqual(['cue:vid00000001']));
  });

  it('없거나 공유되지 않은 재생목록이면 안내', async () => {
    showShared({
      getPlaylist: async () => {
        throw new ApiError('not-found');
      },
    });
    expect((await screen.findByRole('alert')).textContent).toContain("doesn't exist");
  });
});

describe('현황판 /status (T21)', () => {
  const data: StatusData = {
    updatedAt: '2026-11-23T13:30:00.000Z',
    service: {
      parseSuccessRate: { value: 0.9, unit: 'rate', method: 'Requests understood divided by all.' },
      removedSongRate: { value: null, unit: 'rate', method: 'Removed divided by shown.' },
    },
    catalog: { playableSongs: { value: 1500, unit: 'count', method: 'Songs with a video.' } },
    github: {
      updatedAt: null,
      metrics: { hoursToFix: { value: 32.5, unit: 'hours', method: 'Median hours to merge.' } },
      rejectReasons: [{ reason: 'wrong fix', count: 1 }],
      recent: [
        {
          number: 53,
          url: 'https://github.com/furabonos/musicweb/pull/53',
          state: 'merged',
          ci: 'success',
          openedAt: null,
          reverted: true,
          rejectReason: null,
        },
      ],
    },
    opsLog: [
      {
        at: '2026-11-23T13:00:00.000Z',
        kind: 'pr',
        message: 'Auto-fix PR merged; CI success.',
        links: ['https://github.com/furabonos/musicweb/pull/53'],
      },
    ],
  };

  function showStatus(status: MusicwebApi['status']) {
    music = fakeMusic();
    const api = {
      onUser: (cb: (u: null) => void) => {
        cb(null);
        return () => {};
      },
      siteConfig: vi.fn(async () => ({ openLink: 'direct' as const })),
      status: vi.fn(status),
    } as unknown as MusicwebApi;
    render(
      <I18nProvider>
        <App api={api} music={music.service} path="/status" />
      </I18nProvider>,
    );
    return api;
  }

  it('수치·계산 방법·없는 값·GitHub 링크·운영 일지를 보여 주고 검색창은 없다', async () => {
    const api = showStatus(async () => data);
    expect(await screen.findByRole('heading', { name: 'Station status' })).toBeTruthy();
    const metric = (name: string) =>
      document.querySelector(`[data-metric="${name}"]`)?.textContent ?? '';
    expect(metric('parseSuccessRate')).toContain('90%');
    expect(metric('parseSuccessRate')).toContain('Requests understood divided by all.');
    expect(metric('removedSongRate')).toContain('No data yet');
    expect(metric('playableSongs')).toContain('1,500');
    expect(metric('hoursToFix')).toContain('32.5 h');
    expect(screen.getByText(/wrong fix: 1/)).toBeTruthy();
    expect(
      screen
        .getAllByRole('link', { name: 'Pull request #53 (opens in a new tab)' })[0]
        ?.getAttribute('href'),
    ).toBe('https://github.com/furabonos/musicweb/pull/53');
    expect(document.querySelector('.status-list a')?.parentElement?.textContent).toContain(
      'reverted',
    );
    expect(screen.getByText('Auto-fix PR merged; CI success.')).toBeTruthy();
    expect(screen.getAllByRole('link', { name: /#53/ })).toHaveLength(2);
    expect(screen.queryByLabelText('Describe the music you want')).toBeNull();
    expect(api.siteConfig).not.toHaveBeenCalled();
  });

  it('GitHub 수치가 없으면 안내, 불러오기 실패는 오류 안내', async () => {
    showStatus(async () => ({ ...data, github: { unavailable: 'no GitHub token' } }));
    expect(await screen.findByText('GitHub numbers are not available yet.')).toBeTruthy();
    cleanup();
    showStatus(async () => {
      throw new Error('down');
    });
    expect(await screen.findByRole('alert')).toBeTruthy();
  });
});

describe('관리자 화면 /admin (T22)', () => {
  const overview: AdminOverview = {
    killSwitches: { create: true, ingest: true, autoIssue: false },
    savingMode: false,
    limits: { service: { ytUnits: 9000 }, user: { playlists: 10 } },
    usage: { day: '2026-11-23', used: { ytUnits: 1200 } },
    jobs: [{ job: 'ingest', at: null, outcome: 'error', processed: 5, failed: 1 }],
    artists: [
      {
        id: 'a1',
        name: 'Central Cee',
        status: 'failed',
        failCount: 3,
        channelId: null,
        lastScannedAt: null,
      },
    ],
    testers: [{ uid: 't1', email: 'tester@example.com' }],
    blocked: [],
  };

  function showAdmin(over: Partial<MusicwebApi>, signedIn = true) {
    music = fakeMusic();
    const api = {
      onUser: (cb: (u: { uid: string } | null) => void) => {
        cb(signedIn ? { uid: 'u1' } : null);
        return () => {};
      },
      siteConfig: vi.fn(async () => ({ openLink: 'direct' as const })),
      adminOverview: vi.fn(async () => overview),
      admin: vi.fn(async () => ({})),
      ...over,
    } as unknown as MusicwebApi;
    render(
      <I18nProvider>
        <App api={api} music={music.service} path="/admin" />
      </I18nProvider>,
    );
    return api;
  }

  it('관리자가 아니면(서버 거부) 접근 거부 화면만', async () => {
    const api = showAdmin({
      adminOverview: vi.fn(async () => {
        throw new ApiError('permission-denied', { reason: 'notAdmin' });
      }),
    });
    expect((await screen.findByRole('alert')).textContent).toContain('Access denied');
    expect(screen.queryByText('Kill switches')).toBeNull();
    expect(api.admin).not.toHaveBeenCalled();
  });

  it('로그인 전에는 서버를 부르지 않고 로그인 안내', async () => {
    const api = showAdmin({}, false);
    expect((await screen.findByRole('alert')).textContent).toContain('Sign in with an admin');
    expect(api.adminOverview).not.toHaveBeenCalled();
  });

  it('긴급 정지 끄기 → 서버에 그 값만 보내고 다시 불러온다, 거부 이유는 문구로', async () => {
    const api = showAdmin({});
    const create = await screen.findByRole('checkbox', { name: 'Making sets' });
    await act(async () => {
      fireEvent.click(create);
    });
    expect(api.admin).toHaveBeenCalledWith('setKillSwitch', { feature: 'create', enabled: false });
    expect(api.adminOverview).toHaveBeenCalledTimes(2);
    expect(await screen.findByText('Saved.')).toBeTruthy();

    (api.admin as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new ApiError('resource-exhausted', { reason: 'testersFull' }),
    );
    fireEvent.change(screen.getByLabelText('Test user email'), {
      target: { value: 'new@example.com' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    });
    expect(await screen.findByText(/already 100 test users/)).toBeTruthy();
  });

  it('사용량·작업 결과·실패한 아티스트 다시 켜기·테스트 사용자 이메일', async () => {
    const api = showAdmin({});
    expect(await screen.findByText('7,800')).toBeTruthy(); // 9000 - 1200
    expect(screen.getByText('error')).toBeTruthy();
    expect(screen.getByText('tester@example.com')).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Re-enable' }));
    });
    expect(api.admin).toHaveBeenCalledWith('setArtistStatus', { id: 'a1', status: 'active' });
  });
});
