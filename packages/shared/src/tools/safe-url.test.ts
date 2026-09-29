import { describe, expect, test } from 'bun:test';

import { prefersPreviewLink, safeHttpUrl } from './safe-url';

describe('safeHttpUrl', () => {
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

describe('prefersPreviewLink', () => {
  test('document URLs are link-only previews', () => {
    expect(prefersPreviewLink('https://x.dev/report.pdf')).toBe(true);
    expect(prefersPreviewLink('https://x.dev/deck.pptx?v=2')).toBe(true);
    expect(prefersPreviewLink('/v1/p/sandbox/3210/sheet.xlsx')).toBe(true);
    expect(prefersPreviewLink('https://x.dev/')).toBe(false);
    expect(prefersPreviewLink(null)).toBe(false);
  });

  test('a relative URL falls back to matching the raw string', () => {
    expect(prefersPreviewLink('/v1/p/sandbox/3210/report.doc#page=2')).toBe(true);
    expect(prefersPreviewLink('/v1/p/sandbox/3210/presentation.pdf/preview')).toBe(false);
  });
});
