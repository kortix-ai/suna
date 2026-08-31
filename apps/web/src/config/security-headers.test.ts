import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';

/**
 * JAY: Task 8. No `Strict-Transport-Security` header existed anywhere in
 * `apps/web` — the Supabase session cookie being `Secure`-only (see
 * `lib/supabase/client.ts` / `server.ts` / `middleware.ts`) still leaves a
 * plaintext http:// window open before any redirect-to-HTTPS happens, on any
 * client that has not already been told this origin is HTTPS-only. `bun
 * test` cannot execute `next.config.ts` directly — `nextConfig()` is called
 * eagerly at module load with real side effects (git shell-outs, filesystem
 * copies) and is wrapped in Sentry/Better Stack/MDX/next-intl plugin
 * machinery not meant to run outside `next build`/`next dev` — so this
 * follows `next-output.test.ts`'s established pattern: a source assertion
 * against the raw config text, comments stripped first (this repo's
 * documented trap: a source match can land inside prose that never runs).
 */

const nextConfig = stripComments(
  readFileSync(new URL('../../next.config.ts', import.meta.url), 'utf8'),
);

/** Comments stripped; `//` spared when it is a URL scheme (matches
 *  `sign-out-navigation.test.ts`'s `stripComments`). */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** The executable text between two anchors, both asserted present so a
 *  rename fails this test instead of silently matching an empty slice. */
function slice(source: string, startAnchor: string, endAnchor: string): string {
  const start = source.indexOf(startAnchor);
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf(endAnchor, start + startAnchor.length);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('Strict-Transport-Security header', () => {
  // R18, CONTROLLER RULING (final): a >= 1 year max-age, WITHOUT
  // `includeSubDomains`, and gated to production. `includeSubDomains` pins
  // every `*.kortix.com` subdomain — and, from the prod apex, the whole
  // zone — for the max-age duration, in every visitor's browser, with no
  // server-side undo. That is a DNS-wide infra decision, not a side effect
  // of an auth-cookie fix, so it does not belong in this diff.
  test('is set, with a >= 1 year max-age, and WITHOUT includeSubDomains', () => {
    // Match the literal header assignment, not just the string anywhere in
    // the file (e.g. inside this test's own describe name if it were ever
    // copy-pasted back into next.config.ts).
    const match = nextConfig.match(
      /key:\s*'Strict-Transport-Security',\s*value:\s*'([^']+)'/,
    );
    expect(match).not.toBeNull();
    const value = match?.[1] ?? '';

    const maxAgeMatch = value.match(/max-age=(\d+)/);
    expect(maxAgeMatch).not.toBeNull();
    const maxAge = Number(maxAgeMatch?.[1] ?? 0);
    expect(maxAge).toBeGreaterThanOrEqual(31_536_000); // 1 year, in seconds

    expect(value).not.toContain('includeSubDomains');
  });

  // `headers()` has no per-request environment branch — an entry added here
  // ships IDENTICALLY from local `next dev`, `dev.kortix.com`,
  // `staging.kortix.com`, and prod. `NODE_ENV === 'production'` is the
  // BUILD-time gate (`next build` sets it) that keeps HSTS off local dev and
  // off any HTTP-only self-host, without touching CSP / X-Frame-Options,
  // which stay unconditional for every environment.
  test('is gated to production, unlike CSP / X-Frame-Options which stay unconditional', () => {
    const block = slice(nextConfig, "source: '/:path*',", "source: '/fonts/:path*',");
    const gateIdx = block.indexOf("process.env.NODE_ENV === 'production'");
    expect(gateIdx).toBeGreaterThan(-1);
    const hstsIdx = block.indexOf('Strict-Transport-Security');
    expect(hstsIdx).toBeGreaterThan(gateIdx);

    // CSP / X-Frame-Options are NOT behind that same gate — they come before
    // it in the array, outside the conditional spread.
    const cspIdx = block.indexOf('Content-Security-Policy');
    expect(cspIdx).toBeGreaterThan(-1);
    expect(cspIdx).toBeLessThan(gateIdx);
  });

  test('applies on the same catch-all block as the other security headers, not a narrower route', () => {
    // The '/:path*' headers() entry that already carries CSP / X-Frame-Options
    // is the one every response goes through — HSTS has to live in that same
    // block, not a route-scoped one a future edit could silently narrow.
    const block = slice(nextConfig, "source: '/:path*',", "source: '/fonts/:path*',");
    expect(block).toContain('Content-Security-Policy');
    expect(block).toContain('Strict-Transport-Security');
  });
});
