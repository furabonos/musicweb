import { DEFAULT_LOCALE } from '@musicweb/shared';

/** 빈 화면. 검색창과 결과 화면은 T14에서 만든다. */
export function App() {
  return (
    <main lang={DEFAULT_LOCALE}>
      <h1>musicweb</h1>
      <p>Make a playlist by just asking. Coming soon.</p>
    </main>
  );
}
