import { describe, expect, test } from 'bun:test';

import { LEGAL_TERMS_DRIVE_BASE, legalTermsRedirectUrl } from '@/lib/legal-terms-redirect';

describe('legalTermsRedirectUrl', () => {
  describe('redirects Terms requests to the Drive folder', () => {
    const termsCases: Array<{ name: string; pathname: string; search: string }> = [
      { name: 'stable /legal/terms', pathname: '/legal/terms', search: '' },
      { name: 'stable /legal/terms with usp=sharing', pathname: '/legal/terms', search: '?usp=sharing' },
      { name: 'stable /legal/terms with foreign usp', pathname: '/legal/terms', search: '?usp=drive' },
      { name: 'legacy /legal?tab=terms', pathname: '/legal', search: '?tab=terms' },
      { name: 'locale /de/legal/terms', pathname: '/de/legal/terms', search: '' },
      { name: 'locale /it/legal?tab=terms', pathname: '/it/legal', search: '?tab=terms' },
      { name: 'locale /zh/legal/terms', pathname: '/zh/legal/terms', search: '' },
      { name: 'locale /ja/legal?tab=terms', pathname: '/ja/legal', search: '?tab=terms' },
      { name: 'locale /pt/legal/terms', pathname: '/pt/legal/terms', search: '' },
      { name: 'locale /fr/legal?tab=terms', pathname: '/fr/legal', search: '?tab=terms' },
      { name: 'locale /es/legal/terms', pathname: '/es/legal/terms', search: '' },
      { name: 'locale /en/legal?tab=terms', pathname: '/en/legal', search: '?tab=terms' },
    ];

    for (const { name, pathname, search } of termsCases) {
      test(name, () => {
        const params = new URLSearchParams(search);
        const dest = legalTermsRedirectUrl(pathname, params);
        expect(dest).not.toBeNull();
        expect(dest!.origin).toBe('https://drive.google.com');
        expect(dest!.pathname).toBe('/drive/folders/1UZuRrBGhzACGBgi2J47BS-I6VMNnqIHN');
        // usp=sharing is always present and never overridden.
        expect(dest!.searchParams.get('usp')).toBe('sharing');
      });
    }
  });

  describe('does not redirect non-Terms requests', () => {
    const passThroughCases: Array<{ name: string; pathname: string; search: string }> = [
      { name: 'privacy tab', pathname: '/legal', search: '?tab=privacy' },
      { name: 'imprint tab', pathname: '/legal', search: '?tab=imprint' },
      { name: 'no tab defaults to imprint page', pathname: '/legal', search: '' },
      { name: 'locale privacy', pathname: '/de/legal', search: '?tab=privacy' },
      { name: 'locale imprint', pathname: '/de/legal', search: '?tab=imprint' },
      { name: 'unrelated path', pathname: '/about', search: '' },
      { name: 'root', pathname: '/', search: '' },
      { name: 'legal/terms is not privacy', pathname: '/legal/privacy', search: '' },
      { name: 'unsupported locale prefix', pathname: '/xx/legal/terms', search: '' },
    ];

    for (const { name, pathname, search } of passThroughCases) {
      test(name, () => {
        const params = new URLSearchParams(search);
        expect(legalTermsRedirectUrl(pathname, params)).toBeNull();
      });
    }
  });

  describe('query param handling', () => {
    test('removes the tab param from the destination', () => {
      const dest = legalTermsRedirectUrl('/legal', new URLSearchParams('?tab=terms'))!;
      expect(dest.searchParams.has('tab')).toBe(false);
    });

    test('does not let an incoming usp override usp=sharing', () => {
      for (const incoming of ['sharing', 'drive', 'embed', 'anything']) {
        const dest = legalTermsRedirectUrl(
          '/legal/terms',
          new URLSearchParams(`?usp=${incoming}`),
        )!;
        expect(dest.searchParams.get('usp')).toBe('sharing');
      }
    });

    test('always sets usp=sharing even when absent on the inbound request', () => {
      const dest = legalTermsRedirectUrl('/legal/terms', new URLSearchParams(''))!;
      expect(dest.searchParams.get('usp')).toBe('sharing');
    });

    test('preserves unrelated query params', () => {
      const dest = legalTermsRedirectUrl(
        '/legal',
        new URLSearchParams('?tab=terms&ref=footer&campaign=launch'),
      )!;
      expect(dest.searchParams.get('ref')).toBe('footer');
      expect(dest.searchParams.get('campaign')).toBe('launch');
      expect(dest.searchParams.has('tab')).toBe(false);
      expect(dest.searchParams.get('usp')).toBe('sharing');
    });

    test('preserves unrelated params and forces usp=sharing together', () => {
      const dest = legalTermsRedirectUrl(
        '/de/legal/terms',
        new URLSearchParams('?usp=drive&utm_source=email&tab=terms'),
      )!;
      expect(dest.searchParams.get('utm_source')).toBe('email');
      expect(dest.searchParams.get('usp')).toBe('sharing');
      expect(dest.searchParams.has('tab')).toBe(false);
    });

    test('produces a stable, sorted param order on the destination', () => {
      const a = legalTermsRedirectUrl(
        '/legal',
        new URLSearchParams('?tab=terms&z=1&a=2'),
      )!;
      const b = legalTermsRedirectUrl(
        '/legal',
        new URLSearchParams('?a=2&z=1&tab=terms'),
      )!;
      expect(a.searchParams.toString()).toBe(b.searchParams.toString());
      // sorted: a, usp, z
      expect(a.searchParams.toString()).toBe('a=2&usp=sharing&z=1');
    });
  });

  test('exposes the canonical Drive base URL', () => {
    expect(LEGAL_TERMS_DRIVE_BASE).toBe(
      'https://drive.google.com/drive/folders/1UZuRrBGhzACGBgi2J47BS-I6VMNnqIHN',
    );
  });
});
