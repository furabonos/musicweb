import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import type { MusicwebApi, PickInput, SongSuggestion } from './api';
import { useI18n } from './i18n';

/**
 * 곡 고르기 (SPEC 4.2 "고르기 화면", T33, D-049). AI 없이 곡 목록에서 곡을 찾아 고르고, 곡 수·조건을 정한다.
 * - 제안은 두 글자부터, 입력을 멈추고 잠시 뒤에 부른다. 입력 글은 서버에 저장되지 않는다.
 * - 접근성: 입력칸은 combobox, 제안은 listbox. 위·아래 화살표로 옮기고(aria-activedescendant) Enter로 고르고 Esc로 닫는다.
 *   고른 뒤에는 "바꾸기" 버튼으로, 바꾸기를 누르면 다시 입력칸으로 포커스를 옮긴다.
 */
const COUNTS = [5, 10, 15, 20, 25, 30];
const CONDITIONS = ['live', 'cover', 'remix'] as const;
const DEBOUNCE_MS = 250;

export function Picker({
  api,
  busy,
  onPick,
}: {
  api: MusicwebApi;
  busy: boolean;
  onPick: (input: PickInput) => void;
}) {
  const { t } = useI18n();
  const baseId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const changeRef = useRef<HTMLButtonElement>(null);
  const [q, setQ] = useState('');
  const [options, setOptions] = useState<SongSuggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [song, setSong] = useState<SongSuggestion | null>(null);
  const [count, setCount] = useState(10);
  const [include, setInclude] = useState({ live: false, cover: false, remix: false });
  const focusAfter = useRef<'change' | 'input' | null>(null);

  useEffect(() => {
    if (song || q.trim().length < 2) return;
    let live = true;
    const timer = setTimeout(() => {
      api
        .suggest(q)
        .then((items) => {
          if (!live) return;
          setOptions(items);
          setActive(-1);
        })
        .catch(() => live && setOptions([]));
    }, DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [api, q, song]);

  // 고르기·바꾸기 뒤 포커스 옮기기(사라진 요소에 포커스가 남지 않게)
  useEffect(() => {
    if (focusAfter.current === 'change') changeRef.current?.focus();
    if (focusAfter.current === 'input') inputRef.current?.focus();
    focusAfter.current = null;
  }, [song]);

  const shown = song || !open || q.trim().length < 2 ? [] : options;
  const optionId = (i: number) => `${baseId}-opt-${i}`;

  function choose(s: SongSuggestion) {
    focusAfter.current = 'change';
    setSong(s);
    setOpen(false);
    setActive(-1);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown' && shown.length) {
      e.preventDefault();
      setActive((a) => (a + 1) % shown.length);
    } else if (e.key === 'ArrowUp' && shown.length) {
      e.preventDefault();
      setActive((a) => (a <= 0 ? shown.length - 1 : a - 1));
    } else if (e.key === 'Enter' && active >= 0 && shown[active]) {
      e.preventDefault();
      choose(shown[active]);
    } else if (e.key === 'Escape') {
      setOpen(false);
      setActive(-1);
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!song || busy) return;
    onPick({ seedSongId: song.songId, count, include });
  }

  return (
    <form className="picker card" onSubmit={submit} aria-labelledby={`${baseId}-title`}>
      <h2 id={`${baseId}-title`}>{t('picker.title')}</h2>
      <div className="picker-row">
        <div className="picker-song">
          <label htmlFor={`${baseId}-song`} id={`${baseId}-label`}>
            {t('picker.song')}
          </label>
          {song ? (
            <div className="picker-chosen" role="group" aria-labelledby={`${baseId}-label`}>
              <span>
                {song.title} — {song.artist}
              </span>
              <button
                ref={changeRef}
                type="button"
                className="btn-ghost"
                onClick={() => {
                  focusAfter.current = 'input';
                  setSong(null);
                  setQ('');
                  setOptions([]);
                }}
              >
                {t('picker.change')}
              </button>
            </div>
          ) : (
            <input
              ref={inputRef}
              id={`${baseId}-song`}
              type="text"
              role="combobox"
              aria-expanded={shown.length > 0}
              aria-controls={`${baseId}-list`}
              aria-autocomplete="list"
              aria-activedescendant={active >= 0 && shown[active] ? optionId(active) : undefined}
              autoComplete="off"
              maxLength={50}
              placeholder={t('picker.placeholder')}
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setOpen(true);
              }}
              onKeyDown={onKeyDown}
            />
          )}
          {shown.length > 0 && (
            <ul
              id={`${baseId}-list`}
              role="listbox"
              className="picker-options"
              aria-labelledby={`${baseId}-label`}
            >
              {shown.map((s, i) => (
                <li
                  key={s.songId}
                  id={optionId(i)}
                  role="option"
                  aria-selected={i === active}
                  className="picker-option"
                  data-active={i === active}
                  // 입력칸 포커스를 뺏기 전에 고른다
                  onMouseDown={(e) => {
                    e.preventDefault();
                    choose(s);
                  }}
                >
                  <strong>{s.title}</strong> {s.artist}
                  {s.releaseYear ? ` · ${s.releaseYear}` : ''}
                </li>
              ))}
            </ul>
          )}
        </div>
        <label className="picker-count">
          <span>{t('picker.count')}</span>
          <select value={count} onChange={(e) => setCount(Number(e.target.value))}>
            {COUNTS.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div
        className="picker-row"
        role="group"
        aria-label={t('picker.conditions')}
        aria-describedby="picker-include-note"
      >
        {CONDITIONS.map((c) => (
          <button
            key={c}
            type="button"
            className="btn-ghost picker-toggle"
            aria-pressed={include[c]}
            onClick={() => setInclude({ ...include, [c]: !include[c] })}
          >
            {t(`picker.include.${c}`)}
          </button>
        ))}
        <button type="submit" className="btn-accent" disabled={!song || busy}>
          {t('picker.submit')}
        </button>
      </div>
      <p className="picker-note" id="picker-include-note">
        {t('picker.includeNote')}
      </p>
    </form>
  );
}
