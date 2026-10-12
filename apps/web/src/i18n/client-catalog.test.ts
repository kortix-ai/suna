import { afterEach, describe, expect, test } from 'bun:test';
import en from '../../translations/en.json';
import type { MessageTree } from './client-catalog';
import { loadClientCatalog } from './client-catalog';

/**
 * Regression for the dogfood finding `dogfood:acct-delete-second-account:
 * i18n-catalog-en-404-fallback`: on a deployed build the client fetched the
 * hashed public catalog `/i18n/en.<hash>.json` on every page load, and a
 * rolling deploy could 404 it — a wasted round-trip plus a console warning on
 * every load, then a bundled-chunk fallback. The default locale must never
 * make the network round-trip at all: its catalog ships in the same bundle as
 * this loader, so it cannot 404 and cannot mismatch the running server.
 *
 * The fetch stays the primary source for non-default locales (the head
 * preload + immutable CDN cache make it the fastest path), with the bundled
 * chunk as the fallback it already was.
 */

// `importCatalog` guards on `typeof window`, and apps/web registers no DOM
// harness for bun test — a bare window object satisfies the guard.
Object.assign(globalThis, { window: {} });

const fetchCalls: string[] = [];
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  fetchCalls.length = 0;
});

/** Record every catalog URL the loader requests; `status`/`body` is the reply. */
function serve(status: number, body?: unknown): void {
  const reply = async (input: RequestInfo | URL): Promise<Response> => {
    fetchCalls.push(String(input));
    return new Response(status === 200 ? JSON.stringify(body ?? {}) : 'not found', {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  // bun's fetch type carries a preconnect member; the loader never calls it,
  // so the real fetch's preconnect fills the stub.
  globalThis.fetch = Object.assign(reply, { preconnect: realFetch.preconnect });
}

describe('client catalog loading', () => {
  test('the default locale loads from the bundle without any network request', async () => {
    // A 404 on every URL — if the loader still fetched, this test would both
    // record the request and fall back to the bundle instead of failing.
    serve(404);

    const catalog: MessageTree = await loadClientCatalog('en');

    expect(catalog).toEqual(en);
    expect(fetchCalls).toEqual([]);
  });

  test('a non-default locale fetches first and falls back to the bundle on failure', async () => {
    serve(404);

    // Distinct locales keep the module-level cache out of each test's way.
    const catalog = await loadClientCatalog('de');

    expect(catalog).toEqual((await import('../../translations/de.json')).default);
    expect(fetchCalls).toEqual(['/i18n/de.json']);
  });

  test('a non-default locale uses the fetched catalog when the fetch succeeds', async () => {
    const served = { fetched: true };
    serve(200, served);

    const catalog = await loadClientCatalog('it');

    expect(catalog).toEqual(served);
    expect(fetchCalls).toEqual(['/i18n/it.json']);
  });
});
