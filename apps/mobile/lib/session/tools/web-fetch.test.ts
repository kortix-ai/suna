import { describe, expect, test } from 'bun:test';
import {
  capScrapeContent,
  getScrapeContent,
  scrapeResultKeys,
  webFetchErrorSummary,
  webFetchTrigger,
} from './web-fetch';

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
