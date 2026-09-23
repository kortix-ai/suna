import { describe, expect, test } from 'bun:test';
import { NextIntlClientProvider } from 'next-intl';
import type { ComponentType, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { DocMarkdown } from './doc-markdown';
import { resolveActionBlock } from './markdown-link';
import { UnifiedMarkdown } from './unified-markdown';

function withIntl(node: ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={{}} onError={() => {}}>
      {node}
    </NextIntlClientProvider>
  );
}

const RENDERERS: Array<[string, ComponentType<{ content: string }>]> = [
  ['UnifiedMarkdown', UnifiedMarkdown],
  ['DocMarkdown', DocMarkdown],
];

function count(html: string, needle: string): number {
  return html.split(needle).length - 1;
}

for (const [name, R] of RENDERERS) {
  const render = (content: string) => renderToStaticMarkup(withIntl(<R content={content} />));

  describe(`${name} standalone action links`, () => {
    test('a heading that is only a connect link renders the connect card, not a heading', () => {
      const html = render('## → [Connect Shopify](https://connect.composio.dev/link/lk_debug)');

      expect(html).not.toContain('<h2');
      expect(html).toContain('data-testid="outcome-card-external"');
      expect(html).toContain('Connect Shopify');
      expect(html).toContain('connect.composio.dev');
      expect(html).toContain('href="https://connect.composio.dev/link/lk_debug"');
      expect(html).not.toContain('text-kortix-blue');
    });

    test('a paragraph that is only an internal link renders a button chip', () => {
      const html = render('[Open files](/projects/p1/files)');

      expect(html).toContain('data-slot="button"');
      expect(html).toContain('href="/projects/p1/files"');
      expect(html).not.toContain('text-kortix-blue');
    });

    test('an external chip opens a new tab and announces it', () => {
      const html = render('[Read the guide](https://docs.example.com/guide)');

      expect(html).toContain('data-slot="button"');
      expect(html).toContain('href="https://docs.example.com/guide"');
      expect(html).toContain('target="_blank"');
      expect(html).toContain('rel="noopener noreferrer"');
      expect(html).toContain('aria-label="Read the guide (opens in a new tab)"');
      expect(html).not.toContain('text-kortix-blue');
    });

    test('a link inside prose stays an inline link', () => {
      const html = render('See [the guide](https://docs.example.com/guide) for details.');

      expect(html).toContain('text-kortix-blue');
      expect(html).not.toContain('data-slot="button"');
    });

    test('a bare autolinked URL stays an inline link', () => {
      const html = render('https://docs.example.com/guide');

      expect(html).toContain('text-kortix-blue');
      expect(html).not.toContain('data-slot="button"');
    });

    test('a setup link keeps the setup card', () => {
      const html = render('[Connect Gmail](/connect/ksl_debug_token)');

      expect(html).toContain('data-outcome-id="setup:ksl_debug_token"');
      expect(html).toContain('Connect Gmail');
    });

    test('two links on separate lines in one paragraph render two chips', () => {
      const html = render(
        '[Open files](/projects/p1/files)\n[Open settings](/projects/p1/settings)',
      );

      expect(count(html, 'data-slot="button"')).toBe(2);
      expect(html).toContain('href="/projects/p1/files"');
      expect(html).toContain('href="/projects/p1/settings"');
      expect(html).not.toContain('text-kortix-blue');
    });

    test('a mixed block renders the card first, then the chip row', () => {
      const html = render(
        '[Open files](/projects/p1/files)\n[Connect Shopify](https://connect.composio.dev/link/lk_debug)',
      );

      const cardAt = html.indexOf('data-testid="outcome-card-external"');
      const chipAt = html.indexOf('href="/projects/p1/files"');
      expect(cardAt).toBeGreaterThan(-1);
      expect(chipAt).toBeGreaterThan(cardAt);
      expect(html).not.toContain('text-kortix-blue');
    });

    test('a hash link alone stays an inline link', () => {
      const html = render('[Jump](#section)');

      expect(html).toContain('text-kortix-blue');
      expect(html).not.toContain('data-slot="button"');
    });
  });
}

describe('resolveActionBlock', () => {
  const identity = (url: string | undefined) => url;

  test('classifies every link when all of them are actions', () => {
    const actions = resolveActionBlock(
      [
        { href: '/projects/p1/files', text: 'Open files' },
        { href: 'https://docs.example.com/guide', text: 'Read the guide' },
      ],
      identity,
      null,
    );

    expect(actions?.map((a) => a.kind)).toEqual(['internal', 'external']);
  });

  test('returns null when any link is not an action', () => {
    const actions = resolveActionBlock(
      [
        { href: '/projects/p1/files', text: 'Open files' },
        { href: '#section', text: 'Jump' },
      ],
      identity,
      null,
    );

    expect(actions).toBeNull();
  });

  test('classifies the proxied href, not the raw one', () => {
    const actions = resolveActionBlock(
      [{ href: 'http://localhost:3000/report', text: 'Open report' }],
      (url) => (url ? `https://app.example.com/proxy?u=${encodeURIComponent(url)}` : url),
      'https://app.example.com',
    );

    expect(actions?.[0].kind).toBe('internal');
    expect(actions?.[0].href).toBe(
      'https://app.example.com/proxy?u=http%3A%2F%2Flocalhost%3A3000%2Freport',
    );
  });

  test('returns null for an empty list', () => {
    expect(resolveActionBlock([], identity, null)).toBeNull();
  });
});
