import { describe, expect, test } from 'bun:test';

import {
  MARKDOWN_ROUTE_PATHS,
  markdownRouteFor,
  prefersMarkdown,
} from './markdown-negotiation';

describe('prefersMarkdown', () => {
  test('a bare markdown request wants markdown', () => {
    expect(prefersMarkdown('text/markdown')).toBe(true);
  });

  test('an explicit q-value preference wants markdown', () => {
    expect(prefersMarkdown('text/markdown;q=1.0, text/html;q=0.8')).toBe(true);
  });

  test('a real browser Accept header still gets HTML', () => {
    expect(
      prefersMarkdown(
        'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      ),
    ).toBe(false);
  });

  test('markdown ranked below html gets HTML', () => {
    expect(prefersMarkdown('text/html, text/markdown;q=0.5')).toBe(false);
  });

  test('curl default */* gets HTML, because HTML is the default representation', () => {
    expect(prefersMarkdown('*/*')).toBe(false);
  });

  test('text/* does not tip the balance either way, so HTML wins', () => {
    expect(prefersMarkdown('text/*')).toBe(false);
  });

  test('a missing or empty header gets HTML', () => {
    expect(prefersMarkdown(null)).toBe(false);
    expect(prefersMarkdown(undefined)).toBe(false);
    expect(prefersMarkdown('')).toBe(false);
  });

  test('q=0 on markdown is a refusal, not a preference', () => {
    expect(prefersMarkdown('text/markdown;q=0, text/html;q=0')).toBe(false);
  });

  test('whitespace and casing are tolerated', () => {
    expect(prefersMarkdown('  TEXT/MARKDOWN ;  q=0.9 , text/html;q=0.1')).toBe(true);
  });
});

describe('markdownRouteFor', () => {
  test('resolves a known public page', () => {
    expect(markdownRouteFor('/pricing')).toBe('/markdown/pricing.md');
  });

  test('resolves the homepage', () => {
    expect(markdownRouteFor('/')).toBe('/markdown/index.md');
  });

  test('an unknown path has no markdown twin', () => {
    expect(markdownRouteFor('/projects/abc123')).toBeUndefined();
  });

  test('never resolves an authenticated route', () => {
    expect(markdownRouteFor('/dashboard')).toBeUndefined();
    expect(markdownRouteFor('/settings')).toBeUndefined();
  });

  test('the exported path list matches the map keys', () => {
    expect(MARKDOWN_ROUTE_PATHS).toContain('/pricing');
    expect(MARKDOWN_ROUTE_PATHS.every((path) => path.startsWith('/'))).toBe(true);
  });
});
