import { describe, expect, test } from 'bun:test';

import {
  buildScrapeFailureResults,
  parseScrapeOutput,
  parseScrapeInputUrls,
  parseWebSearchOutput,
  resolveScrapeResults,
} from './web-helpers';

describe('web search output shapes', () => {
  const source = {
    title: 'Example',
    url: 'https://example.test/page',
    content: 'Excerpt',
    author: 'Writer',
    published_date: '2026-01-01',
  };
  const mapped = {
    title: source.title,
    url: source.url,
    snippet: source.content,
    author: source.author,
    publishedDate: source.published_date,
  };

  test('query results, including invalid entries and secondary queries', () => {
    expect(
      parseWebSearchOutput({
        results: [
          {
            query: 'one',
            answer: 'yes',
            results: [{ url: 'missing title' }, source],
          },
          { query: 'two', results: [source] },
          { results: [source] },
        ],
      }),
    ).toEqual([
      { query: 'one', answer: 'yes', sources: [mapped] },
      { query: 'two', answer: undefined, sources: [mapped] },
    ]);
  });

  test('flat results preserve outer query and answer', () => {
    expect(
      parseWebSearchOutput({ query: 'flat', answer: 'ok', results: [source] }),
    ).toEqual([{ query: 'flat', answer: 'ok', sources: [mapped] }]);
  });

  test('query with invalid sources still returns an empty source list', () => {
    expect(
      parseWebSearchOutput({ query: 'empty', results: [{ title: 'no url' }] }),
    ).toEqual([{ query: 'empty', answer: undefined, sources: [] }]);
  });

  test('top-level array, double-encoded JSON, BOM and whitespace', () => {
    expect(parseWebSearchOutput([source])).toEqual([
      { query: '', sources: [mapped] },
    ]);
    expect(
      parseWebSearchOutput(JSON.stringify(JSON.stringify([source]))),
    ).toEqual([{ query: '', sources: [mapped] }]);
    expect(
      parseWebSearchOutput(
        `\uFEFF ${JSON.stringify({ query: 'bom', results: [source] })}`,
      ),
    ).toEqual([{ query: 'bom', answer: undefined, sources: [mapped] }]);
  });

  test('title blocks and recovered links retain their distinct source shapes', () => {
    expect(
      parseWebSearchOutput(
        'Title: Example\nURL: https://example.test/page\nAuthor: Writer\nPublished Date: 2026-01-01\nText: Excerpt',
      ),
    ).toEqual([{ query: '', sources: [mapped] }]);
    expect(
      parseWebSearchOutput(
        '{"title":"Example","url":"https://example.test/page"',
      ),
    ).toEqual([
      {
        query: '',
        sources: [
          {
            title: 'Example',
            url: 'https://example.test/page',
            snippet: undefined,
          },
        ],
      },
    ]);
  });

  test('scrape output retains double-encoded parsing and link recovery', () => {
    expect(
      parseScrapeOutput(
        JSON.stringify(
          JSON.stringify({ results: [{ url: source.url, text: 'Excerpt' }] }),
        ),
      ),
    ).toEqual({
      total: 1,
      successful: 1,
      failed: 0,
      results: [
        {
          url: source.url,
          success: true,
          title: undefined,
          content: 'Excerpt',
          error: undefined,
        },
      ],
    });
  });
});

describe('scrape web helpers', () => {
  test('parseScrapeInputUrls splits comma/space separated urls', () => {
    expect(
      parseScrapeInputUrls({ urls: 'https://a.com https://b.com' }),
    ).toEqual(['https://a.com', 'https://b.com']);
    expect(
      parseScrapeInputUrls({ urls: ['https://a.com', 'https://b.com'] }),
    ).toEqual(['https://a.com', 'https://b.com']);
  });

  test('buildScrapeFailureResults maps per-url errors from aggregate message', () => {
    const output =
      'Error: Failed to scrape all 1 URLs. https://kortix.com: timeout of 35000ms exceeded';
    const results = buildScrapeFailureResults(output, ['https://kortix.com']);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      url: 'https://kortix.com',
      success: false,
      error: 'timeout of 35000ms exceeded',
    });
  });

  test('resolveScrapeResults falls back to input urls on plain error output', () => {
    const output =
      'Error: Failed to scrape all 1 URLs. https://kortix.com: timeout of 35000ms exceeded';
    const results = resolveScrapeResults(output, {
      urls: 'https://kortix.com',
    });
    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(false);
    expect(results[0].error).toContain('timeout');
  });
});
