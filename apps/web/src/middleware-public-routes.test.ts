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
  expect(existsSync(resolve(import.meta.dir, 'app/(app)/review'))).toBe(false);
});

test('token-gated entry points stay public', () => {
  for (const route of ["'/secret-intake'", "'/connect'", "'/share'"]) {
    expect(publicRoutes).toContain(route);
  }
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
    '/blog',
    '/careers',
    '/channels',
    '/changelog',
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
  ];

  for (const route of routes) {
    const localizedPath = `/de${route === '/' ? '' : route}`;
    const response = await middleware(new NextRequest(`http://localhost:3000${localizedPath}`));
    expect(response.headers.get('x-middleware-rewrite')).toBe(`http://localhost:3000${route}`);
    expect(response.headers.get('x-locale')).toBe('de');
    expect(response.headers.get('x-middleware-request-x-locale')).toBe('de');
  }
});
