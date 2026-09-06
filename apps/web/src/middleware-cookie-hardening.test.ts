import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { NextRequest } from 'next/server';
import { resolve } from 'node:path';

import { AUTH_BOUNCE_COOKIE } from '@/lib/onboarding/landing-destination';
import { ENVIRONMENT_ACCESS_COOKIE, ENVIRONMENT_PROTECTION_USERNAME } from '@/lib/environment-protection';
import { middleware } from './middleware';

/**
 * JAY: Task 8. Three independent cookie-hardening fixes on the auth surface:
 *
 *  1. The Supabase session cookie, and the auth-bounce cookie, were written
 *     WITHOUT `Secure` on production HTTPS — `@supabase/ssr` never adds it
 *     itself (grepped its installed `dist/`: zero matches for `secure`).
 *  2. `__Secure-kortix_test_access` was the only `Domain`-scoped cookie in
 *     the repo (`.kortix.com`), so dev's middleware wrote a cookie that was
 *     also sent to staging, prod, and api.kortix.com.
 *
 * `kortix_auth_bounce` and `__Secure-kortix_test_access` are both set
 * unconditionally by middleware's own code (no Supabase network call in the
 * path that sets them), so both are driven through the REAL middleware —
 * same pattern as `middleware-auth-bounce.test.ts` ("no Supabase mock"). The
 * three `@supabase/ssr` `cookieOptions.secure` sites cannot be driven this
 * way: the actual `Set-Cookie` only happens deep inside that SDK's own
 * refresh-cookie logic, reachable only against a live Supabase session — so
 * those are covered by a source assertion instead (this file's last
 * `describe`), matching this repo's documented preference (behavioral where
 * possible, source assertion — comments stripped first — where it is not).
 */

const FOREIGN_PROJECT = '/projects/319395c1-9c3f-41b4-ac6c-9539a12dbb7c';

function setCookieFor(response: Response, name: string): string | undefined {
  return response.headers.getSetCookie().find((value) => value.startsWith(`${name}=`));
}

// Next's bundled types declare `NODE_ENV` readonly on `ProcessEnv`. It is
// still an ordinary, writable string at runtime — the same escape hatch
// `middleware.ts` itself uses (`Reflect.get(process.env, ...)`) for other
// dynamically-read vars.
const env = process.env as Record<string, string | undefined>;
const originalNodeEnv = env.NODE_ENV;

afterEach(() => {
  // `process.env` is a single shared object across every file bun test runs
  // in this process (no `--isolate` at HEAD — see the repo's own test
  // isolation notes). Every mutated var is restored exactly, every test,
  // regardless of pass/fail.
  if (originalNodeEnv === undefined) delete env.NODE_ENV;
  else env.NODE_ENV = originalNodeEnv;
  delete env.WEB_PROTECTION_ENABLED;
  delete env.WEB_PROTECTION_PASSWORD;
});

describe('kortix_auth_bounce: Secure on production HTTPS', () => {
  test('carries Secure when NODE_ENV=production', async () => {
    env.NODE_ENV = 'production';
    const request = new NextRequest(new Request(`https://dev.kortix.com${FOREIGN_PROJECT}`));

    const response = await middleware(request);

    const cookie = setCookieFor(response, AUTH_BOUNCE_COOKIE);
    expect(cookie).toBeDefined();
    expect(cookie).toContain('Secure');
  });

  test('control: omits Secure outside production (matches bun test\'s own NODE_ENV=test)', async () => {
    env.NODE_ENV = 'test';
    const request = new NextRequest(new Request(`https://dev.kortix.com${FOREIGN_PROJECT}`));

    const response = await middleware(request);

    const cookie = setCookieFor(response, AUTH_BOUNCE_COOKIE);
    expect(cookie).toBeDefined();
    expect(cookie).not.toContain('Secure');
  });
});

