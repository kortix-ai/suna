import { describe, expect, test } from 'bun:test';

import {
  buildScrapeFailureResults,
  parseScrapeInputUrls,
  resolveScrapeResults,
} from './web-helpers';

describe('scrape web helpers', () => {
  test('parseScrapeInputUrls splits comma/space separated urls', () => {
    expect(parseScrapeInputUrls({ urls: 'https://a.com https://b.com' })).toEqual([
      'https://a.com',
      'https://b.com',
    ]);
    expect(parseScrapeInputUrls({ urls: ['https://a.com', 'https://b.com'] })).toEqual([
      'https://a.com',
      'https://b.com',
    ]);
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
    const results = resolveScrapeResults(output, { urls: 'https://kortix.com' });
    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(false);
    expect(results[0].error).toContain('timeout');
  });
});
