/**
 * The signed-out /auth corner mark is the page's only way back to the site on
 * a phone (the desktop shell's Back button does not render there). It rendered
 * a bare decorative glyph — no link, no name — so a visitor who landed on
 * /auth directly was stuck (KRTX-1793). It renders the brand as a named home
 * link now, with a hit-area extension that lifts the 22px glyph to the 44px
 * touch floor.
 */
import { describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

mock.module('next/link', () => ({
  default: (props: { children?: React.ReactNode } & Record<string, unknown>) => {
    const routerOnly = ['prefetch', 'replace', 'scroll', 'shallow', 'onNavigate', 'legacyBehavior'];
    const anchorProps = Object.fromEntries(
      Object.entries(props).filter(([key]) => !routerOnly.includes(key)),
    );
    return React.createElement('a', { 'data-next-link': 'true', ...anchorProps });
  },
}));

const { AuthMobileLogo } = await import('./auth-primitives');

describe('auth corner brand', () => {
  test('is a named home link, not a bare glyph', () => {
    const html = renderToStaticMarkup(React.createElement(AuthMobileLogo));
    expect(html).toContain('href="/"');
    expect(html).toContain('aria-label="Kortix home"');
    expect(html).toContain('hit-area-3');
  });
});