describe('__Secure-kortix_test_access: host-only, no Domain', () => {
  function basicAuthRequest(path: string): NextRequest {
    const credentials = Buffer.from(`${ENVIRONMENT_PROTECTION_USERNAME}:test-protection-pw`).toString(
      'base64',
    );
    return new NextRequest(
      new Request(`https://dev.kortix.com${path}`, {
        headers: { authorization: `Basic ${credentials}` },
      }),
    );
  }

  test('a valid Basic-auth request mints the cookie WITHOUT a Domain attribute', async () => {
    process.env.WEB_PROTECTION_ENABLED = 'true';
    process.env.WEB_PROTECTION_PASSWORD = 'test-protection-pw';

    const response = await middleware(basicAuthRequest('/help'));

    const cookie = setCookieFor(response, ENVIRONMENT_ACCESS_COOKIE);
    expect(cookie).toBeDefined();
    // Host-only: no Domain attribute at all — not even the origin's own host,
    // since RFC 6265 host-only cookies simply omit the attribute.
    expect(cookie?.toLowerCase()).not.toContain('domain=');
    // Every other attribute this cookie is supposed to carry stays intact —
    // this proves the fix removed exactly `Domain`, not the whole options
    // object.
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie?.toLowerCase()).toContain('samesite=lax');
  });
});

describe('the three @supabase/ssr cookieOptions sites set `secure`', () => {
  // Cannot be driven behaviorally (see file doc comment) — `@supabase/ssr`
  // only writes this cookie from inside its own token-refresh logic, which
  // needs a live Supabase session. Source assertion instead, comments
  // stripped first (this repo's documented trap: a match inside a comment
  // passes against text that never runs).
  // Line comments FIRST, then block comments — the reverse of the pattern
  // this repo otherwise uses (e.g. `sign-out-navigation.test.ts`). Reversed
  // deliberately: `middleware.ts` has plain `//` comments mentioning path
  // globs like `/auth/*` and `/settings/*` — read as `/* */`-first, THAT
  // literal `/*` is misread as a block-comment open with no close on the
  // same line, so the non-greedy `[\s\S]*?\*\/` swallows everything up to
  // the FAR-AWAY next real `*/` (the matcher config's JSDoc block),
  // including `cookieOptions:` in between. A block comment's interior is
  // discarded either way, so stripping line comments first changes nothing
  // about what a real block comment's content resolves to.
  function stripComments(source: string): string {
    return source.replace(/(^|[^:])\/\/.*$/gm, '$1').replace(/\/\*[\s\S]*?\*\//g, '');
  }

  function cookieOptionsBlocks(file: string): string[] {
    const source = stripComments(readFileSync(resolve(import.meta.dir, file), 'utf8'));
    const blocks: string[] = [];
    let from = 0;
    for (;;) {
      const start = source.indexOf('cookieOptions:', from);
      if (start < 0) break;
      const end = source.indexOf('}', source.indexOf('{', start));
      expect(end).toBeGreaterThan(start);
      blocks.push(source.slice(start, end + 1));
      from = end + 1;
    }
    return blocks;
  }

  test('lib/supabase/client.ts: both createBrowserClient() cookieOptions blocks set secure', () => {
    const blocks = cookieOptionsBlocks('lib/supabase/client.ts');
    expect(blocks.length).toBe(2);
    for (const block of blocks) {
      expect(block).toContain('secure');
    }
  });

  test('lib/supabase/server.ts: the createServerClient() cookieOptions block sets secure', () => {
    const blocks = cookieOptionsBlocks('lib/supabase/server.ts');
    expect(blocks.length).toBe(1);
    expect(blocks[0]).toContain('secure');
  });

  test('middleware.ts: the createServerClient() cookieOptions block sets secure', () => {
    const blocks = cookieOptionsBlocks('middleware.ts');
    expect(blocks.length).toBe(1);
    expect(blocks[0]).toContain('secure');
  });
});
