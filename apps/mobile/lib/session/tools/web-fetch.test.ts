import { describe, expect, test } from 'bun:test';

import {
  capScrapeContent,
  extractReadableHtml,
  getScrapeContent,
  prefersPreviewLink,
  safeHttpUrl,
  scrapeResultKeys,
  webFetchErrorSummary,
  webFetchTrigger,
} from './web-fetch';

describe('safeHttpUrl (web lib/safe-url)', () => {
  test('keeps http(s) URLs and normalises them', () => {
    expect(safeHttpUrl('https://example.com')).toBe('https://example.com/');
    expect(safeHttpUrl('  http://a.b/c?d=1 ')).toBe('http://a.b/c?d=1');
  });

  test('refuses relative, non-http and non-string values', () => {
    expect(safeHttpUrl('/internal/session/abc?token=secret123')).toBeNull();
    expect(safeHttpUrl('javascript:alert(1)')).toBeNull();
    expect(safeHttpUrl('')).toBeNull();
    expect(safeHttpUrl(42)).toBeNull();
  });
});

describe('prefersPreviewLink (web preview-url-fallback)', () => {
  test('document URLs are link-only previews', () => {
    expect(prefersPreviewLink('https://x.dev/report.pdf')).toBe(true);
    expect(prefersPreviewLink('https://x.dev/deck.pptx?v=2')).toBe(true);
    expect(prefersPreviewLink('https://x.dev/')).toBe(false);
    expect(prefersPreviewLink(null)).toBe(false);
  });
});

describe('extractReadableHtml (web tool-renderers-sanitization)', () => {
  test('reads the title and the visible text, skipping head, script and style', () => {
    const html =
      '<!doctype html><html><head><title>Kortix &amp; Co</title><style>p{}</style></head>' +
      '<body><script>var x = "<p>no</p>";</script><h1>Hello</h1><p>World &lt;3</p><!-- hidden --></body></html>';
    const { title, text } = extractReadableHtml(html);
    expect(title).toBe('Kortix & Co');
    expect(text).toBe('Hello\nWorld <3');
  });

  test('a page without a title has no title', () => {
    expect(extractReadableHtml('<div>a</div>').title).toBeUndefined();
  });
});

describe('web fetch trigger', () => {
  test('the page title leads and the domain is its subtitle', () => {
    expect(
      webFetchTrigger({ url: 'https://docs.kortix.com/a', format: 'html', pageTitle: 'Docs', domain: 'docs.kortix.com' }),
    ).toEqual({ title: 'Docs', subtitle: 'docs.kortix.com', args: ['html'] });
  });

  test('no title: the domain is the title, with no repeated subtitle', () => {
    expect(webFetchTrigger({ url: 'https://kortix.com', format: '', pageTitle: undefined, domain: 'kortix.com' })).toEqual({
      title: 'kortix.com',
      subtitle: undefined,
      args: undefined,
    });
  });

  test('a title equal to the domain draws no subtitle', () => {
    expect(
      webFetchTrigger({ url: 'https://kortix.com', format: '', pageTitle: 'kortix.com', domain: 'kortix.com' }).subtitle,
    ).toBeUndefined();
  });

  test('the error summary drops the "Error:" prefix', () => {
    expect(webFetchErrorSummary('Error: 404 Not Found ')).toBe('404 Not Found');
  });
});

describe('scrape webpage', () => {
  test('content is capped at 8000 characters with an ellipsis', () => {
    const long = 'a'.repeat(9000);
    const capped = capScrapeContent(long);
    expect(capped).toHaveLength(8001);
    expect(capped.endsWith('…')).toBe(true);
    expect(capScrapeContent('short')).toBe('short');
  });

  test('a failure shows its error, an empty page a placeholder, HTML is flagged', () => {
    expect(getScrapeContent({ url: 'https://a.b', success: false, error: 'blocked' })).toEqual({ content: 'blocked' });
    expect(getScrapeContent({ url: 'https://a.b', success: true, content: '   ' })).toEqual({
      content: 'No content extracted.',
    });
    expect(getScrapeContent({ url: 'https://a.b', success: true, content: '<div>x</div>' })).toEqual({
      content: '<div>x</div>',
      allowHtml: true,
    });
    expect(getScrapeContent({ url: 'https://a.b', success: true, content: '# Title' })).toEqual({ content: '# Title' });
  });

  test('repeated URLs get distinct keys', () => {
    expect(
      scrapeResultKeys([
        { url: 'https://a.b', success: true },
        { url: 'https://a.b', success: true },
        { url: 'https://c.d', success: true },
      ]),
    ).toEqual(['https://a.b', 'https://a.b#1', 'https://c.d']);
  });
});
