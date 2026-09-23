import { describe, expect, test } from 'bun:test';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import DebugMarkdownLinksPage from './page';

/**
 * Render smoke test — the page composes UnifiedMarkdown, DocMarkdown, Tabs,
 * and Disclosure over ten fixtures; this only proves it imports and renders
 * cleanly under bun's `renderToStaticMarkup` (no DOM harness in apps/web —
 * see `unified-markdown.test.tsx` / `markdown-link.test.tsx` for the same
 * pattern). It does not exercise clicks (Stream, tab switch, disclosure
 * toggle) or theme.
 */
function withIntl(node: ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={{}} onError={() => {}}>
      {node}
    </NextIntlClientProvider>
  );
}

describe('/debug/markdown-links', () => {
  test('renders every fixture row plus the streaming replay row', () => {
    const html = renderToStaticMarkup(withIntl(<DebugMarkdownLinksPage />));

    expect(html).toContain('Markdown action links');
    expect(html).toContain('Streaming replay');

    // Ten fixture labels, in order.
    for (const label of [
      'Reported case',
      'Minted setup link',
      'Verb-only connect',
      'Internal resources',
      'External resources',
      'Inline links stay inline',
      'Bare URL stays a link',
      'Hash link',
      'Bold and heading variants',
      'Long label',
    ]) {
      expect(html).toContain(label);
    }
  });

  test('the reported case renders the connect card, not a heading', () => {
    const html = renderToStaticMarkup(withIntl(<DebugMarkdownLinksPage />));

    expect(html).toContain('data-testid="outcome-card-external"');
    expect(html).toContain('Connect Shopify');
  });

  test('the long-label fixture renders both truncation widths', () => {
    const html = renderToStaticMarkup(withIntl(<DebugMarkdownLinksPage />));

    expect(html).toContain('720px');
    expect(html).toContain('320px');
  });
});
