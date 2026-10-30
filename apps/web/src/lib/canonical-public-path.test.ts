import { describe, expect, test } from 'bun:test';

import { canonicalPublicPath } from '@/lib/canonical-public-path';

const PUBLIC = ['/', '/pricing', '/legal', '/marketplace', '/docs'];
const LOCALES = ['en', 'de', 'ja'];
const canonical = (pathname: string) => canonicalPublicPath(pathname, PUBLIC, LOCALES);

describe('canonicalPublicPath', () => {
  // KRTX-3312: paths are case-sensitive, so /Pricing and /DOCS answered 200
  // with the "Page not found" page.
  test('a public page in another case goes to its lowercase spelling', () => {
    expect(canonical('/Pricing')).toBe('/pricing');
    expect(canonical('/PRICING')).toBe('/pricing');
    expect(canonical('/DOCS')).toBe('/docs');
    expect(canonical('/Legal')).toBe('/legal');
  });

  test('a locale prefix in any case is kept, lowercased', () => {
    expect(canonical('/de/Pricing')).toBe('/de/pricing');
    expect(canonical('/DE/pricing')).toBe('/de/pricing');
    expect(canonical('/JA')).toBe('/ja');
  });

  // KRTX-3234, KRTX-3288: `skipTrailingSlashRedirect` (the /ingest proxy needs
  // it) left /pricing/ a 200 duplicate of /pricing.
  test('a public page with a trailing slash goes to the spelling without it', () => {
    expect(canonical('/pricing/')).toBe('/pricing');
    expect(canonical('/pricing//')).toBe('/pricing');
    expect(canonical('/de/pricing/')).toBe('/de/pricing');
    expect(canonical('/de/')).toBe('/de');
    expect(canonical('/Pricing/')).toBe('/pricing');
  });

  test('a canonical path, or not a public page, is left alone', () => {
    expect(canonical('/pricing')).toBeNull();
    expect(canonical('/de/pricing')).toBeNull();
    expect(canonical('/')).toBeNull();
    expect(canonical('/de')).toBeNull();
    // App paths and subpaths can carry case-sensitive ids and names, and own
    // their slash handling.
    expect(canonical('/Projects')).toBeNull();
    expect(canonical('/projects/')).toBeNull();
    expect(canonical('/projects/AbC/sessions/XyZ')).toBeNull();
    expect(canonical('/marketplace/AcmeCorp/Skill')).toBeNull();
    expect(canonical('/marketplace/acme/')).toBeNull();
    expect(canonical('/Docs/Getting-Started')).toBeNull();
    expect(canonical('/XX/Pricing')).toBeNull();
  });
});
