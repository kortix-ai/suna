import { describe, expect, test } from 'bun:test';

import { lowercasePublicPath } from '@/lib/path-case-redirect';

const PUBLIC = ['/', '/pricing', '/legal', '/marketplace', '/docs'];
const LOCALES = ['en', 'de', 'ja'];
const lower = (pathname: string) => lowercasePublicPath(pathname, PUBLIC, LOCALES);

// KRTX-3312: paths are case-sensitive, so /Pricing and /DOCS answered 200
// with the "Page not found" page.
describe('lowercasePublicPath', () => {
  test('a public page in another case goes to its lowercase spelling', () => {
    expect(lower('/Pricing')).toBe('/pricing');
    expect(lower('/PRICING')).toBe('/pricing');
    expect(lower('/DOCS')).toBe('/docs');
    expect(lower('/Legal')).toBe('/legal');
  });

  test('a locale prefix in any case is kept, lowercased', () => {
    expect(lower('/de/Pricing')).toBe('/de/pricing');
    expect(lower('/DE/pricing')).toBe('/de/pricing');
    expect(lower('/JA')).toBe('/ja');
  });

  test('a path already in lowercase, or not a public page, is left alone', () => {
    expect(lower('/pricing')).toBeNull();
    expect(lower('/de/pricing')).toBeNull();
    expect(lower('/')).toBeNull();
    // App paths and subpaths can carry case-sensitive ids and names.
    expect(lower('/Projects')).toBeNull();
    expect(lower('/projects/AbC/sessions/XyZ')).toBeNull();
    expect(lower('/marketplace/AcmeCorp/Skill')).toBeNull();
    expect(lower('/Docs/Getting-Started')).toBeNull();
    expect(lower('/XX/Pricing')).toBeNull();
  });
});
