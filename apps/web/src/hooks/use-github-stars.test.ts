import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fetchGitHubStars } from './use-github-stars';

/**
 * The star count is the only sanctioned number on the marketing site, and two
 * components read it on every page (the navbar chip and the home page's
 * `StarCount`). These tests pin the two properties that matters about it:
 * the page asks for it once, and a failure never prints a made-up figure.
 *
 * bun test has no DOM here (`apps/web/bunfig.toml` preloads no jsdom), so the
 * request layer is exercised directly rather than through a React render.
 */

const realFetch = globalThis.fetch;

function stubFetch(impl: (url: string) => Promise<Response>) {
  let calls = 0;
  globalThis.fetch = ((input: RequestInfo | URL) => {
    calls += 1;
    return impl(String(input));
  }) as typeof fetch;
  return () => calls;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('fetchGitHubStars', () => {
  test('two callers in the same tick share one request', async () => {
    const calls = stubFetch(async () => Response.json({ stars: 20047 }));

    const [a, b] = await Promise.all([fetchGitHubStars(), fetchGitHubStars()]);

    expect(a).toBe(20047);
    expect(b).toBe(20047);
    expect(calls()).toBe(1);
  });

  test('a later caller reuses the resolved value without re-asking', async () => {
    // Continues from the test above: the promise is module-scope, so a mount
    // after the first has settled must not fire a second request.
    const calls = stubFetch(async () => Response.json({ stars: 1 }));

    expect(await fetchGitHubStars()).toBe(20047);
    expect(calls()).toBe(0);
  });
});

describe('fetchGitHubStars — failure', () => {
  test('a non-2xx response resolves to null, never a substituted number', async () => {
    const calls = stubFetch(async () => new Response('rate limited', { status: 503 }));

    // A fresh module instance, so the module-scope promise starts empty
    // instead of replaying the success cached by the block above.
    const fresh = await import(`./use-github-stars?failure=${Date.now()}`);

    expect(await fresh.fetchGitHubStars()).toBeNull();
    expect(calls()).toBe(1);
  });

  test('a failure is not cached — the next caller retries', async () => {
    let attempt = 0;
    const calls = stubFetch(async () => {
      attempt += 1;
      return attempt === 1
        ? new Response('boom', { status: 500 })
        : Response.json({ stars: 20100 });
    });

    const fresh = await import(`./use-github-stars?retry=${Date.now()}`);

    expect(await fresh.fetchGitHubStars()).toBeNull();
    expect(await fresh.fetchGitHubStars()).toBe(20100);
    expect(calls()).toBe(2);
  });

  test('a payload without a numeric `stars` resolves to null', async () => {
    stubFetch(async () => Response.json({ stars: 'lots' }));

    const fresh = await import(`./use-github-stars?payload=${Date.now()}`);

    expect(await fresh.fetchGitHubStars()).toBeNull();
  });
});

describe('use-github-stars source', () => {
  const source = readFileSync(
    fileURLToPath(new URL('./use-github-stars.ts', import.meta.url)),
    'utf8',
  );

  test('carries no hardcoded star count', () => {
    // `setStars(20000)` used to run on every failure, so an outage rendered an
    // invented "20,000" at 72px under "GitHub stars on kortix-ai/suna". Only
    // executable lines are checked — the prose above the code is allowed to
    // name the number it removed.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    expect(code).not.toMatch(/\b20_?000\b/);
  });
});
