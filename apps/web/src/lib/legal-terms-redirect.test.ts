import { describe, expect, test } from 'bun:test';

import { legalShortPathRedirectUrl, legalTermsRedirectUrl } from '@/lib/legal-terms-redirect';

const BASE = 'https://www.kortix.com/legal/terms';

describe('legalTermsRedirectUrl', () => {
  describe('sends /legal/terms to the Terms tab on the same origin', () => {
    const cases: Array<{ pathname: string; legal: string }> = [
      { pathname: '/legal/terms', legal: '/legal' },
      { pathname: '/de/legal/terms', legal: '/de/legal' },
      { pathname: '/zh/legal/terms', legal: '/zh/legal' },
      { pathname: '/pt/legal/terms', legal: '/pt/legal' },
      { pathname: '/es/legal/terms', legal: '/es/legal' },
    ];

    for (const { pathname, legal } of cases) {
      test(pathname, () => {
        const dest = legalTermsRedirectUrl(pathname, new URLSearchParams(), BASE);
        expect(dest).not.toBeNull();
        expect(dest!.origin).toBe('https://www.kortix.com');
        expect(dest!.pathname).toBe(legal);
        expect(dest!.searchParams.get('tab')).toBe('terms');
      });
    }
  });

  describe('does not redirect anything else', () => {
    const passThrough: Array<{ name: string; pathname: string; search: string }> = [
      // The Terms tab renders now; redirecting it would loop.
      { name: 'terms tab', pathname: '/legal', search: '?tab=terms' },
      { name: 'locale terms tab', pathname: '/de/legal', search: '?tab=terms' },
      { name: 'privacy tab', pathname: '/legal', search: '?tab=privacy' },
      { name: 'imprint tab', pathname: '/legal', search: '?tab=imprint' },
      { name: 'no tab', pathname: '/legal', search: '' },
      { name: 'unrelated path', pathname: '/about', search: '' },
      { name: 'root', pathname: '/', search: '' },
      { name: 'legal/privacy', pathname: '/legal/privacy', search: '' },
      { name: 'unsupported locale prefix', pathname: '/xx/legal/terms', search: '' },
    ];

    for (const { name, pathname, search } of passThrough) {
      test(name, () => {
        expect(legalTermsRedirectUrl(pathname, new URLSearchParams(search), BASE)).toBeNull();
      });
    }
  });

  test('keeps unrelated params and forces tab=terms', () => {
    const dest = legalTermsRedirectUrl(
      '/de/legal/terms',
      new URLSearchParams('?utm_source=email&tab=privacy&ref=footer'),
      BASE,
    )!;
    expect(dest.searchParams.get('utm_source')).toBe('email');
    expect(dest.searchParams.get('ref')).toBe('footer');
    expect(dest.searchParams.getAll('tab')).toEqual(['terms']);
  });

  test('never points at an external host', () => {
    const dest = legalTermsRedirectUrl('/legal/terms', new URLSearchParams(), BASE)!;
    expect(dest.host).toBe('www.kortix.com');
    expect(dest.href).not.toContain('drive.google.com');
  });
});

// KRTX-3256: the paths a visitor types for the legal texts answered 200 with
// the "Page not found" page.
describe('legalShortPathRedirectUrl', () => {
  const cases: Array<{ pathname: string; path: string; tab: string | null }> = [
    { pathname: '/terms', path: '/legal', tab: 'terms' },
    { pathname: '/privacy', path: '/legal', tab: 'privacy' },
    { pathname: '/imprint', path: '/legal', tab: 'imprint' },
    { pathname: '/subprocessors', path: '/legal/subprocessors', tab: null },
    { pathname: '/de/privacy', path: '/de/legal', tab: 'privacy' },
    { pathname: '/ja/subprocessors', path: '/ja/legal/subprocessors', tab: null },
  ];

  for (const { pathname, path, tab } of cases) {
    test(`${pathname} goes to ${path}${tab ? `?tab=${tab}` : ''} on the same origin`, () => {
      const dest = legalShortPathRedirectUrl(pathname, new URLSearchParams(), BASE);
      expect(dest).not.toBeNull();
      expect(dest!.origin).toBe('https://www.kortix.com');
      expect(dest!.pathname).toBe(path);
      expect(dest!.searchParams.get('tab')).toBe(tab);
    });
  }

  test('keeps unrelated params and sets the tab', () => {
    const dest = legalShortPathRedirectUrl('/privacy', new URLSearchParams('utm_source=x&tab=terms'), BASE);
    expect(dest!.searchParams.get('utm_source')).toBe('x');
    expect(dest!.searchParams.get('tab')).toBe('privacy');
  });

  test('leaves every other path alone', () => {
    for (const pathname of ['/legal', '/legal/terms', '/status', '/dpa', '/terms/x', '/xx/privacy', '/Privacy', '/']) {
      expect(legalShortPathRedirectUrl(pathname, new URLSearchParams(), BASE), pathname).toBeNull();
    }
  });
});
