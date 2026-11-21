import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from './App';

describe('App', () => {
  it('제목과 기본 언어(영어) 안내 문구를 보여 준다', () => {
    render(<App />);
    expect(screen.getByRole('heading', { name: 'musicweb' })).toBeTruthy();
    expect(screen.getByRole('main').getAttribute('lang')).toBe('en');
  });
});
