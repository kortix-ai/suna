import { describe, expect, test } from 'bun:test';
import { NextIntlClientProvider } from 'next-intl';
import type { ComponentType, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { DocMarkdown } from './doc-markdown';
import { INCOMPLETE_LINK_HREF, type MarkdownActionLink } from './markdown-action-link';
import { MarkdownActionBlock, resolveActionBlock } from './markdown-link';
import { UnifiedMarkdown } from './unified-markdown';

function withIntl(node: ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={{}} onError={() => {}}>
      {node}
    </NextIntlClientProvider>
  );
}

const RENDERERS: Array<[string, ComponentType<{ content: string; actionLinks?: boolean }>]> = [
  ['UnifiedMarkdown', UnifiedMarkdown],
  ['DocMarkdown', DocMarkdown],
];

function count(html: string, needle: string): number {
  return html.split(needle).length - 1;
}

for (const [name, R] of RENDERERS) {
  const render = (content: string) =>
    renderToStaticMarkup(withIntl(<R content={content} actionLinks />));
  const renderDefault = (content: string) =>
    renderToStaticMarkup(withIntl(<R content={content} />));

  describe(`${name} without actionLinks`, () => {
    test('a standalone internal link stays an inline link', () => {
      const html = renderDefault('[Open files](/projects/p1/files)');

      expect(html).toContain('text-kortix-blue');
      expect(html).not.toContain('data-slot="button"');
    });

    test('a heading that is only a connect link stays a heading', () => {
      const html = renderDefault(
        '## [Connect Shopify](https://connect.composio.dev/link/lk_debug)',
      );

      expect(html).toContain('<h2');
      expect(html).toContain('text-kortix-blue');
      expect(html).not.toContain('data-testid="outcome-card-external"');
    });

    test('a setup link still renders the setup card inline', () => {
      const html = renderDefault('[Connect Gmail](/connect/ksl_debug_token)');

      expect(html).toContain('data-outcome-id="setup:ksl_debug_token"');
    });
  });

  describe(`${name} streaming placeholder links`, () => {
    // Streamdown's `remend` closes a partial link as `[label](streamdown:incomplete-link)`
    // while streaming. These strings are that remended output, rendered directly:
    // a streaming-mode server render emits no markup to assert on.
    test('a heading holding one partial link renders a pending chip, not a heading', () => {
      const html = render(`## → [Connect Shopify](${INCOMPLETE_LINK_HREF})`);

      expect(html).not.toContain('<h2');
      expect(html).not.toContain('text-kortix-blue');
      expect(html).not.toContain('[blocked]');
      expect(html).toContain('data-slot="button"');
      expect(html).toContain('disabled=""');
      expect(html).toContain('aria-disabled="true"');
      expect(html).toContain('Connect Shopify');
      expect(html).not.toContain(`href="${INCOMPLETE_LINK_HREF}"`);
    });

    test('a finished link plus a partial link renders two chips, not text', () => {
      const html = render(`→ [Open files](/projects/p1/files)\n→ [Proj](${INCOMPLETE_LINK_HREF})`);

      expect(count(html, 'data-slot="button"')).toBe(2);
      expect(html).toContain('href="/projects/p1/files"');
      expect(html).not.toContain('text-kortix-blue');
      expect(html).not.toContain('[blocked]');
    });

    test('a partial link inside prose renders its label as text, never as a blocked URL', () => {
      const html = render(`See [the guide](${INCOMPLETE_LINK_HREF}) for details.`);

      expect(html).toContain('the guide');
      expect(html).not.toContain('[blocked]');
      expect(html).not.toContain(`href="${INCOMPLETE_LINK_HREF}"`);
    });
  });

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

    test('an autolinked scheme-less URL stays an inline link', () => {
      for (const md of ['www.example.com', 'docs.example.com/guide']) {
        const html = render(md);
        expect(html).not.toContain('data-slot="button"');
      }
    });

    test('a connect card button uses the label verb and a unique accessible name', () => {
      const html = render('[Authorize Linear](https://auth.example.com/oauth)');

      expect(html).toContain('>Authorize</a>');
      expect(html).toContain('aria-label="Authorize Linear (opens in a new tab)"');
    });

    test('a connect card without a connect verb falls back to Connect', () => {
      const html = render('[Shopify](https://connect.composio.dev/link/lk_debug)');

      expect(html).toContain('>Connect</a>');
      // The accessible name starts with the visible text "Connect".
      expect(html).toContain('aria-label="Connect Shopify (opens in a new tab)"');
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

describe('hydration-safe origin', () => {
  const SAME_ORIGIN_MD = '[Open report](https://app.example.com/projects/p1/report)';

  function expectNullOriginMarkup(html: string) {
    // `null` origin → an absolute URL is external: new-tab chip, not an internal one.
    expect(html).toContain('data-slot="button"');
    expect(html).toContain('href="https://app.example.com/projects/p1/report"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('aria-label="Open report (opens in a new tab)"');
  }

  for (const [name, R] of RENDERERS) {
    test(`${name} server render classifies a same-origin absolute link with a null origin`, () => {
      expect(typeof window).toBe('undefined');
      expectNullOriginMarkup(
        renderToStaticMarkup(withIntl(<R content={SAME_ORIGIN_MD} actionLinks />)),
      );
    });

    test(`${name} server render ignores window.location.origin even when window exists`, () => {
      const g = globalThis as { window?: unknown };
      g.window = { location: { origin: 'https://app.example.com' } };
      try {
        expectNullOriginMarkup(
          renderToStaticMarkup(withIntl(<R content={SAME_ORIGIN_MD} actionLinks />)),
        );
      } finally {
        delete g.window;
      }
    });
  }
});

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

  test('a bare localhost URL stays inline even when the proxy rewrites it', () => {
    const actions = resolveActionBlock(
      [{ href: 'http://localhost:3000/', text: 'http://localhost:3000/' }],
      (url) => (url ? `https://app.example.com/proxy?u=${encodeURIComponent(url)}` : url),
      null,
    );

    expect(actions).toBeNull();
  });

  test('a partial link does not disqualify the block', () => {
    const actions = resolveActionBlock(
      [
        { href: '/projects/p1/files', text: 'Open files' },
        { href: INCOMPLETE_LINK_HREF, text: 'Proj' },
      ],
      identity,
      null,
    );

    expect(actions?.map((a) => a.kind)).toEqual(['internal', 'pending']);
  });

  test('a partial link with no label yet is dropped, not rendered', () => {
    expect(resolveActionBlock([{ href: INCOMPLETE_LINK_HREF, text: '' }], identity, null)).toEqual(
      [],
    );
  });

  test('returns null for an empty list', () => {
    expect(resolveActionBlock([], identity, null)).toBeNull();
  });
});

describe('MarkdownActionBlock internal chip target', () => {
  const internal = (href: string): MarkdownActionLink => ({
    kind: 'internal',
    href,
    label: 'Open report',
    host: href.startsWith('/') ? null : 'app.example.com',
    icon: 'arrow-right',
  });
  const render = (action: MarkdownActionLink) =>
    renderToStaticMarkup(withIntl(<MarkdownActionBlock actions={[action]} />));

  test('an absolute same-origin chip opens a new tab, like the inline link did', () => {
    const html = render(internal('https://app.example.com/projects/p1/report'));

    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  test('a root-relative chip stays in the same tab', () => {
    const html = render(internal('/projects/p1/report'));

    expect(html).not.toContain('target="_blank"');
  });
});
