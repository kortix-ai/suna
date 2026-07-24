import { describe, expect, test } from 'bun:test';
import {
  classifyUrl,
  isExcluded,
  isSameOrigin,
  MAX_SELECTED_URLS,
  normalizeUrl,
  selectUrls,
} from './url-filter';

const ORIGIN = 'https://example.com';

describe('normalizeUrl', () => {
  test('strips the fragment', () => {
    expect(normalizeUrl('https://example.com/about#team')).toBe('https://example.com/about');
  });

  test('strips utm and click-id parameters', () => {
    expect(normalizeUrl('https://example.com/p?utm_source=x&utm_medium=y&gclid=z')).toBe(
      'https://example.com/p',
    );
  });

  test('keeps meaningful query parameters', () => {
    expect(normalizeUrl('https://example.com/p?id=7')).toBe('https://example.com/p?id=7');
  });

  test('sorts query parameters so link order does not create duplicates', () => {
    expect(normalizeUrl('https://example.com/p?b=2&a=1')).toBe(
      normalizeUrl('https://example.com/p?a=1&b=2'),
    );
  });

  test('drops a trailing slash but keeps the root path', () => {
    expect(normalizeUrl('https://example.com/about/')).toBe('https://example.com/about');
    expect(normalizeUrl('https://example.com/')).toBe('https://example.com/');
  });

  test('lowercases the host but preserves path case', () => {
    expect(normalizeUrl('https://EXAMPLE.com/AboutUs')).toBe('https://example.com/AboutUs');
  });

  test('resolves relative links against the base', () => {
    expect(normalizeUrl('/pricing', ORIGIN)).toBe('https://example.com/pricing');
  });

  test('returns null for unparseable input', () => {
    expect(normalizeUrl('not a url')).toBeNull();
  });

  test('returns null for non-http schemes', () => {
    expect(normalizeUrl('mailto:hi@example.com')).toBeNull();
    expect(normalizeUrl('javascript:alert(1)')).toBeNull();
  });
});

describe('isSameOrigin', () => {
  test('accepts the same host', () => {
    expect(isSameOrigin('https://example.com/about', ORIGIN)).toBe(true);
  });

  test('treats www as the same site', () => {
    expect(isSameOrigin('https://www.example.com/about', ORIGIN)).toBe(true);
  });

  test('rejects a different host', () => {
    expect(isSameOrigin('https://evil.com/about', ORIGIN)).toBe(false);
  });

  test('rejects a subdomain', () => {
    expect(isSameOrigin('https://blog.example.com/p', ORIGIN)).toBe(false);
  });
});

describe('isExcluded', () => {
  const excluded = [
    'https://example.com/logo.png',
    'https://example.com/app.js',
    'https://example.com/styles.css',
    'https://example.com/whitepaper.pdf',
    'https://example.com/wp-content/uploads/x',
    'https://example.com/static/chunk',
    'https://example.com/tag/engineering',
    'https://example.com/category/news',
    'https://example.com/blog/page/3',
    'https://example.com/docs/getting-started',
    'https://example.com/api/v1/users',
    'https://example.com/login',
    'https://example.com/privacy',
    'https://example.com/terms',
    'https://example.com/cart',
    'https://example.com/search',
  ];

  for (const url of excluded) {
    test(`excludes ${url}`, () => {
      expect(isExcluded(url)).toBe(true);
    });
  }

  const kept = [
    'https://example.com/',
    'https://example.com/about',
    'https://example.com/pricing',
    'https://example.com/blog/how-we-built-it',
    'https://example.com/product/analytics',
  ];

  for (const url of kept) {
    test(`keeps ${url}`, () => {
      expect(isExcluded(url)).toBe(false);
    });
  }
});

describe('classifyUrl', () => {
  test('ranks the homepage highest', () => {
    expect(classifyUrl('https://example.com/').score).toBeGreaterThan(
      classifyUrl('https://example.com/about').score,
    );
  });

  test('marks company pages as priority', () => {
    for (const path of ['/about', '/about-us', '/team', '/company', '/pricing', '/product/x', '/features', '/contact']) {
      expect(classifyUrl(`https://example.com${path}`).tier).toBe('priority');
    }
  });

  test('marks blog pages as the blog tier', () => {
    expect(classifyUrl('https://example.com/blog').tier).toBe('blog');
    expect(classifyUrl('https://example.com/blog/a-post').tier).toBe('blog');
    expect(classifyUrl('https://example.com/news/launch').tier).toBe('blog');
  });

  test('ranks a blog listing above an individual post', () => {
    expect(classifyUrl('https://example.com/blog').score).toBeGreaterThan(
      classifyUrl('https://example.com/blog/a-post').score,
    );
  });

  test('ranks priority pages above blog pages', () => {
    expect(classifyUrl('https://example.com/pricing').score).toBeGreaterThan(
      classifyUrl('https://example.com/blog').score,
    );
  });

  test('falls back to the other tier', () => {
    expect(classifyUrl('https://example.com/random-page').tier).toBe('other');
  });
});

describe('selectUrls', () => {
  test('dedupes urls that canonicalize to the same page', () => {
    const result = selectUrls(
      [
        'https://example.com/about',
        'https://example.com/about/',
        'https://example.com/about#team',
        'https://example.com/about?utm_source=x',
      ],
      ORIGIN,
    );
    expect(result).toHaveLength(1);
    expect(result[0].url).toBe('https://example.com/about');
  });

  test('drops cross-origin and excluded urls', () => {
    const result = selectUrls(
      [
        'https://example.com/about',
        'https://evil.com/about',
        'https://example.com/privacy',
        'https://example.com/logo.png',
      ],
      ORIGIN,
    );
    expect(result.map((r) => r.url)).toEqual(['https://example.com/about']);
  });

  test('orders by descending signal', () => {
    const result = selectUrls(
      [
        'https://example.com/random',
        'https://example.com/blog/post',
        'https://example.com/pricing',
        'https://example.com/',
      ],
      ORIGIN,
    );
    expect(result.map((r) => r.url)).toEqual([
      'https://example.com/',
      'https://example.com/pricing',
      'https://example.com/blog/post',
      'https://example.com/random',
    ]);
  });

  test('caps the result at the page budget', () => {
    const many = Array.from({ length: 120 }, (_, i) => `https://example.com/page-${i}`);
    expect(selectUrls(many, ORIGIN)).toHaveLength(MAX_SELECTED_URLS);
  });

  test('honours an explicit lower limit', () => {
    const many = Array.from({ length: 20 }, (_, i) => `https://example.com/page-${i}`);
    expect(selectUrls(many, ORIGIN, 5)).toHaveLength(5);
  });

  test('keeps the homepage when the budget is exhausted by low-value pages', () => {
    const many = Array.from({ length: 120 }, (_, i) => `https://example.com/page-${i}`);
    const result = selectUrls([...many, 'https://example.com/'], ORIGIN);
    expect(result[0].url).toBe('https://example.com/');
  });

  test('is deterministic for equal scores', () => {
    const input = ['https://example.com/b-page', 'https://example.com/a-page'];
    expect(selectUrls(input, ORIGIN)).toEqual(selectUrls([...input].reverse(), ORIGIN));
  });

  test('returns an empty list for no usable input', () => {
    expect(selectUrls(['mailto:x@example.com', 'javascript:alert(1)', 'tel:+15550100'], ORIGIN))
      .toEqual([]);
  });

  test('resolves relative hrefs against the origin', () => {
    expect(selectUrls(['about', '/pricing'], ORIGIN).map((r) => r.url)).toEqual([
      'https://example.com/about',
      'https://example.com/pricing',
    ]);
  });
});
