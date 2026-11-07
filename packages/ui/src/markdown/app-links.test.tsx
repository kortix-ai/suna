import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlTestProvider } from '../test-utils/intl';
import { MarkdownLink, UnifiedMarkdown } from './unified-markdown';
import { appLink } from './app-links';

const cases = [
  ['https://github.com/example/project/pull/123', 'PR #123'],
  ['https://github.com/example/project/issues/42#issuecomment-1', 'Issue #42'],
  ['https://github.com/example-user', 'example-user'],
  ['https://github.com/example/project/', 'example/project'],
  ['https://linear.app/example/issue/ENG-123/fix-links', 'ENG-123'],
  [
    'https://example.slack.com/archives/C123/p1234567890123456',
    'Slack message',
  ],
  ['https://app.slack.com/client/T123/C123', 'Slack conversation'],
  ['https://www.figma.com/design/abc123/Example?node-id=1-2', 'Example'],
  ['https://www.notion.so/Example-0123456789abcdef0123456789abcdef', 'Example'],
  ['https://docs.google.com/document/d/example/edit', 'Google Doc'],
  ['https://docs.google.com/spreadsheets/d/example/edit', 'Google Sheet'],
  ['https://docs.google.com/presentation/d/example/edit', 'Google Slides'],
];
for (const [href, label] of cases) {
  test(`renders ${label} with its original destination`, () => {
    expect(appLink(href)).not.toBeNull();
    const html = renderToStaticMarkup(
      <IntlTestProvider locale="en" onError={() => {}}>
        <UnifiedMarkdown trust="untrusted" content={href} />
      </IntlTestProvider>,
    );
    // The visible text, without tags: the mark and first word wrap together.
    expect(html.replace(/<[^>]+>/g, '')).toContain(label);
    expect(html).toContain(`href="${href.replaceAll('&', '&amp;')}"`);
    expect(html).toContain('aria-hidden="true"');
  });
}
test('preserves formatted custom labels and plain URLs outside recognised resources', () => {
  const html = renderToStaticMarkup(
    <IntlTestProvider locale="en" onError={() => {}}>
      <UnifiedMarkdown
        trust="untrusted"
        content={
          '[**Review this**](https://github.com/example/project/pull/123) and https://example.com/page'
        }
      />
    </IntlTestProvider>,
  );
  // The label stays bold; the mark is glued to its first character, which
  // splits the <strong> into two halves.
  const bold = [...html.matchAll(/<strong[^>]*>([^<]*)<\/strong>/g)].map((m) => m[1]).join('');
  expect(bold).toBe('Review this');
  expect(html).not.toContain('PR #123');
  expect(html).toContain('https://example.com/page');
});
test('rejects lookalike hosts, credentials, protocols and non-resource pages', () => {
  for (const href of [
    'https://github.com.evil.test/a/b/pull/1',
    'https://github.com@evil.test/a/b/pull/1',
    'http://github.com/a/b/pull/1',
    'https://github.com/a/b/tree/main',
    'https://github.com/settings',
    'https://github.com/orgs/example',
    'https://github.com/resources',
    'https://github.com/resources/articles',
    'https://github.com/partners',
    'https://github.com/-bad',
    'https://github.com/a/..',
    'https://linear.app/settings',
    'https://evilslack.com/archives/C1/p123',
    'javascript:alert(1)',
    '#section',
  ])
    expect(appLink(href)).toBeNull();
});

test('compacts streaming word wrappers and preserves formatted custom labels', () => {
  const href = 'https://github.com/example/project/pull/123';
  const render = (children: React.ReactNode) => renderToStaticMarkup(
    <IntlTestProvider locale="en" onError={() => {}}>
      <MarkdownLink href={href}>{children}</MarkdownLink>
    </IntlTestProvider>,
  );
  const text = (html: string) => html.replace(/<[^>]+>/g, '');
  const streaming = render(<span className="kx-stream-word">{href}</span>);
  expect(text(streaming)).toContain('PR #123');
  expect(streaming).toContain(`href="${href}"`);
  expect(text(render(<strong><span className="kx-stream-word">{href}</span></strong>))).not.toContain('PR #123');
});

test('glues the mark to the first character of a streaming or formatted label', () => {
  const href = 'https://github.com/example/project/pull/123';
  const render = (children: React.ReactNode) => renderToStaticMarkup(
    <IntlTestProvider locale="en" onError={() => {}}>
      <MarkdownLink href={href}>{children}</MarkdownLink>
    </IntlTestProvider>,
  );
  const glued = (html: string) =>
    /<span class="whitespace-nowrap">.*?<\/svg><\/span>(?:<span class="sr-only">[^<]*<\/span>)?(.*?)<\/span>/.exec(html)?.[1]
      ?.replace(/<[^>]+>/g, '');
  const streamed = render([
    <span key="a" className="kx-stream-word">Review</span>, ' ',
    <span key="b" className="kx-stream-word">the</span>,
  ]);
  expect(glued(streamed)).toBe('R');
  expect(streamed.replace(/<[^>]+>/g, '')).toContain('Review the');
  expect(glued(render(<strong>Review</strong>))).toBe('R');
  expect(glued(render('変更を確認'))).toBe('変');
  expect(glued(render('🇮🇳 India'))).toBe('🇮🇳');
  expect(glued(render('हिन्दी'))).toBe('हि');
});

test('keeps identifier labels whole and glues titles by their first character', () => {
  const glued = (href: string) => {
    const html = renderToStaticMarkup(
      <IntlTestProvider locale="en" onError={() => {}}>
        <UnifiedMarkdown trust="untrusted" content={href} />
      </IntlTestProvider>,
    );
    return /<span class="whitespace-nowrap">.*?<\/svg><\/span>(?:<span class="sr-only">[^<]*<\/span>)?(.*?)<\/span>/.exec(html)?.[1]
      ?.replace(/<[^>]+>/g, '');
  };
  expect(glued('https://linear.app/example/issue/ENG-42/readable-links')).toBe('ENG-42');
  expect(glued('https://github.com/example/project/pull/123')).toBe('PR #123');
  expect(glued('https://www.figma.com/design/abc123/Example')).toBe('E');
});

test('keeps an inline-code custom label as one chip next to the mark', () => {
  const html = renderToStaticMarkup(
    <IntlTestProvider locale="en" onError={() => {}}>
      <UnifiedMarkdown trust="untrusted" content={'[`config.ts`](https://www.notion.so/Example-0123456789abcdef0123456789abcdef)'} />
    </IntlTestProvider>,
  );
  expect(html.match(/<code[\s>]/g)?.length).toBe(1);
  expect(html).toMatch(/<span class="whitespace-nowrap">.*<span class="whitespace-normal"><code[^>]*>config\.ts<\/code><\/span><\/span>/);
});

test('an identifier too long to stay on one line falls back to a plain link', () => {
  // Identifier labels never wrap, so their length is capped: 9 digits, 10-character Linear keys.
  expect(appLink('https://github.com/example/project/pull/123456789')).not.toBeNull();
  expect(appLink(`https://github.com/example/project/pull/1${'0'.repeat(9)}`)).toBeNull();
  expect(appLink('https://linear.app/example/issue/ENGINEERIN-123456789')).not.toBeNull();
  expect(appLink(`https://linear.app/example/issue/ENG-1${'0'.repeat(9)}`)).toBeNull();
  expect(appLink('https://linear.app/example/issue/ENGINEERING-1')).toBeNull();
});
