import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlTestProvider } from '../test-utils/intl';
import { UnifiedMarkdown } from './unified-markdown';
import { appLink } from './app-links';

const cases = [
  ['https://github.com/example/project/pull/123', 'PR #123'],
  ['https://github.com/example/project/issues/42#issuecomment-1', 'Issue #42'],
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
    expect(html).toContain(label);
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
  expect(html).toMatch(/<strong[^>]*>Review this<\/strong>/);
  expect(html).not.toContain('PR #123');
  expect(html).toContain('https://example.com/page');
});
test('rejects lookalike hosts, credentials, protocols and non-resource pages', () => {
  for (const href of [
    'https://github.com.evil.test/a/b/pull/1',
    'https://github.com@evil.test/a/b/pull/1',
    'http://github.com/a/b/pull/1',
    'https://github.com/a/b',
    'https://linear.app/settings',
    'https://evilslack.com/archives/C1/p123',
    'javascript:alert(1)',
    '#section',
  ])
    expect(appLink(href)).toBeNull();
});
