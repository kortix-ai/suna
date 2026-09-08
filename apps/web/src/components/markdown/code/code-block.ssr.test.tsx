import { describe, expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

/**
 * The server must render code blocks in the LIGHT palette no matter what the
 * viewer's theme is, because it cannot know it — and because the hydrating
 * client render has to produce the same markup.
 *
 * This is a regression test for a real, long-lived bug. `resolvedTheme` is only
 * available on the client, so the server emitted `min-light` while a dark-mode
 * client rendered `min-dark`. React does not reconcile
 * `dangerouslySetInnerHTML` on a hydration mismatch — it keeps the server's DOM
 * and only warns — and the correcting effect then computed the same dark string
 * it already held, so `setHtml` bailed out and no re-render ever wrote it. A
 * dark-mode reader kept LIGHT code blocks for the life of the page. It went
 * unseen until `/templates/<slug>` became the first surface to server-render
 * markdown that contains fenced code.
 */

// The highlighter is stubbed to echo the theme it was asked for, so the
// assertion is about which palette the component CHOSE rather than about Shiki.
mock.module('./shiki-highlighter', () => ({
  SHIKI_THEME_DARK: 'min-dark',
  SHIKI_THEME_LIGHT: 'min-light',
  SHIKI_RESET: 'shiki-reset',
  highlightSync: (_code: string, _lang: string, theme: string) =>
    `<pre class="shiki ${theme}"><code>x</code></pre>`,
  highlightAsync: async (_code: string, _lang: string, theme: string) =>
    `<pre class="shiki ${theme}"><code>x</code></pre>`,
}));

// A dark-mode viewer — the case that used to break.
mock.module('next-themes', () => ({
  useTheme: () => ({ resolvedTheme: 'dark' }),
}));

const { HighlightedCode } = await import('./code-block');

describe('HighlightedCode on the server', () => {
  test('renders the light palette even when the client theme is dark', () => {
    const html = renderToStaticMarkup(
      createElement(HighlightedCode, { code: 'const a = 1;', language: 'ts' }),
    );
    // The server cannot know the viewer's theme, so it must not act on one.
    expect(html).toContain('min-light');
    expect(html).not.toContain('min-dark');
  });

  test('the choice does not depend on the code or the language', () => {
    for (const [code, language] of [
      ['x', 'text'],
      ['SELECT 1', 'sql'],
      ['# hi', 'markdown'],
    ] as const) {
      const html = renderToStaticMarkup(createElement(HighlightedCode, { code, language }));
      expect(html).toContain('min-light');
    }
  });
});
