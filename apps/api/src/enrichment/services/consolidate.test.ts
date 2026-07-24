import { describe, expect, test } from 'bun:test';
import type { StructuredSignals } from './discovery';
import { consolidate, titleOf, type ConsolidatePage } from './consolidate';

const DOMAIN = 'example.com';

function signals(overrides: Partial<StructuredSignals> = {}): StructuredSignals {
  return { title: null, jsonLd: [], openGraph: {}, meta: {}, ...overrides };
}

function page(url: string, markdown: string, tier: ConsolidatePage['tier'] = 'priority'): ConsolidatePage {
  return { url, markdown, tier };
}

describe('titleOf', () => {
  test('reads the first markdown heading', () => {
    expect(titleOf('# Launching v2\n\nBody text')).toBe('Launching v2');
  });

  test('skips leading blank lines', () => {
    expect(titleOf('\n\n## Our team\n\nbody')).toBe('Our team');
  });

  test('falls back to the first line of prose', () => {
    expect(titleOf('Just some text\nmore')).toBe('Just some text');
  });

  test('returns null for empty markdown', () => {
    expect(titleOf('   \n  ')).toBeNull();
  });
});

describe('consolidate', () => {
  test('puts the domain and page content in the output', () => {
    const result = consolidate(DOMAIN, [page('https://example.com/about', '# About us')], signals());
    expect(result.text).toContain(DOMAIN);
    expect(result.text).toContain('https://example.com/about');
    expect(result.text).toContain('About us');
  });

  test('labels json-ld as trusted structured data', () => {
    const result = consolidate(
      DOMAIN,
      [],
      signals({ jsonLd: [{ '@type': 'Organization', name: 'Example Inc' }] }),
    );
    expect(result.text).toContain('TRUSTED structured data');
    expect(result.text).toContain('Example Inc');
  });

  test('includes opengraph and meta description', () => {
    const result = consolidate(
      DOMAIN,
      [],
      signals({ openGraph: { title: 'Example' }, meta: { description: 'We do things' } }),
    );
    expect(result.text).toContain('og:title: Example');
    expect(result.text).toContain('We do things');
  });

  test('reduces blog pages to titles and links', () => {
    const result = consolidate(
      DOMAIN,
      [page('https://example.com/blog/a', '# Launch day\n\nA long story about the launch.', 'blog')],
      signals(),
    );
    expect(result.text).toContain('Blog index');
    expect(result.text).toContain('Launch day');
    expect(result.text).not.toContain('A long story about the launch.');
  });

  test('truncates a single oversized page', () => {
    const long = `# About\n\n${'x'.repeat(50_000)}`;
    const result = consolidate(DOMAIN, [page('https://example.com/about', long)], signals(), {
      perPageChars: 1_000,
    });
    expect(result.text).toContain('[content truncated]');
    expect(result.text.length).toBeLessThan(10_000);
  });

  test('keeps the whole page when it fits', () => {
    const result = consolidate(DOMAIN, [page('https://example.com/about', '# About\n\nshort')], signals());
    expect(result.text).not.toContain('[content truncated]');
  });

  test('stays within the token budget', () => {
    const pages = Array.from({ length: 40 }, (_, i) =>
      page(`https://example.com/p${i}`, `# Page ${i}\n\n${'y'.repeat(20_000)}`),
    );
    const result = consolidate(DOMAIN, pages, signals(), { tokenBudget: 10_000 });
    expect(result.approxTokens).toBeLessThanOrEqual(10_500);
  });

  test('reports which pages were omitted', () => {
    const pages = Array.from({ length: 20 }, (_, i) =>
      page(`https://example.com/p${i}`, `# Page ${i}\n\n${'y'.repeat(9_000)}`),
    );
    const result = consolidate(DOMAIN, pages, signals(), { tokenBudget: 5_000 });

    expect(result.omittedUrls.length).toBeGreaterThan(0);
    expect(result.includedUrls.length + result.omittedUrls.length).toBe(20);
  });

  test('tells the model when its view of the site is partial', () => {
    const pages = Array.from({ length: 20 }, (_, i) =>
      page(`https://example.com/p${i}`, `# Page ${i}\n\n${'y'.repeat(9_000)}`),
    );
    const result = consolidate(DOMAIN, pages, signals(), { tokenBudget: 5_000 });
    expect(result.text).toContain('were not included');
    expect(result.text).toContain('Do not guess');
  });

  test('drops content pages before it drops the trusted header', () => {
    const pages = Array.from({ length: 10 }, (_, i) =>
      page(`https://example.com/p${i}`, `# Page ${i}\n\n${'y'.repeat(9_000)}`),
    );
    const result = consolidate(
      DOMAIN,
      pages,
      signals({ jsonLd: [{ '@type': 'Organization', name: 'Example Inc' }] }),
      { tokenBudget: 2_000 },
    );
    expect(result.text).toContain('Example Inc');
    expect(result.omittedUrls.length).toBeGreaterThan(0);
  });

  test('prefers content pages over blog entries when the budget is tight', () => {
    const pages = [
      page('https://example.com/about', `# About\n\n${'a'.repeat(3_000)}`),
      page('https://example.com/blog/x', '# A post', 'blog'),
    ];
    const result = consolidate(DOMAIN, pages, signals(), { tokenBudget: 900 });
    expect(result.includedUrls).toContain('https://example.com/about');
  });

  test('handles a site with no pages at all', () => {
    const result = consolidate(DOMAIN, [], signals({ title: 'Example Inc' }));
    expect(result.includedUrls).toEqual([]);
    expect(result.text).toContain('Example Inc');
  });

  test('reports approximate token usage', () => {
    const result = consolidate(DOMAIN, [page('https://example.com/', '# Home')], signals());
    expect(result.approxTokens).toBeGreaterThan(0);
    expect(result.approxTokens).toBe(Math.ceil(result.text.length / 4));
  });
});
