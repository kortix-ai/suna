import { describe, expect, test } from 'bun:test';
import { NextRequest } from 'next/server';
import { readFileSync } from 'node:fs';

import { middleware } from '../middleware';

// The blog is a separate app (kortix-ai/marketing, basePath /blog) served at
// kortix.com/blog. `bun test` cannot execute next.config.ts (see
// security-headers.test.ts), so its rules are pinned on the source.
const nextConfig = readFileSync(new URL('../../next.config.ts', import.meta.url), 'utf8');

describe('/blog is served by the blog app', () => {
  test('next.config rewrites /blog and everything under it to KORTIX_BLOG_ORIGIN', () => {
    expect(nextConfig).toContain("process.env.KORTIX_BLOG_ORIGIN?.replace(/\\/+$/, '')");
    expect(nextConfig).toContain("{ source: '/blog', destination: `${BLOG_ORIGIN}/blog` }");
    expect(nextConfig).toContain(
      "{ source: '/blog/:path*', destination: `${BLOG_ORIGIN}/blog/:path*` }",
    );
  });

  test('the old localized and Markdown blog URLs redirect permanently to /blog', () => {
    expect(nextConfig).toMatch(
      /source: `\/:locale\(\$\{locales\.join\('\|'\)\}\)\/blog`,\s*destination: '\/blog',\s*permanent: true/,
    );
    expect(nextConfig).toMatch(
      /source: `\/:locale\(\$\{locales\.join\('\|'\)\}\)\/blog\/:path\*`,\s*destination: '\/blog\/:path\*',\s*permanent: true/,
    );
    expect(nextConfig).toMatch(
      /source: '\/markdown\/blog\/:slug\.md',\s*destination: '\/blog\/:slug\.md',\s*permanent: true/,
    );
  });

  test('the middleware leaves a Markdown request for a post to the blog app', async () => {
    const response = await middleware(
      new NextRequest(
        new Request('http://localhost:3000/blog/some-post', {
          headers: { accept: 'text/markdown' },
        }),
      ),
    );
    expect(response.headers.get('x-middleware-rewrite')).toBeNull();
  });
});
