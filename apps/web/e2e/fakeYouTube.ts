import type { Page } from '@playwright/test';

/**
 * e2e용 가짜 YouTube IFrame API. 실제 youtube.com을 부르지 않는다.
 * YT.Player는 받은 크기로 iframe(빈 문서)을 만들고, 호출을 window.__fakeYT.calls에 남긴다.
 * window.__fakeYT.end() / .error(code)로 곡 끝·오류를 일으킨다.
 */
const SCRIPT = `
(function () {
  var state = { calls: [], player: null };
  window.__fakeYT = state;
  function Player(el, opts) {
    var f = document.createElement('iframe');
    f.width = String(opts.width); f.height = String(opts.height);
    f.setAttribute('data-host', opts.host);
    f.title = 'fake YouTube player';
    el.replaceWith(f);
    state.player = opts;
    state.end = function () { opts.events.onStateChange({ data: 0 }); };
    state.error = function (c) { opts.events.onError({ data: c }); };
    setTimeout(function () { opts.events.onReady(); }, 0);
    this.cueVideoById = function (id) { state.calls.push('cue:' + id); };
    this.loadVideoById = function (id) { state.calls.push('load:' + id); };
    this.destroy = function () { state.calls.push('destroy'); f.remove(); };
  }
  window.YT = { Player: Player, PlayerState: { ENDED: 0 } };
  setTimeout(function () { window.onYouTubeIframeAPIReady && window.onYouTubeIframeAPIReady(); }, 0);
})();
`;

export async function useFakeYouTube(page: Page) {
  // 그 밖의 YouTube 주소는 부르지 않는다(테스트가 바깥 네트워크에 기대지 않게).
  // Playwright는 나중에 등록한 규칙을 먼저 보므로 막는 규칙을 먼저 등록한다.
  await page.route(/youtube(-nocookie)?\.com/, (route) => route.abort());
  await page.route('https://www.youtube.com/iframe_api', (route) =>
    route.fulfill({ status: 200, contentType: 'text/javascript', body: SCRIPT }),
  );
}

/**
 * 영상 호출(cue·load)만. 개발 서버의 React StrictMode는 플레이어를 한 번 만들었다 지우므로 destroy는 뺀다.
 * 가짜 API가 아직 안 올라왔으면 빈 목록(expect.poll이 기다리게).
 */
export const fakeCalls = (page: Page) =>
  page.evaluate(() =>
    ((window as unknown as { __fakeYT?: { calls: string[] } }).__fakeYT?.calls ?? []).filter(
      (c) => c !== 'destroy',
    ),
  );
