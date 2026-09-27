import { describe, expect, test } from 'bun:test';
import { NextRequest } from 'next/server';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { isNonPagePath } from '@/i18n/routing';
import { KORTIX_SUPABASE_AUTH_COOKIE } from '@/lib/supabase/constants';
import { config, middleware } from './middleware';

const ORIGIN = 'http://localhost:3000';

function request(path: string, cookie?: string): NextRequest {
  const req = new NextRequest(new Request(`${ORIGIN}${path}`));
  if (cookie) req.cookies.set(KORTIX_SUPABASE_AUTH_COOKIE, cookie);
  return req;
}

const GERMAN_SESSION = `base64-${Buffer.from(
  JSON.stringify({ user: { user_metadata: { locale: 'de' } } }),
).toString('base64url')}`;

describe('locale rewrite onto app/[locale]', () => {
  test('unprefixed public pages render in English', async () => {
    for (const path of ['/pricing', '/blog/some-post', '/legal', '/auth', '/game-of-life']) {
      const response = await middleware(request(path));
      expect(response.headers.get('x-middleware-rewrite')).toBe(`${ORIGIN}/en${path}`);
      expect(response.headers.get('x-middleware-request-x-next-intl-locale')).toBe('en');
    }
  });

  test('the homepage rewrites to /en and keeps the agent discovery Link header', async () => {
    const response = await middleware(request('/'));
    expect(response.headers.get('x-middleware-rewrite')).toBe(`${ORIGIN}/en`);
    expect(response.headers.get('link')).toContain('rel="api-catalog"');
  });

  test('a profile locale in the session cookie picks the static page variant', async () => {
    const response = await middleware(request('/pricing', GERMAN_SESSION));
    expect(response.headers.get('x-middleware-rewrite')).toBe(`${ORIGIN}/de/pricing`);
  });

  test('an explicit prefix wins over the cookie', async () => {
    const response = await middleware(request('/fr/pricing', GERMAN_SESSION));
    expect(response.headers.get('x-middleware-rewrite')).toBe(`${ORIGIN}/fr/pricing`);
  });

  test('public marketing pages do not touch the session: no Set-Cookie on a stale cookie', async () => {
    const response = await middleware(request('/pricing', 'base64-not-a-session'));
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(response.headers.get('x-middleware-rewrite')).toBe(`${ORIGIN}/en/pricing`);
  });

  test('protected routes still bounce an anonymous visitor to /auth', async () => {
    for (const path of ['/projects', '/projects/abc/sessions/def', '/settings']) {
      const response = await middleware(request(path));
      expect(response.status).toBe(307);
      expect(response.headers.get('location')).toBe(
        `${ORIGIN}/auth?redirect=${encodeURIComponent(path)}`,
      );
    }
  });

  test('a locale prefix on a non-localized route still renders not-found', async () => {
    // `/de` is public, so `/de/projects` never bounced; it rendered the 404.
    const response = await middleware(request('/de/projects'));
    expect(response.headers.get('x-middleware-rewrite')).toBe(`${ORIGIN}/en/de/projects`);
  });

  test('non-page paths pass through without a locale', async () => {
    for (const path of [
      '/mcp',
      '/install',
      '/download/macos',
      '/auth/callback',
      '/scim/v2/Users',
    ]) {
      const response = await middleware(request(path));
      expect(response.headers.get('x-middleware-rewrite')).toBeNull();
    }
  });
});

describe('matcher', () => {
  const matcher = new RegExp(`^${config.matcher[0]}$`);

  test('skips docs and public static assets', () => {
    for (const path of [
      '/docs',
      '/docs/quickstart',
      '/pdfium.wasm',
      '/emojibase/en/data.json',
      '/fonts/roobert.woff2',
      '/manifest.json',
      '/scripts/x.js',
      '/styles/x.css',
      '/videos/demo.mp4',
    ]) {
      expect(matcher.test(path)).toBe(false);
    }
  });

  test('still runs for pages and text Route Handlers', () => {
    for (const path of [
      '/',
      '/pricing',
      '/de/pricing',
      '/projects/abc',
      '/robots.txt',
      '/llms.txt',
    ]) {
      expect(matcher.test(path)).toBe(true);
    }
  });
});

describe('Route Handler coverage', () => {
  // A Route Handler outside app/[locale] that the middleware rewrote onto a
  // locale would 404. Every one must be classified as a non-page path.
  const appDir = join(import.meta.dir, 'app');

  function routeHandlers(dir: string): string[] {
    const found: string[] = [];
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (entry === '[locale]') continue;
        found.push(...routeHandlers(full));
      } else if (/^route\.tsx?$/.test(entry)) {
        found.push(relative(appDir, dir));
      }
    }
    return found;
  }

  test('every top-level Route Handler path is a non-page path', () => {
    const handlers = routeHandlers(appDir);
    expect(handlers.length).toBeGreaterThan(20);
    for (const dir of handlers) {
      const urlPath =
        '/' +
        dir
          .split(sep)
          .filter((segment) => !/^\(.*\)$/.test(segment))
          .map((segment) => segment.replace(/^\[\.\.\.(.+)\]$/, 'a/b').replace(/^\[(.+)\]$/, 'x'))
          .join('/');
      expect({ urlPath, nonPage: isNonPagePath(urlPath) }).toEqual({ urlPath, nonPage: true });
    }
  });
});

describe('docs Markdown negotiation without the middleware', () => {
  // /docs skips the middleware (matcher). next.config.ts negotiates its
  // Markdown with a beforeFiles rewrite on the Accept header instead.
  const source = readFileSync(join(import.meta.dir, '..', 'next.config.ts'), 'utf8');

  test('the Accept matcher selects explicit Markdown requests only', () => {
    const value = source.match(/key: 'accept', value: '([^']+)'/)?.[1]?.replace(/\\\\/g, '\\');
    expect(value).toBeDefined();
    // Next matches `has` values as ^value$.
    const accept = new RegExp(`^${value}$`);
    expect(accept.test('text/markdown')).toBe(true);
    expect(accept.test('text/html;q=0.9, text/markdown')).toBe(true);
    expect(accept.test('text/html,application/xhtml+xml,*/*;q=0.8')).toBe(false);
  });

  test('the rewrite targets resolve to the docs Markdown records', async () => {
    const { resolvePublicMarkdown, getPublicContentRecords } =
      await import('@/lib/seo/public-content');
    expect(source).toContain("destination: '/markdown/docs/index.md'");
    expect(source).toContain("destination: '/markdown/docs/:path*.md'");
    const docs = getPublicContentRecords().filter((record) => record.htmlPath.startsWith('/docs'));
    expect(docs.length).toBeGreaterThan(5);
    for (const record of docs.slice(0, 20)) {
      const target =
        record.htmlPath === '/docs'
          ? '/markdown/docs/index.md'
          : `/markdown/docs/${record.htmlPath.slice('/docs/'.length)}.md`;
      expect(target).toBe(record.markdownPath);
      expect(resolvePublicMarkdown(target.replace(/^\/markdown\//, '').split('/'))).toBeTruthy();
    }
  });
});
