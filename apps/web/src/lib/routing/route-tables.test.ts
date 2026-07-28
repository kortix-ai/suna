import { describe, expect, test } from 'bun:test';

import {
  DESKTOP_ALLOWED_ROUTES,
  PUBLIC_ROUTES,
  isDesktopAllowedRoute,
  isPublicRoute,
  isSelfHostMarketingContent,
  isStaticPublicRoute,
  matchesRoutePrefix,
  supportsMarkdownNegotiation,
} from './route-tables';

describe('matchesRoutePrefix', () => {
  test('matches the route exactly and on a path boundary', () => {
    expect(matchesRoutePrefix('/projects', '/projects')).toBe(true);
    expect(matchesRoutePrefix('/projects/abc', '/projects')).toBe(true);
    expect(matchesRoutePrefix('/projects/abc/sessions/1', '/projects')).toBe(true);
  });

  test('does not match a longer slug that merely starts with the route', () => {
    // The whole point of the `/` boundary: /projects must not gate /projects-x.
    expect(matchesRoutePrefix('/projects-evil', '/projects')).toBe(false);
    expect(matchesRoutePrefix('/pricing', '/')).toBe(false);
  });
});

describe('isDesktopAllowedRoute — the security boundary', () => {
  test('allows the product surfaces', () => {
    for (const route of DESKTOP_ALLOWED_ROUTES) {
      expect(isDesktopAllowedRoute(route)).toBe(true);
      expect(isDesktopAllowedRoute(`${route}/nested/deep`)).toBe(true);
    }
  });

  test('allows sign-in', () => {
    expect(isDesktopAllowedRoute('/auth')).toBe(true);
    expect(isDesktopAllowedRoute('/auth/callback')).toBe(true);
  });

  test('blocks the entire marketing surface', () => {
    for (const path of [
      '/',
      '/pricing',
      '/enterprise',
      '/blog',
      '/blog/some-post',
      '/careers',
      '/contact',
      '/legal',
      '/docs',
      '/docs/cli',
      '/design-system',
      '/about',
      '/changelog',
      '/use-cases',
      '/share/abc',
      '/help',
    ]) {
      expect(isDesktopAllowedRoute(path)).toBe(false);
    }
  });

  test('blocks slugs that merely prefix an allowed route', () => {
    expect(isDesktopAllowedRoute('/projects-marketing')).toBe(false);
    expect(isDesktopAllowedRoute('/adminpanel')).toBe(false);
    expect(isDesktopAllowedRoute('/authors')).toBe(false);
  });

  test('blocks protocol-relative and traversal-shaped paths', () => {
    expect(isDesktopAllowedRoute('//evil.com')).toBe(false);
    expect(isDesktopAllowedRoute('//evil.com/projects')).toBe(false);
    expect(isDesktopAllowedRoute('/../projects')).toBe(false);
  });

  test('is an allowlist — an unknown new slug is blocked by default', () => {
    expect(isDesktopAllowedRoute('/some-new-marketing-page')).toBe(false);
  });
});

describe('isPublicRoute', () => {
  test('the homepage and the marketing pages are public', () => {
    expect(isPublicRoute('/')).toBe(true);
    expect(isPublicRoute('/pricing')).toBe(true);
    expect(isPublicRoute('/docs/cli')).toBe(true);
  });

  test('product surfaces are not public', () => {
    expect(isPublicRoute('/projects')).toBe(false);
    expect(isPublicRoute('/projects/abc')).toBe(false);
    expect(isPublicRoute('/accounts')).toBe(false);
  });

  test('includes locale-prefixed marketing routes for SEO', () => {
    expect(PUBLIC_ROUTES).toContain('/de');
    expect(PUBLIC_ROUTES).toContain('/de/legal');
    expect(isPublicRoute('/de')).toBe(true);
  });
});

describe('isStaticPublicRoute', () => {
  test('covers the visual canvases that must render without Supabase', () => {
    expect(isStaticPublicRoute('/game-of-life')).toBe(true);
    expect(isStaticPublicRoute('/rauch')).toBe(true);
    expect(isStaticPublicRoute('/')).toBe(false);
  });
});

describe('isSelfHostMarketingContent', () => {
  test('covers the homepage and the promo routes', () => {
    expect(isSelfHostMarketingContent('/')).toBe(true);
    expect(isSelfHostMarketingContent('/pricing')).toBe(true);
    expect(isSelfHostMarketingContent('/blog/a-post')).toBe(true);
  });

  test('leaves functional public routes reachable on a self-host', () => {
    for (const path of ['/docs', '/help', '/legal', '/support', '/marketplace', '/share/x']) {
      expect(isSelfHostMarketingContent(path)).toBe(false);
    }
  });
});

describe('supportsMarkdownNegotiation', () => {
  test('covers the fixed set plus docs, blog posts and use-cases', () => {
    expect(supportsMarkdownNegotiation('/')).toBe(true);
    expect(supportsMarkdownNegotiation('/pricing')).toBe(true);
    expect(supportsMarkdownNegotiation('/docs')).toBe(true);
    expect(supportsMarkdownNegotiation('/docs/cli')).toBe(true);
    expect(supportsMarkdownNegotiation('/blog/a-post')).toBe(true);
    expect(supportsMarkdownNegotiation('/use-cases/churn-risk')).toBe(true);
  });

  test('does not cover index pages that are not in the fixed set', () => {
    expect(supportsMarkdownNegotiation('/blog')).toBe(false);
    expect(supportsMarkdownNegotiation('/use-cases')).toBe(false);
    expect(supportsMarkdownNegotiation('/blog/a/b')).toBe(false);
  });
});
