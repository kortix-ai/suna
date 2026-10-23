import { expect, test } from 'bun:test';
import { NextRequest } from 'next/server';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { middleware } from './middleware';

const src = readFileSync(resolve(import.meta.dir, 'middleware.ts'), 'utf8');
const legalTermsRedirectSrc = readFileSync(
  resolve(import.meta.dir, 'lib/legal-terms-redirect.ts'),
  'utf8',
);
const publicRoutes = src.slice(
  src.indexOf('const PUBLIC_ROUTES'),
  src.indexOf('];', src.indexOf('const PUBLIC_ROUTES')),
);

test('/review is not public — the Review Center ships flag-gated inside Customize', () => {
  expect(publicRoutes).not.toContain("'/review'");
  expect(existsSync(resolve(import.meta.dir, 'app/[locale]/(app)/review'))).toBe(false);
});

test('token-gated entry points stay public', () => {
  // `/embed` was removed with the public transcript share (KRTX-2358); the
  // session embed is the authenticated session page behind its own CSP rule,
  // never a public route.
  for (const route of ["'/secret-intake'", "'/connect'", "'/share'"]) {
    expect(publicRoutes).toContain(route);
  }
  expect(publicRoutes).not.toContain("'/embed'");
});

test('middleware imports locale constants without bundling translation loaders', () => {
  expect(src).toContain("from '@/i18n/catalog.mjs'");
  expect(src).not.toContain("from '@/i18n/config'");
  expect(legalTermsRedirectSrc).toContain("from '@/i18n/catalog.mjs'");
  expect(legalTermsRedirectSrc).not.toContain("from '@/i18n/config'");
});

test('every supported public surface accepts an explicit locale prefix', async () => {
  const routes = [
    '/',
    '/about',
    '/agent-computer',
    '/agents-and-skills',
    '/automations',
    '/careers',
    '/channels',
    '/changelog',
    '/changelog/releases',
    '/changelog/releases/page/2',
    '/company-as-code',
    '/connectors',
    '/contact',
    '/design-system',
    '/developers',
    '/download',
    '/enterprise',
    '/legal',
    '/marketplace',
    '/pricing',
    '/security',
    '/self-hosted',
    '/solutions',
    '/support',
    '/use-cases',
    '/white-label',
  ];

  for (const route of routes) {
    const localizedPath = `/de${route === '/' ? '' : route}`;
    const response = await middleware(new NextRequest(`http://localhost:3000${localizedPath}`));
    // Pages live under app/[locale]: /de/pricing is already the internal path.
    expect(response.headers.get('x-middleware-rewrite')).toBe(
      `http://localhost:3000${localizedPath}`,
    );
    expect(response.headers.get('x-locale')).toBe('de');
    expect(response.headers.get('x-middleware-request-x-locale')).toBe('de');
  }
});

// KRTX-3234: `skipTrailingSlashRedirect` left /pricing/ a 200 duplicate of
// /pricing. A NextURL clone re-adds the request's trailing slash, so the
// destination is built from a plain URL; otherwise /pricing/ redirects to itself.
test('a public page with a trailing slash redirects to the spelling without it', async () => {
  const cases: Array<[string, string]> = [
    ['/pricing/', 'http://localhost:3000/pricing'],
    ['/de/pricing/?utm_source=x', 'http://localhost:3000/de/pricing?utm_source=x'],
    ['/Pricing/', 'http://localhost:3000/pricing'],
    ['/de/', 'http://localhost:3000/de'],
  ];
  for (const [path, location] of cases) {
    const response = await middleware(new NextRequest(`http://localhost:3000${path}`));
    expect(response.status).toBe(308);
    expect(response.headers.get('location')).toBe(location);
  }
});
