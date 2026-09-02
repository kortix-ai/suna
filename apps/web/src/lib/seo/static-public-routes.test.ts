import { describe, expect, test } from 'bun:test';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { STATIC_PUBLIC_ROUTES } from '@/lib/seo/public-content';

/**
 * `STATIC_PUBLIC_ROUTES` is what `app/sitemap.ts:38` iterates, so every entry
 * is a URL this site tells search engines to crawl. Nothing checked that the
 * page behind one still exists.
 *
 * It cost a real defect. Removing the skills marketplace deleted
 * `app/(public)/(marketing)/marketplace/page.tsx` and left `/marketplace` in
 * this list, so `sitemap.xml` advertised `https://kortix.com/marketplace`
 * while the route answered `404`. The whole suite stayed green: no test maps
 * an advertised path back to a page file.
 *
 * `content-timestamps.json` could not catch it either.
 * `build-content-timestamps.mjs` dates each slug from `git log -1 --format=%cI
 * -- <page.tsx>`, and for a DELETED file git happily returns the commit that
 * deleted it — so the manifest kept emitting a fresh-looking timestamp for a
 * page that was gone. That script's "a slug without a backing page.tsx is
 * skipped" only covers a file that never existed, not one that was removed.
 *
 * Scoped to route EXISTENCE, deliberately, not to the response body or status:
 * this runs without a server. It answers one question — does a file exist that
 * Next.js would route this path to — which is the exact question the 404
 * answered wrongly.
 */
const APP_DIR = join(import.meta.dir, '..', '..', 'app');

/** Every `page` file under `app/`, as the URL path Next.js serves it at. */
function collectRoutes(): Set<string> {
  const routes = new Set<string>();

  const walk = (dir: string, segments: string[]): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        // A parenthesised segment is a route GROUP. It organises files and
        // contributes nothing to the URL, so it does not extend the path.
        const isGroup = entry.startsWith('(') && entry.endsWith(')');
        walk(full, isGroup ? segments : [...segments, entry]);
      } else if (entry === 'page.tsx' || entry === 'page.ts') {
        routes.add(`/${segments.join('/')}`);
      }
    }
  };

  walk(APP_DIR, []);
  return routes;
}

/**
 * An optional catch-all also serves its own parent path: `docs/[[...slug]]`
 * answers `/docs`, not only `/docs/x`. A required catch-all (`[...slug]`) does
 * NOT, which is why the pattern here is the doubled bracket form only.
 */
function isServedBy(routes: Set<string>, pathname: string): boolean {
  if (routes.has(pathname)) return true;
  for (const route of routes) {
    const parent = route.match(/^(.*)\/\[\[\.\.\..+\]\]$/);
    if (parent === null) continue;
    if ((parent[1] === '' ? '/' : parent[1]) === pathname) return true;
  }
  return false;
}

describe('every route in the sitemap has a page behind it', () => {
  const routes = collectRoutes();

  test('the scan found the app router', () => {
    // Guard the guard: a broken walk yields an empty set, and every
    // `isServedBy` call below would then fail for the wrong reason — or, had
    // this been written as a `.not` assertion, pass vacuously.
    expect(routes.size).toBeGreaterThan(20);
    expect(routes.has('/')).toBe(true);
  });

  test('no advertised route resolves to nothing', () => {
    const missing = STATIC_PUBLIC_ROUTES.filter((pathname) => !isServedBy(routes, pathname));
    expect(missing).toEqual([]);
  });
});
