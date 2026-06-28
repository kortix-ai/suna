import { describe, expect, test } from 'bun:test';

import { prefersPreviewLink } from './preview-url-fallback';

describe('prefersPreviewLink', () => {
  test('uses a link-only preview for document urls', () => {
    expect(prefersPreviewLink('https://api.kortix.com/v1/p/sandbox/3210/deck.pdf')).toBe(true);
    expect(prefersPreviewLink('https://api.kortix.com/v1/p/sandbox/3210/deck.pptx?download=1')).toBe(true);
    expect(prefersPreviewLink('/v1/p/sandbox/3210/report.doc#page=2')).toBe(true);
    expect(prefersPreviewLink('/v1/p/sandbox/3210/sheet.xlsx')).toBe(true);
  });

  test('keeps regular web previews in iframes', () => {
    expect(prefersPreviewLink('https://api.kortix.com/v1/p/sandbox/3000/')).toBe(false);
    expect(prefersPreviewLink('https://api.kortix.com/v1/p/sandbox/3000/index.html')).toBe(false);
    expect(prefersPreviewLink('/v1/p/sandbox/3210/presentation.pdf/preview')).toBe(false);
    expect(prefersPreviewLink(null)).toBe(false);
  });
});
